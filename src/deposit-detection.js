import path from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import { createWorker } from "tesseract.js";

const require = createRequire(import.meta.url);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const OCR_TIMEOUT_MS = 25_000;
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp", "gif", "tiff", "bmp"]);
const englishDataDirectory = path.join(
  path.dirname(require.resolve("@tesseract.js-data/eng")),
  "4.0.0_best_int",
);

/**
 * Diagnostic status codes for receipt OCR analysis.
 */
export const OCR_STATUS = {
  OK: "OK",
  OCR_FAILED: "OCR_FAILED",
  OCR_TIMEOUT: "OCR_TIMEOUT",
  RECIPIENT_NOT_FOUND: "RECIPIENT_NOT_FOUND",
  AMOUNT_NOT_FOUND: "AMOUNT_NOT_FOUND",
  PAYMENT_CONFIRMATION_NOT_FOUND: "PAYMENT_CONFIRMATION_NOT_FOUND",
  EMPTY_IMAGE: "EMPTY_IMAGE",
  INVALID_INPUT: "INVALID_INPUT",
  IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",
  UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT",
  IMAGE_DIMENSIONS: "IMAGE_DIMENSIONS",
};

/**
 * Read an Emergency Hamburg / PTB transfer confirmation locally using Sharp and Tesseract.js.
 *
 * @param {Buffer|Uint8Array} imageBuffer Image bytes (max 8 MiB).
 * @returns {Promise<{
 *   status: "ok"|"partial"|"unreadable"|"error",
 *   fields: {
 *     recipient: string|null,
 *     amount: number|null,
 *     currency: string|null,
 *     formattedAmount: string|null,
 *   },
 *   ocr: {text: string, confidence: number|null, confidenceUnit: "percent"|null},
 *   diagnostics: {
 *     status: string,
 *     rawText: string,
 *     region: "blue_panel"|"bottom_left_crop"|"full_image"|"none",
 *     failureReason: string|null,
 *   },
 *   error: {code: string, message: string}|null
 * }>}
 */
