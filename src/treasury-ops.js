import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle } from "discord.js";
import { AMOUNT_MISMATCH, AMOUNT_NEEDS_REVIEW, buildAmountCheckerMessage, checkScreenshotAmount, describeAmountComparison, identifyPaymentScreen } from "./amount-checker.js";

export const TREASURY_STATUSES = ["PENDING", "NEEDS_REVIEW", "VERIFIED", "REJECTED", "DUPLICATE"];
export const treasurySchemaStatements = [
  `CREATE TABLE IF NOT EXISTS treasury_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT UNIQUE,
    submitter_id TEXT NOT NULL,
    payer_username TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    purpose TEXT NOT NULL,
    attachment_url TEXT NOT NULL,
    attachment_name TEXT NOT NULL,
    screenshot_hash TEXT NOT NULL,
    perceptual_hash TEXT,
    ocr_text TEXT NOT NULL DEFAULT '',
    extracted_payer TEXT,
    extracted_recipient TEXT,
    extracted_amount INTEGER,
    amount_comparison TEXT,
    transaction_id TEXT,
    findings TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('PENDING','NEEDS_REVIEW','VERIFIED','REJECTED','DUPLICATE')),
    reviewer_id TEXT,
    review_reason TEXT,
    duplicate_of TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_treasury_screenshot_hash ON treasury_submissions(screenshot_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_treasury_submitter ON treasury_submissions(submitter_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_treasury_status ON treasury_submissions(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS treasury_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TRIGGER IF NOT EXISTS treasury_audit_no_update BEFORE UPDATE ON treasury_audit_log BEGIN SELECT RAISE(ABORT, 'treasury audit log is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS treasury_audit_no_delete BEFORE DELETE ON treasury_audit_log BEGIN SELECT RAISE(ABORT, 'treasury audit log is append-only'); END`,
  `CREATE TABLE IF NOT EXISTS treasury_ticket_receipt_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    submitted_by TEXT NOT NULL,
    screenshot_hash TEXT NOT NULL,
    perceptual_hash TEXT,
    attachment_url TEXT NOT NULL,
    ocr_text TEXT NOT NULL DEFAULT '',
    extracted_payer TEXT,
    extracted_recipient TEXT,
    extracted_amount INTEGER,
    findings TEXT NOT NULL DEFAULT '[]',
    duplicate_reference TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_treasury_ticket_hash ON treasury_ticket_receipt_checks(screenshot_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_treasury_ticket_id ON treasury_ticket_receipt_checks(ticket_id, created_at)`,
];

export const treasuryEphemeral = { flags: MessageFlags.Ephemeral };
const maxImageBytes = 8 * 1024 * 1024;

// Startup migration for databases created before the amount checker existed:
// adds the amount_comparison column when it is missing. The fresh schema above
// already contains it, so the ALTER TABLE then reports a duplicate column,
// which is tolerated. The returned flag also lets submissions degrade safely:
// if the column can never be created, the comparison is simply not recorded.
let amountComparisonColumnReady = true;
export function amountComparisonColumnAvailable() {
  return amountComparisonColumnReady;
}

export async function ensureAmountComparisonColumn(db) {
  try {
    await db.execute("ALTER TABLE treasury_submissions ADD COLUMN amount_comparison TEXT");
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/duplicate column|already exists/i.test(message)) {
      amountComparisonColumnReady = false;
      console.error("PTB treasury amount-comparison column migration failed:", message);
      return false;
    }
  }
  amountComparisonColumnReady = true;
  return true;
}

export function treasuryReviewer(interaction, roleIds = "") {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roles = interaction.member?.roles?.cache;
  return Boolean(roles && roleIds.split(",").map((id) => id.trim()).filter(Boolean).some((id) => roles.has(id)));
}

