import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
 * Read a PTB transfer confirmation locally. Extracted text describes only
 * what the screenshot displays; it does not verify a real payment.
 *
 * @param {Buffer|Uint8Array} imageBuffer Image bytes (max 8 MiB).
 * @returns {Promise<{
 *   status: "ok"|"partial"|"unreadable"|"error",
 *   fields: {recipient: string|null, amount: string|null},
 *   ocr: {text: string, confidence: number|null, confidenceUnit: "percent"|null},
 *   error: {code: string, message: string}|null
 * }>}
 */
export async function analyzeReceipt(imageBuffer) {
  const emptyFields = { recipient: null, amount: null };
  if (!(Buffer.isBuffer(imageBuffer) || imageBuffer instanceof Uint8Array)) {
    return makeResult("error", emptyFields, "", null, "INVALID_INPUT", "Expected image bytes as a Buffer or Uint8Array.");
  }
  if (imageBuffer.byteLength === 0) {
    return makeResult("error", emptyFields, "", null, "EMPTY_IMAGE", "The uploaded image is empty.");
  }
  if (imageBuffer.byteLength > MAX_IMAGE_BYTES) {
    return makeResult("error", emptyFields, "", null, "IMAGE_TOO_LARGE", `Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB limit.`);
  }

  let worker;
  let timeout;
  try {
    const input = Buffer.from(imageBuffer);
    const metadata = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false }).metadata();
    if (!ALLOWED_FORMATS.has(metadata.format)) {
      return makeResult("error", emptyFields, "", null, "UNSUPPORTED_FORMAT", "Supported image formats are JPEG, PNG, WebP, GIF, TIFF, and BMP.");
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) {
      return makeResult("error", emptyFields, "", null, "IMAGE_DIMENSIONS", "Image dimensions are invalid or exceed the 40 megapixel limit.");
    }

    // PTB screenshots place the confirmation in a large, flat blue panel.
    // Cropping it excludes unrelated game-scene text and HUD balances. Other
    // layouts retain the prior full-image preprocessing path.
    const panel = await findBlueConfirmationPanel(input);
    const preparedImage = panel
      ? await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false })
        .rotate()
        .extract(panel)
        .resize({ width: panel.width * 3 })
        .grayscale()
        .normalize()
        .threshold(150)
        .png()
        .toBuffer()
      : await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false })
        .rotate()
        .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .grayscale()
        .normalize()
        .sharpen()
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
    const { data } = await Promise.race([worker.recognize(preparedImage), timeoutPromise]);
    const text = String(data?.text ?? "").trim();
    const fields = extractDepositConfirmation(text);
    const confidence = Number.isFinite(data?.confidence) ? Math.round(data.confidence * 10) / 10 : null;
    const populatedCount = Object.values(fields).filter((value) => value !== null).length;
    const status = !text || populatedCount === 0
      ? "unreadable"
      : populatedCount === Object.keys(fields).length ? "ok" : "partial";
    return makeResult(status, fields, text, confidence, null, null);
  } catch (error) {
    const code = error?.code === "OCR_TIMEOUT" ? "OCR_TIMEOUT" : "OCR_FAILED";
    return makeResult("error", emptyFields, "", null, code, String(error?.message ?? error).slice(0, 300));
  } finally {
    clearTimeout(timeout);
    if (worker) await worker.terminate().catch(() => {});
  }
}

/** Extract only amount and recipient from “Successfully sent … to …”. */
export function extractDepositConfirmation(ocrText) {
  const fields = { recipient: null, amount: null };
  const lines = String(ocrText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const number = String.raw`\d+(?:[,. ]\d{3})*(?:[,.]\d{1,2})?`;
  const money = String.raw`(?:\u20AC\s*)?${number}(?:\s*\u20AC)?`;

  // Tesseract may place the recipient on the line after “to”.
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index, index + 3).join(" ");
    const match = candidate.match(new RegExp(
      String.raw`\bsuccessfully\s+sent\s+(${money})\s+to\s+(.+?)(?:[.!?](?:\s|$)|$)`,
      "iu",
    ));
    if (!match) continue;

    const rawAmount = match[1].trim();
    const numberText = rawAmount.replace(/\u20AC/g, "").replace(/\s+/g, "");
    fields.amount = rawAmount.includes("\u20AC") ? `\u20AC${numberText}` : numberText;
    fields.recipient = match[2].trim().replace(/[.!?,;:]+$/, "").trim() || null;
    break;
  }
  return fields;
}

async function findBlueConfirmationPanel(input) {
  const preview = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false })
    .rotate()
    .resize({ width: 600, height: 600, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = preview;
  const rows = new Uint32Array(info.height);
  const columns = new Uint32Array(info.width);

  // Count a broad range of medium blue pixels at reduced resolution. A large,
  // rectangular concentration identifies the confirmation panel without
  // depending on its position or any text/value in the screenshot.
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (red >= 20 && red <= 55 && green >= 85 && green <= 135 && blue >= 130 && blue <= 180) {
        rows[y] += 1;
        columns[x] += 1;
      }
    }
  }

  const rowIndexes = indexesAbove(rows, Math.max(25, info.width * 0.12));
  const columnIndexes = indexesAbove(columns, Math.max(25, info.height * 0.08));
  if (rowIndexes.length === 0 || columnIndexes.length === 0) return null;

  const metadata = await sharp(input).metadata();
  const swapDimensions = metadata.orientation >= 5 && metadata.orientation <= 8;
  const sourceWidth = swapDimensions ? metadata.height : metadata.width;
  const sourceHeight = swapDimensions ? metadata.width : metadata.height;
  const scaleX = info.width / sourceWidth;
  const scaleY = info.height / sourceHeight;
  const leftEdge = Math.max(0, Math.floor(columnIndexes[0] / scaleX));
  const rightEdge = Math.ceil(columnIndexes.at(-1) / scaleX);
  const topEdge = Math.max(0, Math.floor(rowIndexes[0] / scaleY));
  const bottomEdge = Math.ceil(rowIndexes.at(-1) / scaleY);
  const panelWidth = rightEdge - leftEdge + 1;
  const xPadding = Math.max(8, Math.round(panelWidth * 0.02));
  const yPadding = Math.max(20, Math.round(panelWidth * 0.14));
  const left = Math.max(0, leftEdge - xPadding);
  const top = Math.max(0, topEdge - yPadding);
  const right = Math.min(sourceWidth, rightEdge + xPadding + 1);
  const bottom = Math.min(sourceHeight, bottomEdge + yPadding + 1);
  const width = right - left;
  const height = bottom - top;
  if (width < 160 || height < 160 || width * height > MAX_PIXELS) return null;
  return { left, top, width, height };
}

function indexesAbove(values, cutoff) {
  const indexes = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] > cutoff) indexes.push(index);
  }
  return indexes;
}

function makeResult(status, fields, text, confidence, errorCode, errorMessage) {
  return {
    status,
    fields,
    ocr: { text, confidence, confidenceUnit: confidence === null ? null : "percent" },
    error: errorCode ? { code: errorCode, message: errorMessage } : null,
  };
}
