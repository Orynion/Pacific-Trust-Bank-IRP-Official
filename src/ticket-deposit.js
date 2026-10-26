import { createHash } from "node:crypto";
import { EmbedBuilder } from "discord.js";
import { AMOUNT_MATCH, AMOUNT_MISMATCH, AMOUNT_NEEDS_REVIEW, checkScreenshotAmount, describeAmountComparison, identifyPaymentScreen } from "./amount-checker.js";
import { ticketConfig } from "./ticket-config.js";
import { logTicketEvent } from "./ticket-log.js";
import { ticketCode } from "./ticket-ops.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export const ticketDepositSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS ticket_receipt_processing (
    ticket_id INTEGER NOT NULL,
    attachment_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ticket_id, attachment_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_receipt_processing_ticket
    ON ticket_receipt_processing (ticket_id, created_at)`,
];

const schemaReady = new WeakSet();
let analyzerOverride = null;
let embedOverride = null;
let analyzerPromise = null;
let embedBuilderPromise = null;

/**
 * Test/dev hook. Pass a function to override the OCR analyzer or the shared
 * embed builder; pass null to restore the normal module resolution.
 */
export function __setDepositTicketDependencies({ analyzeReceipt = undefined, buildEmbed = undefined } = {}) {
  if (analyzeReceipt !== undefined) {
    analyzerOverride = typeof analyzeReceipt === "function" ? analyzeReceipt : null;
    analyzerPromise = null;
  }
  if (buildEmbed !== undefined) {
    embedOverride = typeof buildEmbed === "function" ? buildEmbed : null;
    embedBuilderPromise = null;
  }
}

function isMissingModule(error, expectedName) {
  return error?.code === "ERR_MODULE_NOT_FOUND" && String(error?.message ?? "").includes(expectedName);
}

async function ensureSchema(db) {
  if (!db || typeof db !== "object" || schemaReady.has(db)) return;
  try {
    if (typeof db.batch === "function") {
      await db.batch(ticketDepositSchemaStatements, "write");
    } else {
      for (const statement of ticketDepositSchemaStatements) await db.execute(statement);
    }
    schemaReady.add(db);
  } catch (error) {
    console.warn("[PTB Deposit] Could not initialize attachment dedupe storage:", error?.message ?? error);
  }
}

async function legacyAnalyzeReceipt(buffer, context) {
  // Compatibility path until src/deposit-detection.js is merged. It reuses the
  // existing treasury OCR instead of adding a second OCR engine.
  const treasury = await import("./treasury-ops.js");
  if (typeof treasury.analyzeReceipt !== "function") {
    throw new Error("Receipt reader is unavailable: src/deposit-detection.js is missing and the legacy adapter has no analyzeReceipt export.");
  }
  return treasury.analyzeReceipt(buffer, { payer: context.claimedPayer, amount: context.claimedAmount });
}

async function resolveAnalyzer() {
  if (analyzerOverride) return analyzerOverride;
  if (!analyzerPromise) {
    analyzerPromise = (async () => {
      try {
        const module = await import("./deposit-detection.js");
        const analyzer = module.analyzeReceipt
          ?? module.default?.analyzeReceipt
          ?? (typeof module.default === "function" ? module.default : null);
        if (typeof analyzer !== "function") {
          throw new Error("src/deposit-detection.js must export an async analyzeReceipt(imageBuffer) function.");
        }
        return analyzer;
      } catch (error) {
        if (isMissingModule(error, "deposit-detection.js")) {
          console.warn("[PTB Deposit] src/deposit-detection.js is not present yet; using the legacy treasury OCR adapter.");
        } else {
          console.warn("[PTB Deposit] Could not load src/deposit-detection.js; using the legacy treasury OCR adapter:", error?.message ?? error);
        }
        return null;
      }
    })();
  }
  return analyzerPromise;
}

const embedModuleCandidates = [
  "./deposit-embed.js",
  "./deposit-embeds.js",
  "./deposit-embed-utils.js",
  "./deposit-receipt-embed.js",
  "./receipt-embed.js",
  "./receipt-embeds.js",
  "./receipt-embed-utils.js",
  "./receipt-analysis-embed.js",
  "./embed-utils.js",
  "./shared-embed.js",
  "./shared-embeds.js",
  "./ticket-embed.js",
  "./ticket-embeds.js",
];

const embedBuilderNames = [
  "buildDepositAnalysisEmbed",
  "buildDepositReceiptEmbed",
  "buildReceiptAnalysisEmbed",
  "buildReceiptEmbed",
  "buildAnalysisEmbed",
  "createDepositAnalysisEmbed",
  "makeDepositAnalysisEmbed",
  "renderDepositAnalysisEmbed",
  "formatDepositAnalysisEmbed",
  "depositAnalysisEmbed",
  "receiptAnalysisEmbed",
  "buildDepositEmbed",
];

function pickEmbedBuilder(module) {
  for (const name of embedBuilderNames) {
    if (typeof module?.[name] === "function") return module[name];
  }
  const defaultExport = module?.default;
  if (typeof defaultExport === "function") return defaultExport;
  if (defaultExport && typeof defaultExport === "object") {
    for (const name of embedBuilderNames) {
      if (typeof defaultExport[name] === "function") return defaultExport[name];
    }
  }
  return null;
}

async function resolveSharedEmbedBuilder() {
  if (embedOverride) return embedOverride;
  if (!embedBuilderPromise) {
    embedBuilderPromise = (async () => {
      for (const candidate of embedModuleCandidates) {
        try {
          const module = await import(candidate);
          const builder = pickEmbedBuilder(module);
          if (builder) {
            console.log(`[PTB Deposit] Using shared receipt embed utility ${candidate}.`);
            return builder;
          }
        } catch (error) {
          if (!isMissingModule(error, candidate.slice(2))) {
            console.warn(`[PTB Deposit] Could not load shared embed candidate ${candidate}:`, error?.message ?? error);
          }
        }
      }
      console.warn("[PTB Deposit] No shared receipt embed utility found yet; using the ticket-local fallback embed.");
      return null;
    })();
  }
  return embedBuilderPromise;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstAmount(...values) {
  for (const value of values) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string") {
      const normalized = value.replace(/[^\d-]/g, "");
      if (/^-?\d+$/.test(normalized)) {
        const parsed = Number(normalized);
        if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
      }
    }
  }
  return null;
}

function firstBoolean(...values) {
  for (const value of values) if (typeof value === "boolean") return value;
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function analysisFailureMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.status !== "error" && !(raw.error && !raw.fields)) return null;
  const message = firstString(raw.error?.message, typeof raw.error === "string" ? raw.error : null);
  const code = firstString(raw.error?.code);
  if (message && code) return `${message} (${code})`;
  return message ?? code ?? "The receipt reader could not process this image.";
}

function normalizeFindings(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeAnalysis(raw, { buffer, claimedAmount, claimedPayer }) {
  const source = raw && typeof raw === "object" ? raw : {};
  const nested = source.result && typeof source.result === "object" ? source.result : {};
  const extracted = source.extracted && typeof source.extracted === "object" ? source.extracted : {};
  const fields = source.fields && typeof source.fields === "object" ? source.fields : {};
  const ocr = source.ocr && typeof source.ocr === "object" ? source.ocr : {};
  const combined = { ...source, ...nested, ...extracted, ...fields };

  const ocrText = firstString(
    combined.ocrText, ocr.text, combined.text, combined.rawText, combined.ocr_text, combined.extractedText,
  ) ?? "";
  const extractedPayer = firstString(
    combined.extractedPayer, combined.payer, combined.payerUsername, combined.sender, combined.senderName, combined.from,
  );
  const extractedRecipient = firstString(
    combined.extractedRecipient, combined.recipient, combined.receiver, combined.recipientName, combined.to,
  );
  const extractedAmount = firstAmount(
    combined.extractedAmount, combined.amount, combined.sentAmount, combined.paidAmount, combined.transactionAmount,
  );
  const currency = firstString(combined.currency, combined.currencyCode);
  const transactionId = firstString(
    combined.transactionId, combined.transactionReference, combined.reference, combined.receiptId, combined.transaction_id,
  );
  const paymentStatus = firstString(combined.paymentStatus, combined.receiptStatus);
  const paymentMethod = firstString(combined.paymentMethod, combined.method);
  const date = firstString(combined.date, combined.transactionDate);
  const time = firstString(combined.time, combined.transactionTime);
  const confidence = firstNumber(combined.confidence, ocr.confidence);
  const confidenceUnit = firstString(combined.confidenceUnit, ocr.confidenceUnit);
  const paymentScreenDetected = firstBoolean(
    combined.paymentScreenDetected, combined.isPaymentScreen, combined.paymentDetected, combined.isReceipt,
  ) ?? (identifyPaymentScreen(ocrText)
    || (extractedAmount !== null && (paymentStatus !== null || extractedRecipient !== null)));

  let amountComparison = firstString(
    combined.amountComparison, combined.amountComparisonCode, combined.comparison, combined.amountCheck?.comparison,
  );
  let amountCheck = combined.amountCheck && typeof combined.amountCheck === "object" ? combined.amountCheck : null;
  if (!amountComparison && ocrText && Number.isSafeInteger(claimedAmount)) {
    amountCheck = checkScreenshotAmount(ocrText, claimedAmount);
    amountComparison = amountCheck.comparison;
  }
  if (!amountComparison && extractedAmount !== null && Number.isSafeInteger(claimedAmount)) {
    amountComparison = extractedAmount === claimedAmount ? AMOUNT_MATCH : AMOUNT_MISMATCH;
  }
  if (![AMOUNT_MATCH, AMOUNT_MISMATCH, AMOUNT_NEEDS_REVIEW].includes(amountComparison)) {
    amountComparison = AMOUNT_NEEDS_REVIEW;
  }

  const findings = normalizeFindings(combined.findings);
  if (amountComparison === AMOUNT_MISMATCH && !findings.includes("AMOUNT_MISMATCH")) findings.push("AMOUNT_MISMATCH");
  if (amountComparison === AMOUNT_NEEDS_REVIEW && !findings.includes("AMOUNT_NOT_READABLE")) findings.push("AMOUNT_NOT_READABLE");
  if (/\b(?:fail(?:ed|ure)?|declin(?:ed|e)|reject(?:ed)?|cancel(?:led|ed)?)\b/i.test(paymentStatus ?? "")
    && !findings.includes("PAYMENT_STATUS_FAILED")) {
    findings.push("PAYMENT_STATUS_FAILED");
  }
  if (/\b(?:pending|processing|awaiting|initiated)\b/i.test(paymentStatus ?? "")
    && !findings.includes("PAYMENT_STATUS_PENDING")) {
    findings.push("PAYMENT_STATUS_PENDING");
  }

  const hash = firstString(combined.hash, combined.screenshotHash, combined.sha256, combined.imageHash)
    ?? createHash("sha256").update(buffer).digest("hex");
  const perceptualHash = firstString(combined.perceptualHash, combined.phash, combined.imagePerceptualHash);

  return {
    status: firstString(source.status, nested.status) ?? null,
    ocrText,
    extractedPayer,
    extractedRecipient,
    extractedAmount,
    currency,
    transactionId,
    paymentStatus,
    paymentMethod,
    date,
    time,
    confidence,
    confidenceUnit,
    paymentScreenDetected,
    amountComparison,
    amountCheck,
    findings,
    hash,
    perceptualHash,
    claimedAmount,
    claimedPayer,
  };
}

function isEligibleAttachment(attachment) {
  if (!attachment || typeof attachment.url !== "string") return false;
  if (!Number.isFinite(attachment.size) || attachment.size <= 0 || attachment.size > MAX_IMAGE_BYTES) return false;
  if (SUPPORTED_IMAGE_TYPES.has(String(attachment.contentType ?? "").toLowerCase())) return true;
  return /\.(png|jpe?g|webp)$/i.test(attachment.name ?? "");
}

function isSupportedImageBuffer(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString() === "PNG") return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

async function downloadAttachment(attachment) {
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Attachment download failed (${response.status})`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) throw new Error("Attachment exceeds the 8 MB image limit.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Attachment exceeds the 8 MB image limit.");
  if (!isSupportedImageBuffer(buffer)) throw new Error("Attachment is not a PNG, JPEG, or WebP image.");
  return buffer;
}