export function inspectReceiptText(text, { payer, amount } = {}) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  const payerMatch = payer && new RegExp(
    String.raw`\b(?:payer|sender|sent\s+by|from)\s*[:#-]?\s*${String(payer).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`,
    "i",
  ).test(normalized);
  const recipientMatch = /\b(irp\s*treasury|treasury)\b/i.test(normalized);
  const confirmationRecipient = normalized.match(
    /\b(?:successfully\s+)?(?:sent|transferred|paid)\s+(?:[$€£]\s*)?\d[\d., \u00a0]*(?:\s*[$€£])?\s+to\s+([A-Za-z0-9_][A-Za-z0-9_.-]{0,19})\b/i,
  )?.[1] ?? null;
  const extractedRecipient = recipientMatch ? "IRP Treasury" : confirmationRecipient;
  const paymentScreenDetected = identifyPaymentScreen(text);
  // Amount checker: only transaction-labelled numbers may become the extracted
  // amount; anything unreadable or ambiguous is recorded as NEEDS_REVIEW.
  const amountCheck = checkScreenshotAmount(text, amount);
  const extractedAmount = amountCheck.extractedAmount;
  const transactionId = normalized.match(/(?:transaction|receipt|reference|trans(?:action)?\s*id)\s*[:#-]?\s*([a-z0-9-]{4,})/i)?.[1] ?? null;
  const findings = [];
  if (!normalized) findings.push("OCR_UNAVAILABLE_OR_UNREADABLE");
  if (!payerMatch) findings.push(normalized ? "PAYER_NOT_CONFIRMED_BY_OCR" : "PAYER_NOT_READABLE");
  if (!recipientMatch) findings.push(extractedRecipient ? "RECIPIENT_NOT_IRP_TREASURY" : "RECIPIENT_NOT_CONFIRMED_BY_OCR");
  if (amountCheck.comparison === AMOUNT_MISMATCH) findings.push("AMOUNT_MISMATCH");
  else if (amountCheck.comparison === AMOUNT_NEEDS_REVIEW) findings.push("AMOUNT_NOT_READABLE");
  return { extractedPayer: payerMatch ? payer : null, extractedRecipient, extractedAmount, transactionId, findings, amountCheck, paymentScreenDetected };
}

function runTesseract(bytes, command, pageSegmentationMode) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["stdin", "stdout", "--psm", String(pageSegmentationMode), "-c", "user_defined_dpi=300"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(text.trim());
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Tesseract OCR timed out in page segmentation mode ${pageSegmentationMode}`));
    }, 8_000);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 128 * 1024) {
        child.kill("SIGKILL");
        finish(new Error(`Tesseract OCR output exceeded the limit in page segmentation mode ${pageSegmentationMode}`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= 2 * 1024) return;
      const remaining = 2 * 1024 - stderrBytes;
      const part = chunk.subarray(0, remaining);
      stderrBytes += part.length;
      stderr.push(part);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
        finish(new Error(`Tesseract OCR failed in page segmentation mode ${pageSegmentationMode}${detail ? `: ${detail}` : ""}`));
        return;
      }
      finish(null, Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.once("error", () => {});
    child.stdin.end(bytes);
  });
}

async function defaultRunOcr(bytes) {
  // Tesseract is optional and local. Its output is a review hint only; absence
  // or failure must never reject a receipt. TESSERACT_PATH can point at a
  // non-default binary location (for example a Windows install or a Bothost
  // container path).
  const command = process.env.TESSERACT_PATH || "tesseract";
  const passes = await Promise.all([6, 11].map(async (pageSegmentationMode) => {
    try {
      return await runTesseract(bytes, command, pageSegmentationMode);
    } catch (error) {
      return { error };
    }
  }));
  const results = passes.filter((pass) => typeof pass === "string" && pass);
  const failures = passes.filter((pass) => pass?.error);
  if (!results.length && failures.length) throw failures[0].error;
  return [...new Set(results.flatMap((text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)))].join("\n");
}

// Test-only OCR engine override so the submission flow can be tested without
// a local Tesseract installation. Passing null restores the default engine.
let ocrEngineOverride = null;
export function __setTreasuryOcrForTests(override) {
  ocrEngineOverride = typeof override === "function" ? override : null;
}

export async function analyzeReceipt(bytes, claimed) {
  let ocrText = "";
  try {
    ocrText = String((ocrEngineOverride ? await ocrEngineOverride(bytes) : await defaultRunOcr(bytes)) ?? "").trim();
  } catch (error) {
    console.warn("PTB treasury OCR failed:", error?.message ?? String(error));
  }
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    ocrText,
    ...inspectReceiptText(ocrText, claimed),
    perceptualHash: pngDifferenceHash(bytes),
  };
}

// Dependency-free difference hash for non-interlaced, 8-bit PNG screenshots
// in grayscale/RGB/RGBA. Unsupported PNG variants and JPEG/WebP fall back to
// exact hashing and OCR. This is a similarity warning only, never a fraud call.
function pngDifferenceHash(bytes) {
  if (!(bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === "PNG")) return null;
  try {
    let offset = 8; let width; let height; let colorType; let bitDepth; let interlace;
    const compressed = [];
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset); const type = bytes.toString("ascii", offset + 4, offset + 8);
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
      if (type === "IDAT") compressed.push(data);
      offset += 12 + length;
      if (type === "IEND") break;
    }
    const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType];
    if (!width || !height || width * height > 30_000_000 || bitDepth !== 8 || interlace !== 0 || !channels) return null;
    const stride = width * channels;
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
    if (raw.length < (stride + 1) * height) return null;
    const rows = new Uint8Array(stride * height); let src = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = raw[src++]; const row = y * stride;
      for (let x = 0; x < stride; x += 1) {
        const value = raw[src++]; const left = x >= channels ? rows[row + x - channels] : 0;
        const up = y ? rows[row - stride + x] : 0; const upperLeft = y && x >= channels ? rows[row - stride + x - channels] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = Math.floor((left + up) / 2);
        else if (filter === 4) {
          const p = left + up - upperLeft; const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upperLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
        } else if (filter !== 0) return null;
        rows[row + x] = (value + predictor) & 255;
      }
    }
    const lum = (x, y) => {
      const p = (Math.min(height - 1, Math.floor(y * height / 8)) * width + Math.min(width - 1, Math.floor(x * width / 9))) * channels;
      if (colorType === 0) return rows[p];
      if (colorType === 4) return rows[p];
      return Math.round(rows[p] * 0.299 + rows[p + 1] * 0.587 + rows[p + 2] * 0.114);
    };
    let hash = 0n;
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) hash = (hash << 1n) | BigInt(lum(x, y) > lum(x + 1, y) ? 1 : 0);
    return hash.toString(16).padStart(16, "0");
  } catch { return null; }
}

function hashDistance(left, right) {
  if (!left || !right) return Infinity;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`); let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

export function validateReceiptInput({ payer, amount, purpose, attachment }) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(payer ?? "")) return "Enter a valid Roblox username (3–20 letters, numbers, or underscores).";
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2_147_483_647) return "Amount must be a positive whole number within the supported limit.";
  if (!purpose?.trim() || purpose.trim().length > 500) return "Purpose must contain 1–500 characters.";
  if (!attachment) return "Attach a screenshot of the transaction.";
  if (!/^image\/(png|jpeg|webp)$/.test(attachment.contentType ?? "")) return "Attach a PNG, JPEG, or WebP image.";
  if (attachment.size > maxImageBytes) return "Screenshot must be 8 MB or smaller.";
  return null;
}