export async function analyzeReceipt(imageBuffer) {
  const emptyFields = { recipient: null, amount: null, currency: null, formattedAmount: null };
  if (!(Buffer.isBuffer(imageBuffer) || imageBuffer instanceof Uint8Array)) {
    return makeResult("error", emptyFields, "", null, "none", OCR_STATUS.INVALID_INPUT, "Expected image bytes as a Buffer or Uint8Array.", "INVALID_INPUT");
  }
  if (imageBuffer.byteLength === 0) {
    return makeResult("error", emptyFields, "", null, "none", OCR_STATUS.EMPTY_IMAGE, "The uploaded image is empty.", "EMPTY_IMAGE");
  }
  if (imageBuffer.byteLength > MAX_IMAGE_BYTES) {
    return makeResult("error", emptyFields, "", null, "none", OCR_STATUS.IMAGE_TOO_LARGE, `Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB limit.`, "IMAGE_TOO_LARGE");
  }

  let worker;
  let timeout;
  try {
    const input = Buffer.from(imageBuffer);
    const metadata = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false }).metadata();
    if (!ALLOWED_FORMATS.has(metadata.format)) {
      return makeResult("error", emptyFields, "", null, "none", OCR_STATUS.UNSUPPORTED_FORMAT, "Supported image formats are JPEG, PNG, WebP, GIF, TIFF, and BMP.", "UNSUPPORTED_FORMAT");
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) {
      return makeResult("error", emptyFields, "", null, "none", OCR_STATUS.IMAGE_DIMENSIONS, "Image dimensions are invalid or exceed the megapixel limit.", "IMAGE_DIMENSIONS");
    }

    // Identify region:
    // 1. Detect Emergency Hamburg blue modal panel.
    // 2. If wide aspect ratio in-game screenshot and no distinct panel found, target the bottom-left smartphone quadrant.
    // 3. Otherwise, use full image (already cropped screenshot).
    let regionType = "full_image";
    let extractRegion = await findBlueConfirmationPanel(input, metadata);
    if (extractRegion) {
      regionType = "blue_panel";
    } else {
      const isWidescreen = metadata.width >= 800 && (metadata.width / metadata.height) >= 1.25;
      if (isWidescreen) {
        extractRegion = {
          left: 0,
          top: Math.round(metadata.height * 0.35),
          width: Math.round(metadata.width * 0.42),
          height: Math.round(metadata.height * 0.65),
        };
        regionType = "bottom_left_crop";
      }
    }

    let pipeline = sharp(input, { limitInputPixels: MAX_PIXELS, animated: false }).rotate();
    if (extractRegion) {
      pipeline = pipeline.extract(extractRegion);
    }

    // Scale appropriately for OCR (~1200-1800px width for optimal character resolution)
    const targetWidth = extractRegion
      ? Math.max(1000, Math.min(2200, Math.round(extractRegion.width * 2.5)))
      : Math.max(1000, Math.min(2400, Math.round(metadata.width * 1.5)));

    // Contrast thresholding: turns white text on blue/dark background into crisp high-contrast binary
    const preparedImage = await pipeline
      .resize({ width: targetWidth, withoutEnlargement: false })
      .grayscale()
      .threshold(135)
      .png()
      .toBuffer();

    const workerPromise = createWorker("eng", 1, {
      langPath: englishDataDirectory,
      gzip: true,
      cacheMethod: "none",
      logger: () => {},
      errorHandler: () => {},
    });
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Object.assign(new Error("OCR exceeded the processing time limit."), { code: "OCR_TIMEOUT" })), OCR_TIMEOUT_MS);
      timeout.unref?.();
    });

    worker = await Promise.race([workerPromise, timeoutPromise]);
    await worker.setParameters({ tessedit_pageseg_mode: "6" });
    let { data } = await Promise.race([worker.recognize(preparedImage), timeoutPromise]);

    let text = String(data?.text ?? "").trim();
    // If PSM 6 produced minimal output, attempt sparse text mode (PSM 11)
    if (text.length < 5) {
      await worker.setParameters({ tessedit_pageseg_mode: "11" });
      const sparseResult = await Promise.race([worker.recognize(preparedImage), timeoutPromise]);
      const sparseText = String(sparseResult.data?.text ?? "").trim();
      if (sparseText.length > text.length) {
        text = sparseText;
        data = sparseResult.data;
      }
    }

    const confidence = Number.isFinite(data?.confidence) ? Math.round(data.confidence * 10) / 10 : null;
    const parsed = extractDepositConfirmation(text);

    return makeResult(
      parsed.status,
      parsed.fields,
      text,
      confidence,
      regionType,
      parsed.diagnosticsStatus,
      parsed.failureReason,
      null,
    );
  } catch (error) {
    const code = error?.code === "OCR_TIMEOUT" ? "OCR_TIMEOUT" : "OCR_FAILED";
    return makeResult("error", emptyFields, "", null, "none", code, String(error?.message ?? error).slice(0, 300), code);
  } finally {
    clearTimeout(timeout);
    if (worker) await worker.terminate().catch(() => {});
  }
}

/**
 * Extract recipient and amount deterministically from OCR text.
 * Never guesses or fabricates missing values.
 *
 * @param {string} ocrText
 * @returns {{
 *   status: "ok"|"partial"|"unreadable",
 *   fields: {recipient: string|null, amount: number|null, currency: string|null, formattedAmount: string|null},
 *   diagnosticsStatus: string,
 *   failureReason: string|null,
 * }}
 */