function attachmentKey(attachment) {
  if (attachment?.id) return String(attachment.id);
  return createHash("sha256")
    .update(`${attachment?.url ?? ""}|${attachment?.name ?? ""}|${attachment?.size ?? ""}`)
    .digest("hex");
}

async function claimAttachment(db, ticketId, attachment, messageId) {
  await ensureSchema(db);
  try {
    const result = await db.execute({
      sql: `INSERT OR IGNORE INTO ticket_receipt_processing
        (ticket_id, attachment_id, message_id, status) VALUES (?, ?, ?, 'processing')`,
      args: [ticketId, attachmentKey(attachment), String(messageId ?? "")],
    });
    return Number(result?.rowsAffected ?? 0) > 0;
  } catch (error) {
    // If the dedupe table cannot be written, fail closed rather than risk
    // posting the same OCR analysis repeatedly.
    console.warn("[PTB Deposit] Could not claim an attachment for processing:", error?.message ?? error);
    return false;
  }
}

async function finishClaim(db, ticketId, attachment, status, error = null) {
  try {
    await db.execute({
      sql: `UPDATE ticket_receipt_processing SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE ticket_id = ? AND attachment_id = ?`,
      args: [status, error ? String(error).slice(0, 1000) : null, ticketId, attachmentKey(attachment)],
    });
  } catch (updateError) {
    console.warn("[PTB Deposit] Could not update attachment processing state:", updateError?.message ?? updateError);
  }
}