async function audit(db, reference, actorId, action, previous, next, details = null) {
  await db.execute({ sql: "INSERT INTO treasury_audit_log (reference, actor_id, action, previous_status, new_status, details) VALUES (?, ?, ?, ?, ?, ?)", args: [reference, actorId, action, previous, next, details] });
}

function makeReviewEmbed(row) {
  const findings = JSON.parse(row.findings || "[]");
  return new EmbedBuilder().setColor(row.status === "NEEDS_REVIEW" || row.status === "DUPLICATE" ? 0xD97706 : 0x0B3D2E)
    .setTitle(`Treasury receipt ${row.reference}`)
    .setDescription(`**Status:** ${row.status}\n**Claimed payer:** ${row.payer_username}\n**Claimed amount:** ${Number(row.amount).toLocaleString()}\n**Purpose:** ${row.purpose}\n**Submitter:** <@${row.submitter_id}>`)
    .addFields(
      { name: "Screenshot analysis (assessment only)", value: `Payment screen: ${identifyPaymentScreen(row.ocr_text) ? "detected" : "not confidently identified"}\nSender / payer: ${row.extracted_payer ?? "not confirmed from explicit sender text"}\nRecipient (shown after “to”): ${row.extracted_recipient ?? "not confirmed"}\nSent amount (including € value): ${row.extracted_amount ?? "not readable"}\nAmount comparison: ${describeAmountComparison(row.amount_comparison)}\nTransaction ID: ${row.transaction_id ?? "not found"}` },
      { name: "Automated findings", value: findings.length ? findings.join(", ") : "No discrepancies detected; image analysis does not prove transfer authenticity." },
      ...(row.duplicate_of ? [{ name: "Duplicate match", value: `Related receipt: ${row.duplicate_of}` }] : []),
    ).setImage(row.attachment_url).setFooter({ text: "Screenshot-assisted review; authorized human approval is required." });
}