export function extractDepositConfirmation(ocrText) {
  const normalized = String(ocrText ?? "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return {
      status: "unreadable",
      fields: { recipient: null, amount: null, currency: null, formattedAmount: null },
      diagnosticsStatus: OCR_STATUS.OCR_FAILED,
      failureReason: "OCR returned empty text from screenshot.",
    };
  }

  // Emergency Hamburg payment modal:
  // "Successfully sent 8,000 € to Chickenwings" / "Successfully sent 8,000 € to L4RRY"
  // Variations: "sent 8,000 € to ...", "transferred 8,000 € to ...", "paid 8,000 € to ..."
  const recipientPattern = String.raw`(?:IRP\s+Treasury|treasury|[A-Za-z0-9_.-]+)`;
  const ehStandard = new RegExp(
    String.raw`\b(?:(?:success(?:ful(?:ly|y|li)?|tly)?\s+)?(?:sent|transferred|paid)\s+)(?:[$€£]\s*)?([0-9]+(?:[., ][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+)\s*(?:[$€£©¢]|EUR|euro|euros|[eEcC])?\s+(?:to|To)\s+(${recipientPattern})`,
    "iu",
  );
  const ehReversed = new RegExp(
    String.raw`\b(?:(?:success(?:ful(?:ly|y|li)?|tly)?\s+)?(?:sent|transferred|paid)\s+(?:to|To)\s+(${recipientPattern}))\s+(?:[$€£]\s*)?([0-9]+(?:[., ][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+)\s*(?:[$€£©¢]|EUR|euro|euros|[eEcC])?`,
    "iu",
  );

  // Labeled ticket / treasury receipts:
  // "Amount paid: 500 USD \n Recipient: IRP Treasury"
  const labeledAmount = /(?:amount(?:\s+paid)?|total|paid)\s*[:#-]?\s*(?:[$€£]\s*)?([0-9]+(?:[., ][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+)\s*(?:[$€£©¢]|USD|EUR|euro|euros|[eEcC])?/i;
  const labeledRecipient = new RegExp(
    String.raw`(?:recipient|receiver|beneficiary|paid\s+to|sent\s+to)\s*[:#-]?\s*(${recipientPattern})`,
    "iu",
  );

  let rawAmount = null;
  let rawRecipient = null;

  const matchEh = normalized.match(ehStandard);
  if (matchEh) {
    rawAmount = matchEh[1];
    rawRecipient = matchEh[2];
  } else {
    const matchRev = normalized.match(ehReversed);
    if (matchRev) {
      rawRecipient = matchRev[1];
      rawAmount = matchRev[2];
    } else {
      const matchAmt = normalized.match(labeledAmount);
      const matchRec = normalized.match(labeledRecipient);
      if (matchAmt) rawAmount = matchAmt[1];
      if (matchRec) rawRecipient = matchRec[1];
    }
  }

  // Fallback if one part was missing from strict sentence
  if (!rawAmount) {
    const partialAmt = normalized.match(/\b(?:sent|transferred|paid)\s+(?:[$€£]\s*)?([0-9]+(?:[., ][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+)/i);
    if (partialAmt) rawAmount = partialAmt[1];
  }
  if (!rawRecipient) {
    const partialRec = normalized.match(new RegExp(String.raw`\b(?:to|To)\s+(${recipientPattern})`, "iu"));
    if (partialRec) rawRecipient = partialRec[1];
  }

  // Parse amount strictly into a safe positive integer
  let parsedAmount = null;
  let formattedAmount = null;
  if (rawAmount) {
    const cleanNum = rawAmount.replace(/[.,\s]/g, "");
    if (/^\d+$/.test(cleanNum)) {
      const num = parseInt(cleanNum, 10);
      if (Number.isSafeInteger(num) && num > 0) {
        parsedAmount = num;
        formattedAmount = `${num.toLocaleString()} €`;
      }
    }
  }

  // Clean and sanitize recipient username
  let parsedRecipient = null;
  if (rawRecipient) {
    let cleaned = rawRecipient.replace(/[.!?,;:]+$/, "").trim();
    if (/^irp\s*treasury$/i.test(cleaned) || /^treasury$/i.test(cleaned)) {
      parsedRecipient = "IRP Treasury";
    } else if (cleaned.length >= 2) {
      parsedRecipient = cleaned;
    }
  }

  const hasPaymentKeyword = /\b(?:success(?:ful(?:ly)?)?|sent|transferred|paid|payment|amount|receipt|total)\b/i.test(normalized);

  let status = "unreadable";
  let diagnosticsStatus = OCR_STATUS.PAYMENT_CONFIRMATION_NOT_FOUND;
  let failureReason = null;

  if (parsedAmount !== null && parsedRecipient !== null) {
    status = "ok";
    diagnosticsStatus = OCR_STATUS.OK;
  } else if (parsedAmount !== null || parsedRecipient !== null) {
    status = "partial";
    if (parsedAmount === null) {
      diagnosticsStatus = OCR_STATUS.AMOUNT_NOT_FOUND;
      failureReason = "Could not extract payment amount from confirmation text.";
    } else {
      diagnosticsStatus = OCR_STATUS.RECIPIENT_NOT_FOUND;
      failureReason = "Could not extract recipient name from confirmation text.";
    }
  } else if (!hasPaymentKeyword) {
    status = "unreadable";
    diagnosticsStatus = OCR_STATUS.PAYMENT_CONFIRMATION_NOT_FOUND;
    failureReason = "No payment confirmation wording found in OCR text.";
  } else {
    status = "unreadable";
    diagnosticsStatus = OCR_STATUS.OCR_FAILED;
    failureReason = "Payment keywords detected but failed to parse amount or recipient.";
  }

  return {
    status,
    fields: {
      recipient: parsedRecipient,
      amount: parsedAmount,
      currency: parsedAmount !== null ? "EUR" : null,
      formattedAmount,
    },
    diagnosticsStatus,
    failureReason,
  };
}

/**
 * Locate the Emergency Hamburg blue modal panel.
 */
async function findBlueConfirmationPanel(input, metadata) {
  try {
    const preview = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false })
      .rotate()
      .resize({ width: 600, height: 600, fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = preview;
    const rows = new Uint32Array(info.height);
    const columns = new Uint32Array(info.width);

    // Emergency Hamburg blue modal:
    // White text on medium saturated blue background (#206694, #1d5c85, #134668 at night).
    // Blue is distinctly dominant over Red and Green.
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        if (b >= 60 && b <= 245 && b > r + 30 && b > g + 12 && r <= 130 && g <= 175) {
          rows[y] += 1;
          columns[x] += 1;
        }
      }
    }

    const rowCutoff = Math.max(6, Math.round(info.width * 0.03));
    const colCutoff = Math.max(6, Math.round(info.height * 0.02));

    const rowIndexes = [];
    for (let i = 0; i < info.height; i += 1) {
      if (rows[i] > rowCutoff) rowIndexes.push(i);
    }
    const colIndexes = [];
    for (let i = 0; i < info.width; i += 1) {
      if (columns[i] > colCutoff) colIndexes.push(i);
    }

    if (rowIndexes.length < 5 || colIndexes.length < 5) return null;

    const scaleX = info.width / metadata.width;
    const scaleY = info.height / metadata.height;
    const leftEdge = Math.floor(colIndexes[0] / scaleX);
    const rightEdge = Math.ceil(colIndexes.at(-1) / scaleX);
    const topEdge = Math.floor(rowIndexes[0] / scaleY);
    const bottomEdge = Math.ceil(rowIndexes.at(-1) / scaleY);

    const panelWidth = rightEdge - leftEdge + 1;
    const panelHeight = bottomEdge - topEdge + 1;
    const xPadding = Math.max(4, Math.round(panelWidth * 0.02));
    const yPadding = Math.max(4, Math.round(panelHeight * 0.03));

    const left = Math.max(0, leftEdge - xPadding);
    const top = Math.max(0, topEdge - yPadding);
    const width = Math.min(metadata.width - left, panelWidth + 2 * xPadding);
    const height = Math.min(metadata.height - top, panelHeight + 2 * yPadding);

    if (width < 100 || height < 70) return null;
    return { left, top, width, height };
  } catch {
    return null;
  }
}

function makeResult(status, fields, text, confidence, region, diagStatus, failureReason, errorCode) {
  return {
    status,
    fields,
    ocr: { text, confidence, confidenceUnit: confidence === null ? null : "percent" },
    diagnostics: {
      status: diagStatus,
      rawText: text,
      region,
      failureReason,
    },
    error: errorCode ? { code: errorCode, message: failureReason || "OCR error occurred." } : null,
  };
}