async function findDuplicate(db, ticketId, hash) {
  try {
    const treasury = await db.execute({
      sql: "SELECT reference FROM treasury_submissions WHERE screenshot_hash = ? LIMIT 1",
      args: [hash],
    });
    if (treasury.rows[0]?.reference) return treasury.rows[0].reference;
    const ticket = await db.execute({
      sql: "SELECT ticket_id FROM treasury_ticket_receipt_checks WHERE screenshot_hash = ? ORDER BY id DESC LIMIT 1",
      args: [hash],
    });
    if (ticket.rows[0]) return `PTB-D-${ticket.rows[0].ticket_id}`;
  } catch (error) {
    console.warn("[PTB Deposit] Could not run receipt duplicate checks:", error?.message ?? error);
  }
  return null;
}

async function saveReceiptCheck(db, { ticket, message, attachment, analysis, duplicateReference }) {
  await db.execute({
    sql: `INSERT INTO treasury_ticket_receipt_checks
      (ticket_id, submitted_by, screenshot_hash, perceptual_hash, attachment_url, ocr_text,
       extracted_payer, extracted_recipient, extracted_amount, findings, duplicate_reference)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      ticket.id,
      message.author.id,
      analysis.hash,
      analysis.perceptualHash,
      attachment.url,
      analysis.ocrText,
      analysis.extractedPayer,
      analysis.extractedRecipient,
      analysis.extractedAmount,
      JSON.stringify(analysis.findings),
      duplicateReference,
    ],
  });
}

function payloadFromBuilt(built) {
  if (!built) return null;
  if (Array.isArray(built)) return { embeds: built.slice(0, 10) };
  if (typeof built === "string") return { content: built };
  if (built.embeds) return built;
  if (built.data) return { embeds: [built] };
  if (built.title || built.description || built.fields) return { embeds: [built] };
  return null;
}

function buildFallbackEmbed(raw, context) {
  const analysis = context.normalized;
  const ticket = context.ticket;
  const code = ticketCode(ticket);
  const comparison = analysis.amountComparison;
  const amountWithCurrency = analysis.extractedAmount === null
    ? null
    : `${analysis.extractedAmount}${analysis.currency ? ` ${analysis.currency}` : ""}`;
  const amountLine = amountWithCurrency === null
    ? "Sent amount: not readable"
    : `Amount: ${amountWithCurrency}${comparison === AMOUNT_MATCH ? " (matches ticket amount)" : comparison === AMOUNT_MISMATCH ? ` (ticket claims ${Number(ticket.amount).toLocaleString()})` : ""}`;
  const duplicateLine = context.duplicateReference
    ? `Duplicate: exact match to ${context.duplicateReference}`
    : "Duplicate: no exact screenshot match found";
  const findings = analysis.findings.length ? analysis.findings.join(", ") : "No OCR discrepancy detected";
  const confidenceLine = Number.isFinite(analysis.confidence) && analysis.confidence > 0
    ? `OCR confidence: ${analysis.confidence}${analysis.confidenceUnit === "percent" ? "%" : ""}`
    : "OCR confidence: not reported";
  const lines = [
    `Payment screen: ${analysis.paymentScreenDetected ? "detected from OCR cues" : "not confidently identified"}`,
    `Sender / payer (${context.claimedPayer || "account has no linked Roblox name"}): ${analysis.extractedPayer ? "matched from explicit sender text" : "not confirmed by OCR"}`,
    `Recipient: ${analysis.extractedRecipient ?? "not confirmed by OCR"}`,
    amountLine,
    `Amount comparison: ${describeAmountComparison(comparison)}`,
    duplicateLine,
    `Transaction ID: ${analysis.transactionId ?? "not found"}`,
    `Receipt status: ${analysis.paymentStatus ?? "not found"}`,
    confidenceLine,
    `Findings: ${findings}`,
  ];
  return new EmbedBuilder()
    .setColor(analysis.findings.length || context.duplicateReference ? 0xD97706 : 0x0B3D2E)
    .setTitle(`Deposit receipt analysis · ${code}`)
    .setDescription("Automated screenshot checks are advisory. Information extracted from screenshot OCR is unverified it could be unreliable and we do not hide that. Nothing was changed in your balance")
    .addFields({ name: `Screenshot check for ${context.attachment.name ?? "receipt"}`.slice(0, 256), value: lines.join("\n").slice(0, 1024) })
    .setFooter({ text: "Receipt analysis only · no balance changes or automatic approvals" });
}

async function renderAnalysisPayload(raw, context) {
  const sharedBuilder = await resolveSharedEmbedBuilder();
  if (sharedBuilder) {
    try {
      const built = await sharedBuilder(raw, context);
      const payload = payloadFromBuilt(built);
      if (payload) return payload;
      console.warn("[PTB Deposit] Shared receipt embed utility returned no usable embed; using the fallback embed.");
    } catch (error) {
      console.warn("[PTB Deposit] Shared receipt embed utility failed; using the fallback embed:", error?.message ?? error);
    }
  }
  return { embeds: [buildFallbackEmbed(raw, context)] };
}

function buildErrorEmbed(context, error = null) {
  const detail = firstString(error?.message)?.replace(/^Receipt reader error:\s*/i, "");
  const detailLine = detail ? `\n\n**Reader response:** ${detail.slice(0, 300)}` : "";
  return new EmbedBuilder()
    .setColor(0xD97706)
    .setTitle(`Receipt check unavailable · ${ticketCode(context.ticket)}`)
    .setDescription(`I could not analyze **${context.attachment.name ?? "the uploaded image"}**. The ticket is unchanged and still needs human review. You can upload a clearer screenshot or ask ticket staff to inspect this one manually.${detailLine}`)
    .setFooter({ text: "No balance changes or automatic approvals were made." });
}

/**
 * MessageCreate hook for pending deposit tickets only. It never sweeps
 * channels, never runs for withdrawal tickets, and never approves or credits a
 * deposit. OCR/analysis failures are posted in the same ticket and never crash
 * the bot.
 */
export async function handleDepositTicketImage(db, message) {
  if (!message?.guild || message.author?.bot || !message.attachments?.size) return false;
  const topicMatch = message.channel?.topic?.match(/^ptb-ticket:deposit:(\d+):(\d+):(\d+)$/);
  if (!topicMatch) return false;
  const [, requesterId, , ticketId] = topicMatch;

  const ticketResult = await db.execute({
    sql: "SELECT id,requester_id,amount,status,kind,channel_id FROM tickets WHERE id = ? AND channel_id = ? LIMIT 1",
    args: [ticketId, message.channelId],
  });
  const ticketRow = ticketResult.rows[0];
  if (!ticketRow || ticketRow.kind !== "deposit" || ticketRow.status !== "pending" || String(ticketRow.requester_id) !== requesterId) return false;
  const ticket = { ...ticketRow, id: Number(ticketRow.id), amount: Number(ticketRow.amount) };

  const accountResult = await db.execute({
    sql: "SELECT roblox_username FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [ticket.requester_id],
  });
  const claimedPayer = accountResult.rows[0]?.roblox_username || "";
  const config = ticketConfig();
  let postedAny = false;

  for (const attachment of message.attachments.values()) {
    if (!isEligibleAttachment(attachment)) continue;
    const claimed = await claimAttachment(db, ticket.id, attachment, message.id);
    if (!claimed) {
      console.log(`[PTB Deposit] Skipping already-processed attachment ${attachmentKey(attachment)} on ${ticketCode(ticket)}.`);
      continue;
    }

    const context = {
      ticket,
      attachment,
      message,
      claimedAmount: ticket.amount,
      claimedPayer,
      normalized: null,
      duplicateReference: null,
    };
    try {
      const buffer = await downloadAttachment(attachment);
      const analyzer = await resolveAnalyzer();
      const raw = analyzer
        ? await analyzer(buffer)
        : await legacyAnalyzeReceipt(buffer, context);
      const failure = analysisFailureMessage(raw);
      if (failure) throw new Error(`Receipt reader error: ${failure}`);
      const normalized = normalizeAnalysis(raw, { buffer, claimedAmount: ticket.amount, claimedPayer });
      context.normalized = normalized;

      const duplicateReference = await findDuplicate(db, ticket.id, normalized.hash);
      context.duplicateReference = duplicateReference;
      if (duplicateReference && !normalized.findings.includes("EXACT_SCREENSHOT_DUPLICATE")) {
        normalized.findings.push("EXACT_SCREENSHOT_DUPLICATE");
      }

      try {
        await saveReceiptCheck(db, { ticket, message, attachment, analysis: normalized, duplicateReference });
      } catch (error) {
        console.warn(`[PTB Deposit] Could not record receipt check for ${ticketCode(ticket)}:`, error?.message ?? error);
      }

      const payload = await renderAnalysisPayload(raw, context);
      await message.channel.send({ ...payload, allowedMentions: { parse: [] } });
      await finishClaim(db, ticket.id, attachment, "completed");
      postedAny = true;
      void logTicketEvent(message.client, {
        action: "RECEIPT_ANALYSIS_POSTED",
        ticket,
        actorId: message.author.id,
        details: `Attachment ${attachment.name ?? attachmentKey(attachment)} analyzed in <#${message.channelId}>.`,
      }, { config });
    } catch (error) {
      console.warn(`[PTB Deposit] Receipt analysis failed for ${ticketCode(ticket)}:`, error?.message ?? error);
      await finishClaim(db, ticket.id, attachment, "failed", error?.message ?? error);
      try {
        await message.channel.send({ embeds: [buildErrorEmbed(context, error)], allowedMentions: { parse: [] } });
        postedAny = true;
      } catch (sendError) {
        console.warn("[PTB Deposit] Could not post the receipt-analysis error notice:", sendError?.message ?? sendError);
      }
      void logTicketEvent(message.client, {
        action: "RECEIPT_ANALYSIS_FAILED",
        ticket,
        actorId: message.author.id,
        reason: error?.message ?? String(error),
        details: `Attachment ${attachment.name ?? attachmentKey(attachment)} could not be analyzed.`,
      }, { config });
    }
  }

  return postedAny;
}