export async function submitTreasuryPayment(db, interaction, { reviewChannelId, reviewerRoleIds = "" }) {
  const payer = interaction.options.getString("payer", true).trim();
  const amount = interaction.options.getInteger("amount", true);
  const purpose = interaction.options.getString("purpose", true).trim();
  const attachment = interaction.options.getAttachment("screenshot", true);
  const problem = validateReceiptInput({ payer, amount, purpose, attachment });
  if (problem) return interaction.reply({ content: problem, ...treasuryEphemeral });
  if (!interaction.inGuild()) return interaction.reply({ content: "Treasury submissions can only be made in the PTB server.", ...treasuryEphemeral });
  if (!reviewChannelId) return interaction.reply({ content: "Treasury submissions are not configured. Contact a PTB administrator.", ...treasuryEphemeral });
  await interaction.deferReply(treasuryEphemeral);
  let bytes;
  try {
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Attachment download failed (${response.status})`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxImageBytes) throw new Error("Screenshot exceeds size limit");
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxImageBytes || !isSupportedImage(bytes)) throw new Error("Attachment is not a supported image");
  } catch {
    return interaction.editReply("I could not read that screenshot. Please attach a valid PNG, JPEG, or WebP image under 8 MB.");
  }
  const analysis = await analyzeReceipt(bytes, { payer, amount });
  let reference; let status; let duplicateOf;
  const tx = await db.transaction("write");
  try {
    // Run duplicate checks and insertion in one write transaction so two
    // simultaneous submissions cannot both miss the same prior receipt.
    const exact = await tx.execute({ sql: "SELECT reference FROM treasury_submissions WHERE screenshot_hash = ? LIMIT 1", args: [analysis.hash] });
    const similar = await tx.execute({ sql: "SELECT reference FROM treasury_submissions WHERE lower(payer_username) = lower(?) AND amount = ? AND status != 'REJECTED' ORDER BY id DESC LIMIT 1", args: [payer, amount] });
    const visualSimilar = analysis.perceptualHash
      ? await tx.execute({ sql: "SELECT reference,perceptual_hash FROM treasury_submissions WHERE perceptual_hash IS NOT NULL AND status != 'REJECTED' ORDER BY id DESC LIMIT 500" })
      : { rows: [] };
    const visualMatch = visualSimilar.rows.find((item) => hashDistance(analysis.perceptualHash, item.perceptual_hash) <= 8)?.reference ?? null;
    const exactDuplicate = exact.rows[0]?.reference ?? null;
    duplicateOf = exactDuplicate ?? visualMatch ?? similar.rows[0]?.reference ?? null;
    const findings = [...analysis.findings];
    if (exactDuplicate) findings.push("EXACT_SCREENSHOT_DUPLICATE");
    else if (visualMatch) findings.push("PERCEPTUALLY_SIMILAR_SCREENSHOT_REQUIRES_REVIEW");
    else if (duplicateOf) findings.push("SIMILAR_PAYER_AMOUNT_REQUIRES_REVIEW");
    status = exactDuplicate ? "DUPLICATE" : (duplicateOf || analysis.findings.length ? "NEEDS_REVIEW" : "PENDING");
    // The automatic amount checker stores its outcome with the record; it only
    // informs review and never verifies or rejects a payment on its own.
    const recordComparison = amountComparisonColumnAvailable() ? analysis.amountCheck.comparison : null;
    const insertColumns = `submitter_id,payer_username,amount,purpose,attachment_url,attachment_name,screenshot_hash,perceptual_hash,ocr_text,extracted_payer,extracted_recipient,extracted_amount,transaction_id,findings,status,duplicate_of`;
    const insertPlaceholders = "?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?";
    const insertArgs = [interaction.user.id, payer, amount, purpose, attachment.url, attachment.name, analysis.hash, analysis.perceptualHash, analysis.ocrText, analysis.extractedPayer, analysis.extractedRecipient, analysis.extractedAmount, analysis.transactionId, JSON.stringify(findings), status, duplicateOf];
    const inserted = await tx.execute({ sql: `INSERT INTO treasury_submissions (${insertColumns}${recordComparison ? ",amount_comparison" : ""}) VALUES (${insertPlaceholders}${recordComparison ? ",?" : ""})`, args: recordComparison ? [...insertArgs, recordComparison] : insertArgs });
    const id = Number(inserted.lastInsertRowid);
    reference = `IRPT-${String(id).padStart(6, "0")}`;
    await tx.execute({ sql: "UPDATE treasury_submissions SET reference = ? WHERE id = ?", args: [reference, id] });
    await tx.execute({ sql: "INSERT INTO treasury_audit_log (reference,actor_id,action,previous_status,new_status,details) VALUES (?,?, 'SUBMITTED', NULL, ?, ?)", args: [reference, interaction.user.id, status, JSON.stringify({ payer, amount, purpose, duplicateOf })] });
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    if (/idx_treasury_screenshot_hash|UNIQUE constraint failed/i.test(String(error?.message))) return interaction.editReply("This screenshot has already been submitted. Contact a treasury reviewer if you believe this is an error.");
    throw error;
  } finally { tx.close(); }
  const result = await db.execute({ sql: "SELECT * FROM treasury_submissions WHERE reference = ?", args: [reference] });
  const row = result.rows[0];
  try {
    const channel = await interaction.client.channels.fetch(reviewChannelId);
    const guild = interaction.guild;
    const botMember = guild?.members?.me;
    if (!guild || channel?.guildId !== guild.id || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw new Error("Treasury review channel must be a text channel in the submitting server");
    if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) throw new Error("Treasury review channel is visible to everyone");
    const botPermissions = botMember && channel.permissionsFor(botMember);
    if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles])) throw new Error("Bot lacks required permissions in treasury review channel");
    const configuredRoles = reviewerRoleIds.split(",").map((id) => guild.roles.cache.get(id.trim())).filter(Boolean);
    if (configuredRoles.length && !configuredRoles.some((role) => channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel))) throw new Error("No configured reviewer role can view the treasury review channel");
    await channel.send({ embeds: [makeReviewEmbed(row)], files: [{ attachment: bytes, name: attachment.name }], components: reviewComponents(reference) });
  } catch (error) {
    console.error("Could not post treasury review item:", error);
    await db.execute({ sql: "UPDATE treasury_submissions SET status='NEEDS_REVIEW', updated_at=CURRENT_TIMESTAMP WHERE reference=? AND status='PENDING'", args: [reference] });
    await audit(db, reference, interaction.user.id, "REVIEW_CHANNEL_DELIVERY_FAILED", status, "NEEDS_REVIEW", "Could not deliver review message");
    return interaction.editReply(`Receipt ${reference} is recorded as NEEDS_REVIEW, but the review channel could not be notified. Please contact treasury staff.`);
  }
  await interaction.editReply(buildAmountCheckerMessage({
    comparison: row.amount_comparison ?? analysis.amountCheck?.comparison ?? AMOUNT_NEEDS_REVIEW,
    claimedAmount: amount,
    extractedAmount: analysis.extractedAmount,
    status,
    reference,
  }));
}

function isSupportedImage(bytes) {
  return (bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === "PNG") || (bytes[0] === 0xff && bytes[1] === 0xd8) || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
}

export async function handleDepositTicketImage(db, message) {
  // Compatibility export. The ticket-owned integration lives in
  // ticket-deposit.js so the OCR reader and shared embed utility can be merged
  // independently.
  const { handleDepositTicketImage: handler } = await import("./ticket-deposit.js");
  return handler(db, message);
}

function reviewComponents(reference) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`trv-approve:${reference}`).setLabel("Verify payment").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`trv-reject:${reference}`).setLabel("Reject").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`trv-info:${reference}`).setLabel("Request information").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`trv-flag:${reference}`).setLabel("Flag for investigation").setStyle(ButtonStyle.Secondary),
  )];
}

export async function handleTreasuryButton(db, interaction, action, reference, reviewerRoleIds) {
  if (!treasuryReviewer(interaction, reviewerRoleIds)) return interaction.reply({ content: "Only configured treasury reviewers or administrators can use this action.", ...treasuryEphemeral });
  const found = await db.execute({ sql: "SELECT * FROM treasury_submissions WHERE reference = ?", args: [reference] });
  const row = found.rows[0];
  if (!row) return interaction.reply({ content: "Treasury receipt not found.", ...treasuryEphemeral });
  if (action === "approve" && JSON.parse(row.findings || "[]").length) {
    return interaction.reply({ content: `This receipt has flagged findings: ${JSON.parse(row.findings).join(", ")}. Review the screenshot and confirm only if you have verified the payment independently.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`trv-approve-confirm:${reference}`).setLabel("Confirm verification").setStyle(ButtonStyle.Success))], ...treasuryEphemeral });
  }
  if (action === "reject" || action === "info" || action === "flag") {
    const labels = { reject: "Rejection reason", info: "Information requested", flag: "Investigation note" };
    const modal = new ModalBuilder().setCustomId(`trm-${action}:${reference}`).setTitle(labels[action]);
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel(labels[action]).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));
    return interaction.showModal(modal);
  }
  if (action !== "approve" && action !== "approve-confirm") return interaction.reply({ content: "Unknown treasury action.", ...treasuryEphemeral });
  const result = await applyTreasuryReview(db, reference, interaction.user.id, "VERIFIED", "Approved by authorized reviewer");
  return interaction.reply({ content: result.ok ? `Receipt ${reference} verified.` : `Receipt was not changed (current state: ${result.status}).`, ...treasuryEphemeral });
}

export async function applyTreasuryReview(db, reference, actorId, nextStatus, reason) {
  if (!["VERIFIED", "REJECTED", "NEEDS_REVIEW"].includes(nextStatus)) throw new Error("Invalid review status");
  const previous = await db.execute({ sql: "SELECT status FROM treasury_submissions WHERE reference=?", args: [reference] });
  if (!previous.rows.length) return { ok: false, status: "NOT_FOUND" };
  const from = previous.rows[0].status;
  if (["VERIFIED", "REJECTED"].includes(from)) return { ok: false, status: from };
  const tx = await db.transaction("write");
  try {
    const changed = await tx.execute({ sql: "UPDATE treasury_submissions SET status=?, reviewer_id=?, review_reason=?, reviewed_at=CASE WHEN ? IN ('VERIFIED','REJECTED') THEN CURRENT_TIMESTAMP ELSE reviewed_at END, updated_at=CURRENT_TIMESTAMP WHERE reference=? AND status IN ('PENDING','NEEDS_REVIEW','DUPLICATE')", args: [nextStatus, actorId, reason, nextStatus, reference] });
    if (Number(changed.rowsAffected) !== 1) { await tx.rollback(); return { ok: false, status: "CONFLICT" }; }
    await tx.execute({ sql: "INSERT INTO treasury_audit_log (reference,actor_id,action,previous_status,new_status,details) VALUES (?,?,?,?,?,?)", args: [reference, actorId, nextStatus === "VERIFIED" ? "APPROVED" : nextStatus === "REJECTED" ? "REJECTED" : "REVIEW_UPDATED", from, nextStatus, reason] });
    await tx.commit();
    return { ok: true, status: nextStatus };
  } catch (error) { await tx.rollback().catch(() => {}); throw error; }
  finally { tx.close(); }
}

export async function handleTreasuryModal(db, interaction, reviewerRoleIds) {
  const match = interaction.customId.match(/^trm-(reject|info|flag):(IRPT-\d+)$/);
  if (!match) return;
  if (!treasuryReviewer(interaction, reviewerRoleIds)) return interaction.reply({ content: "Only configured treasury reviewers or administrators can use this action.", ...treasuryEphemeral });
  const [, action, reference] = match;
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const status = action === "reject" ? "REJECTED" : "NEEDS_REVIEW";
  const result = await applyTreasuryReview(db, reference, interaction.user.id, status, reason);
  let notify = "";
  if (result.ok) {
    const record = await db.execute({ sql: "SELECT submitter_id FROM treasury_submissions WHERE reference=?", args: [reference] });
    try {
      const player = await interaction.client.users.fetch(record.rows[0].submitter_id);
      const wording = action === "info" ? "PTB treasury staff requested more information for" : action === "reject" ? "PTB treasury staff rejected" : "PTB treasury staff flagged for manual investigation";
      await player.send(`${wording} receipt ${reference}. Staff note: ${reason}`);
      notify = " The submitter was notified by DM.";
    } catch { notify = " I could not DM the submitter; they can still check /treasury-status."; }
  }
  await interaction.reply({ content: result.ok ? `Receipt ${reference} updated to ${status}.${notify}` : `Receipt was not changed (current state: ${result.status}).`, ...treasuryEphemeral });
}

export async function handleTreasuryStatus(db, interaction, reference) {
  const found = await db.execute({ sql: "SELECT reference,submitter_id,payer_username,amount,purpose,status,review_reason,duplicate_of,created_at,reviewed_at FROM treasury_submissions WHERE reference=?", args: [reference.toUpperCase()] });
  const row = found.rows[0];
  if (!row || (row.submitter_id !== interaction.user.id && !treasuryReviewer(interaction, process.env.TREASURY_REVIEWER_ROLE_IDS))) return interaction.reply({ content: "Receipt not found or you do not have access to it.", ...treasuryEphemeral });
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x0B3D2E).setTitle(`Treasury receipt ${row.reference}`).setDescription(`**Status:** ${row.status}\n**Payer:** ${row.payer_username}\n**Amount:** ${Number(row.amount).toLocaleString()}\n**Purpose:** ${row.purpose}${row.review_reason ? `\n**Review note:** ${row.review_reason}` : ""}${row.duplicate_of ? `\n**Related receipt:** ${row.duplicate_of}` : ""}`)], ...treasuryEphemeral });
}

export async function handleTreasuryHistory(db, interaction) {
  const found = await db.execute({ sql: "SELECT reference,payer_username,amount,status,created_at FROM treasury_submissions WHERE submitter_id=? ORDER BY id DESC LIMIT 20", args: [interaction.user.id] });
  const content = found.rows.length ? found.rows.map((r) => `**${r.reference}** — ${r.status} — ${r.payer_username}, ${Number(r.amount).toLocaleString()} — ${r.created_at}`).join("\n") : "You have no treasury submissions.";
  await interaction.reply({ content, ...treasuryEphemeral });
}

export async function handleTreasuryReport(db, interaction, roleIds, { from = null, to = null } = {}) {
  if (!treasuryReviewer(interaction, roleIds)) return interaction.reply({ content: "Only treasury reviewers or administrators can view reports.", ...treasuryEphemeral });
  const predicates = [];
  const args = [];
  if (from) { predicates.push("created_at >= ?"); args.push(from); }
  if (to) { predicates.push("created_at < datetime(?, '+1 day')"); args.push(to); }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const [summary, purposes] = await Promise.all([
    db.execute({ sql: `SELECT COUNT(*) total, SUM(status='VERIFIED') verified, SUM(status IN ('PENDING','NEEDS_REVIEW','DUPLICATE')) pending, SUM(status='REJECTED') rejected, COALESCE(SUM(CASE WHEN status='VERIFIED' THEN amount ELSE 0 END),0) verified_total FROM treasury_submissions ${where}`, args }),
    db.execute({ sql: `SELECT purpose,COUNT(*) count,COALESCE(SUM(CASE WHEN status='VERIFIED' THEN amount ELSE 0 END),0) verified_total FROM treasury_submissions ${where} GROUP BY purpose ORDER BY count DESC LIMIT 10`, args }),
  ]);
  const s = summary.rows[0];
  const breakdown = purposes.rows.map((row) => `${row.purpose}: ${row.count} submission(s), verified ${Number(row.verified_total).toLocaleString()}`).join("\n") || "No submissions";
  await interaction.reply({ embeds: [new EmbedBuilder().setTitle("IRP Treasury report").setColor(0x0B3D2E).setDescription(`Submissions: ${s.total ?? 0}\nVerified: ${s.verified ?? 0}\nPending / review: ${s.pending ?? 0}\nRejected: ${s.rejected ?? 0}\nVerified total: ${Number(s.verified_total ?? 0).toLocaleString()}`).addFields({ name: "Breakdown by purpose", value: breakdown })], ...treasuryEphemeral });
}

export async function handleTreasuryTotal(db, interaction, roleIds) {
  if (!treasuryReviewer(interaction, roleIds)) return interaction.reply({ content: "Only treasury reviewers or administrators can view treasury totals.", ...treasuryEphemeral });
  const result = await db.execute("SELECT COALESCE(SUM(amount),0) total FROM treasury_submissions WHERE status='VERIFIED'");
  await interaction.reply({ content: `Verified IRP Treasury payments total **${Number(result.rows[0].total).toLocaleString()}**. Pending and rejected submissions are excluded.`, ...treasuryEphemeral });
}

export async function handleTreasurySearch(db, interaction, roleIds, query) {
  if (!treasuryReviewer(interaction, roleIds)) return interaction.reply({ content: "Only treasury reviewers or administrators can search treasury records.", ...treasuryEphemeral });
  const result = await db.execute({ sql: "SELECT reference,payer_username,submitter_id,amount,status,purpose,created_at FROM treasury_submissions WHERE reference=? OR lower(payer_username)=lower(?) ORDER BY id DESC LIMIT 20", args: [query.toUpperCase(), query] });
  const content = result.rows.length ? result.rows.map((row) => `**${row.reference}** — ${row.status} — ${row.payer_username}, ${Number(row.amount).toLocaleString()} — <@${row.submitter_id}> — ${row.purpose}`).join("\n") : "No treasury records found.";
  await interaction.reply({ content, ...treasuryEphemeral });
}
