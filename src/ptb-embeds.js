import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  attachTicketChannel,
  createPendingTicket,
  rejectTicketWithNote,
  ticketCode as formatTicketCode,
  ticketPanelPayload,
  ticketTopic,
  ticketTopicPrefix,
} from "./ticket-ops.js";
import { resolveStaffRoles, resolveTicketCategory, ticketConfig } from "./ticket-config.js";
import { logTicketEvent } from "./ticket-log.js";

/**
 * Pacific Trust Bank (PTB) Brand Color Palette
 * Restrained, banking-themed aesthetic for Emergency Hamburg RP.
 */
export const PTB_COLORS = Object.freeze({
  PRIMARY: 0x0B3D2E,   // PTB Deep Forest Green (Bank Primary)
  DEPOSIT: 0x0B3D2E,   // Deposit branding (matches primary green)
  WITHDRAW: 0x7C3AED,  // Withdrawal branding (Purple accent)
  SUCCESS: 0x16A34A,   // Verified / Approved / Success Green
  WARNING: 0xD97706,   // Advisory / Unverified / Review Amber
  ERROR: 0xDC2626,     // Rejection / System Error Crimson
  INFO: 0x2563EB,      // Guidance / Information Royal Blue
  MUTED: 0x475569,     // Slate Gray (Closed tickets, archived logs)
  NEUTRAL: 0x475569,   // Alias for MUTED
});

/**
 * Standard PTB Footers
 */
export const PTB_FOOTERS = Object.freeze({
  STANDARD: "Pacific Trust Bank • No real money is moved.",
  ADVISORY_RECEIPT: "Receipt analysis only · no balance changes or automatic approvals",
  AUDIT_LOG: "Pacific Trust Bank • Staff Audit Record",
  BALANCE: "Private ledger balance",
});

/**
 * Discord API Embed Limits
 */
export const DISCORD_LIMITS = Object.freeze({
  TITLE: 256,
  DESCRIPTION: 4096,
  FIELD_NAME: 256,
  FIELD_VALUE: 1024,
  FIELDS: 25,
  FOOTER: 2048,
  AUTHOR: 256,
  TOTAL: 6000,
});

/**
 * Truncate a string to a safe maximum length without breaking.
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
export function truncate(value, maxLength) {
  if (value === null || value === undefined) return "";
  const stringified = String(value);
  if (stringified.length <= maxLength) return stringified;
  if (maxLength <= 3) return stringified.slice(0, maxLength);
  return `${stringified.slice(0, maxLength - 1)}…`;
}

/**
 * Safely resolve a color argument to a valid 24-bit integer color code.
 * @param {string|number|null|undefined} colorInput
 * @param {number} defaultColor
 * @returns {number}
 */
export function resolveColor(colorInput, defaultColor = PTB_COLORS.PRIMARY) {
  if (typeof colorInput === "number" && Number.isFinite(colorInput)) {
    const intVal = Math.floor(colorInput);
    if (intVal >= 0 && intVal <= 0xFFFFFF) return intVal;
    return defaultColor;
  }

  if (typeof colorInput === "string") {
    const trimmed = colorInput.trim().toLowerCase();
    const namedMap = {
      primary: PTB_COLORS.PRIMARY,
      deposit: PTB_COLORS.DEPOSIT,
      withdraw: PTB_COLORS.WITHDRAW,
      withdrawal: PTB_COLORS.WITHDRAW,
      success: PTB_COLORS.SUCCESS,
      green: PTB_COLORS.SUCCESS,
      warning: PTB_COLORS.WARNING,
      amber: PTB_COLORS.WARNING,
      error: PTB_COLORS.ERROR,
      danger: PTB_COLORS.ERROR,
      red: PTB_COLORS.ERROR,
      info: PTB_COLORS.INFO,
      blue: PTB_COLORS.INFO,
      muted: PTB_COLORS.MUTED,
      gray: PTB_COLORS.MUTED,
      grey: PTB_COLORS.MUTED,
      neutral: PTB_COLORS.NEUTRAL,
    };
    if (namedMap[trimmed] !== undefined) return namedMap[trimmed];

    const hexMatch = trimmed.match(/^(?:#|0x)?([0-9a-f]{6})$/i);
    if (hexMatch) {
      const parsed = parseInt(hexMatch[1], 16);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  return defaultColor;
}

/**
 * Validate that a URL is a valid absolute HTTP or HTTPS URL.
 * @param {string|null|undefined} urlString
 * @returns {boolean}
 */
export function isValidHttpUrl(urlString) {
  if (typeof urlString !== "string" || !urlString.trim()) return false;
  try {
    const parsed = new URL(urlString.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Generate a standard PTB ticket code (e.g. PTB-D-12, PTB-W-42).
 * @param {{ kind?: string, type?: string, id?: number|string, code?: string }|string} ticket
 * @returns {string}
 */
export function safeTicketCode(ticket) {
  if (typeof ticket === "string" && ticket.trim()) return ticket.trim();
  if (ticket && typeof ticket === "object") {
    if (typeof ticket.code === "string" && ticket.code.trim()) return ticket.code.trim();
    const kind = ticket.kind || ticket.type;
    const isWithdraw = kind === "withdraw" || kind === "withdrawal";
    const isDeposit = kind === "deposit";
    const letter = isWithdraw ? "W" : (isDeposit ? "D" : "T");
    const id = ticket.id ?? "?";
    return `PTB-${letter}-${id}`;
  }
  return "PTB-TICKET";
}

/**
 * Normalize an options argument that could either be a single object or (title, description).
 * @param {string|object} titleOrOptions
 * @param {string} [optionalDescription]
 * @returns {object}
 */
function normalizeEmbedArgs(titleOrOptions, optionalDescription) {
  if (typeof titleOrOptions === "string") {
    return { title: titleOrOptions, description: optionalDescription ?? "" };
  }
  if (titleOrOptions && typeof titleOrOptions === "object") {
    return { ...titleOrOptions };
  }
  return {};
}

/**
 * Base builder for standard PTB embeds with branding and limits applied.
 * @param {object} options
 * @returns {EmbedBuilder}
 */
export function buildPtbEmbed(options = {}) {
  const color = resolveColor(options.color, PTB_COLORS.PRIMARY);
  const embed = new EmbedBuilder().setColor(color);

  if (options.title) {
    embed.setTitle(truncate(options.title, DISCORD_LIMITS.TITLE));
  }
  if (options.description) {
    embed.setDescription(truncate(options.description, DISCORD_LIMITS.DESCRIPTION));
  }
  if (options.url && isValidHttpUrl(options.url)) {
    embed.setURL(options.url.trim());
  }
  if (options.thumbnail && isValidHttpUrl(options.thumbnail)) {
    embed.setThumbnail(options.thumbnail.trim());
  }
  if (options.image && isValidHttpUrl(options.image)) {
    embed.setImage(options.image.trim());
  }

  if (Array.isArray(options.fields) && options.fields.length > 0) {
    const validFields = options.fields
      .filter((f) => f && (f.name || f.value))
      .slice(0, DISCORD_LIMITS.FIELDS)
      .map((f) => ({
        name: truncate(f.name || "\u200B", DISCORD_LIMITS.FIELD_NAME),
        value: truncate(f.value || "\u200B", DISCORD_LIMITS.FIELD_VALUE),
        inline: Boolean(f.inline),
      }));
    if (validFields.length > 0) embed.addFields(validFields);
  }

  const footerText = options.footer ?? PTB_FOOTERS.STANDARD;
  if (footerText) {
    const footerOptions = { text: truncate(footerText, DISCORD_LIMITS.FOOTER) };
    if (options.footerIcon && isValidHttpUrl(options.footerIcon)) {
      footerOptions.iconURL = options.footerIcon.trim();
    }
    embed.setFooter(footerOptions);
  }

  if (options.author) {
    if (typeof options.author === "string") {
      embed.setAuthor({ name: truncate(options.author, DISCORD_LIMITS.AUTHOR) });
    } else if (typeof options.author === "object" && options.author.name) {
      const authorOptions = { name: truncate(options.author.name, DISCORD_LIMITS.AUTHOR) };
      if (options.author.iconURL && isValidHttpUrl(options.author.iconURL)) {
        authorOptions.iconURL = options.author.iconURL.trim();
      }
      if (options.author.url && isValidHttpUrl(options.author.url)) {
        authorOptions.url = options.author.url.trim();
      }
      embed.setAuthor(authorOptions);
    }
  }

  if (options.timestamp !== false) {
    if (options.timestamp instanceof Date) embed.setTimestamp(options.timestamp);
    else if (typeof options.timestamp === "number" || typeof options.timestamp === "string") {
      const parsed = new Date(options.timestamp);
      if (!Number.isNaN(parsed.getTime())) embed.setTimestamp(parsed);
      else embed.setTimestamp();
    } else {
      embed.setTimestamp();
    }
  }

  return embed;
}

/**
 * Reusable builder for Informational embeds (Blue).
 * @param {string|object} titleOrOptions
 * @param {string} [optionalDescription]
 * @returns {EmbedBuilder}
 */
export function buildInfoEmbed(titleOrOptions, optionalDescription) {
  const options = normalizeEmbedArgs(titleOrOptions, optionalDescription);
  return buildPtbEmbed({
    ...options,
    title: options.title || "Pacific Trust Bank | Information",
    color: resolveColor(options.color, PTB_COLORS.INFO),
  });
}

/**
 * Reusable builder for Success embeds (Green).
 * @param {string|object} titleOrOptions
 * @param {string} [optionalDescription]
 * @returns {EmbedBuilder}
 */
export function buildSuccessEmbed(titleOrOptions, optionalDescription) {
  const options = normalizeEmbedArgs(titleOrOptions, optionalDescription);
  return buildPtbEmbed({
    ...options,
    title: options.title || "Pacific Trust Bank | Success",
    color: resolveColor(options.color, PTB_COLORS.SUCCESS),
  });
}

/**
 * Reusable builder for Warning embeds (Amber).
 * @param {string|object} titleOrOptions
 * @param {string} [optionalDescription]
 * @returns {EmbedBuilder}
 */
export function buildWarningEmbed(titleOrOptions, optionalDescription) {
  const options = normalizeEmbedArgs(titleOrOptions, optionalDescription);
  return buildPtbEmbed({
    ...options,
    title: options.title || "Pacific Trust Bank | Attention Required",
    color: resolveColor(options.color, PTB_COLORS.WARNING),
  });
}

/**
 * Reusable builder for Error embeds (Red).
 * @param {string|object} titleOrOptions
 * @param {string} [optionalDescription]
 * @returns {EmbedBuilder}
 */
export function buildErrorEmbed(titleOrOptions, optionalDescription) {
  const options = normalizeEmbedArgs(titleOrOptions, optionalDescription);
  return buildPtbEmbed({
    ...options,
    title: options.title || "Pacific Trust Bank | Error",
    color: resolveColor(options.color, PTB_COLORS.ERROR),
  });
}

/**
 * Reusable builder for the public Ticket Panel embed.
 * Explains deposit and withdrawal tickets and banking roleplay policies.
 * @param {object} [options]
 * @returns {EmbedBuilder}
 */
export function buildTicketPanelEmbed(options = {}) {
  const title = options.title || "🏦 Pacific Trust Bank | Transaction Requests";
  const description = options.description || "Welcome to Pacific Trust Bank. Open a private ticket below to request an account deposit or withdrawal. All transactions are recorded in the PTB ledger.";

  return buildPtbEmbed({
    title,
    description,
    color: resolveColor(options.color, PTB_COLORS.PRIMARY),
    fields: [
      {
        name: "📥 Deposit Requests",
        value: options.depositInstructions || "Open a deposit ticket to credit your PTB ledger balance. You will be prompted to upload an in-game payment screenshot as advisory proof. Screenshots are unverified and do not credit deposits automatically.",
      },
      {
        name: "📤 Withdrawal Requests",
        value: options.withdrawInstructions || "Open a withdrawal ticket to request an in-game payout. PTB staff will verify your balance before delivering funds. Opening a ticket does not reserve or lock your balance.",
      },
      {
        name: "ℹ️ Roleplay Ledger Notice",
        value: options.roleplayNotice || "PTB is a bank ledger for Emergency Hamburg RP. No real money is transferred. Ledger updates are verified and finalized by authorized staff only.",
      },
      ...(Array.isArray(options.extraFields) ? options.extraFields : []),
    ],
    footer: options.footer || PTB_FOOTERS.STANDARD,
    timestamp: options.timestamp,
  });
}

/**
 * Reusable builder for the private Ticket Welcome embed.
 * Posted upon ticket channel creation for the requester and staff.
 * @param {object} options
 * @returns {EmbedBuilder}
 */
export function buildTicketWelcomeEmbed({
  ticket,
  type,
  amount,
  balance,
  requester,
  channelId,
  code,
  color,
  footer,
  ticketTitle,
} = {}) {
  const resolvedType = type || ticket?.kind || "deposit";
  const isDeposit = resolvedType === "deposit";
  const isWithdraw = resolvedType === "withdraw" || resolvedType === "withdrawal";
  const isCustom = Boolean(ticketTitle) || (!isDeposit && !isWithdraw);
  const resolvedCode = code || (ticket ? safeTicketCode({ ...ticket, kind: resolvedType }) : (isWithdraw ? "PTB-W-?" : (isDeposit ? "PTB-D-?" : "PTB-T-?")));
  const resolvedAmount = amount ?? ticket?.amount ?? (isCustom ? null : 0);
  const requesterId = requester?.id || ticket?.requester_id || requester || "unknown";
  const defaultColor = isWithdraw ? PTB_COLORS.WITHDRAW : (isDeposit ? PTB_COLORS.DEPOSIT : PTB_COLORS.PRIMARY);
  const resolvedColor = resolveColor(color, defaultColor);

  let nextStep;
  if (isDeposit) {
    nextStep = "Upload a clear PNG, JPEG, or WebP screenshot of the in-game payment in this channel. PTB will post an advisory receipt analysis here. A screenshot never approves or credits a deposit by itself.";
  } else if (isWithdraw) {
    nextStep = "Tell ticket staff which in-game payout you are requesting. Your balance is not reserved while this ticket is open; staff will verify and deliver the payout before the ledger is debited.";
  } else {
    nextStep = "Tell ticket staff what you need assistance with. A staff member or administrator will assist you in this channel shortly.";
  }
  const staffNote = "Only ticket staff can close this ticket. Administrators review, approve, and finalise ledger movements. Staff can add a helper with `/add-user`.";

  const fields = [
    { name: "Requester", value: `<@${requesterId}>`, inline: true },
  ];

  if (resolvedAmount !== null && Number(resolvedAmount) > 0) {
    fields.push({ name: "Amount", value: `**${Number(resolvedAmount).toLocaleString()}**`, inline: true });
  }

  fields.push(
    { name: "Status", value: "🟡 Pending review", inline: true },
    { name: "Ticket ID", value: `\`${resolvedCode}\``, inline: true },
  );

  if (Number.isFinite(balance) && !isCustom) {
    fields.push({ name: "Balance at opening", value: Number(balance).toLocaleString(), inline: true });
  }

  fields.push(
    { name: "What happens next", value: nextStep },
    { name: "Staff controls", value: staffNote },
  );

  const heading = ticketTitle || (isDeposit ? "Deposit request" : (isWithdraw ? "Withdrawal request" : `${resolvedType.charAt(0).toUpperCase() + resolvedType.slice(1)} request`));

  return buildPtbEmbed({
    color: resolvedColor,
    title: `🎫 ${heading} · ${resolvedCode}`,
    description: "This is a private channel for you, ticket staff, and the PTB bot. Opening a request does **not** change or reserve your balance.",
    fields,
    footer: footer || PTB_FOOTERS.STANDARD,
  });
}

/**
 * Formats a cardinal number as an ordinal string (e.g. 1 -> 1st, 2 -> 2nd).
 * @param {number} n
 * @returns {string}
 */
export function formatOrdinal(n) {
  const num = Math.max(1, Math.floor(Number(n) || 1));
  const j = num % 10;
  const k = num % 100;
  if (j === 1 && k !== 11) return `${num}st`;
  if (j === 2 && k !== 12) return `${num}nd`;
  if (j === 3 && k !== 13) return `${num}rd`;
  return `${num}th`;
}

/**
 * Formats a descriptive label for uploaded screenshots (e.g. "1st image by alice").
 * @param {object} options
 * @param {string} [options.username]
 * @param {number} [options.index]
 * @returns {string}
 */
export function formatImageLabel({ username, index = 1 } = {}) {
  const ordinal = formatOrdinal(index);
  const user = username && String(username).trim() ? String(username).trim() : "user";
  return `${ordinal} image by ${user}`;
}

/**
 * Resolves a human-friendly image label from ticket/embed context.
 * Falls back to "1st image by <username>" rather than displaying raw file names.
 * @param {object} context
 * @returns {string}
 */
export function resolveImageLabel(context = {}) {
  if (context.imageLabel && typeof context.imageLabel === "string" && context.imageLabel.trim()) {
    return context.imageLabel.trim();
  }
  const index = Number(context.imageIndex) || 1;
  const username = context.username
    || context.message?.author?.username
    || context.authorUsername
    || context.claimedPayer
    || context.ticket?.requester_username
    || "user";
  return formatImageLabel({ username, index });
}

/**
 * Reusable builder for deposit receipt analysis embeds.
 * Accepts structured OCR results from the deposit reader and formats a clear,
 * branded presentation strictly distinguishing extracted OCR data from verified status.
 *
 * @param {object} result Structured OCR result or normalized analysis object
 * @param {object} [context] Optional ticket context (ticket, attachment, claimedAmount, etc.)
 * @returns {EmbedBuilder}
 */
export function buildDepositAnalysisEmbed(result, context = {}) {
  const notDetected = "Not detected";

  if (!result || typeof result !== "object") {
    return buildErrorEmbed({
      title: "Deposit receipt analysis · Error",
      description: "No receipt data or OCR results were provided for analysis.\n\n⚠️ **Advisory Notice:** Opening a deposit request does not credit funds. Staff manual review is required.",
      footer: PTB_FOOTERS.ADVISORY_RECEIPT,
    });
  }

  // Handle explicit errors or processing failures gracefully
  if (result.status === "error" || (result.error && !result.fields)) {
    const errorMsg = result.error?.message || result.error || "The uploaded image could not be processed.";
    const code = context.ticket ? safeTicketCode(context.ticket) : (context.ticketCode || null);
    const title = code ? `Deposit receipt analysis · ${code}` : "Deposit receipt analysis · Processing Error";

    const fields = [
      { name: "Verification Status", value: "🟡 Unverified (human review required)", inline: true },
      { name: "OCR Result", value: "❌ Processing failed", inline: true },
    ];
    const imageLabel = resolveImageLabel(context);
    fields.push({ name: "Uploaded Image", value: truncate(imageLabel, DISCORD_LIMITS.FIELD_VALUE), inline: true });

    return buildPtbEmbed({
      color: PTB_COLORS.ERROR,
      title,
      description: `Could not complete screenshot receipt analysis: ${errorMsg}\n\n⚠️ **Advisory Notice:** Automated analysis failed. The deposit ticket is unchanged and requires manual verification by ticket staff before any funds can be credited.`,
      fields,
      footer: PTB_FOOTERS.ADVISORY_RECEIPT,
    });
  }

  const fields = result.fields || {};
  const ocr = result.ocr || {};
  const normalized = context.normalized || {};

  // Extract amount and currency
  const extractedAmount = fields.amount ?? normalized.extractedAmount ?? result.extractedAmount ?? result.amount ?? null;
  const currency = fields.currency ?? result.currency ?? null;
  const claimedAmount = context.claimedAmount ?? context.ticket?.amount ?? result.claimedAmount ?? null;

  // Extract recipient and sender
  const recipient = fields.recipient ?? normalized.extractedRecipient ?? result.extractedRecipient ?? result.recipient ?? null;
  const sender = fields.sender ?? normalized.extractedPayer ?? result.extractedPayer ?? result.sender ?? result.payer ?? null;
  const claimedPayer = context.claimedPayer ?? result.claimedPayer ?? null;

  // Extract transaction identifiers, timestamps, and payment properties
  const transactionId = fields.transactionId ?? normalized.transactionId ?? result.transactionId ?? result.reference ?? null;
  const date = fields.date ?? result.date ?? null;
  const time = fields.time ?? result.time ?? null;
  const paymentStatus = fields.paymentStatus ?? result.paymentStatus ?? null;
  const paymentMethod = fields.paymentMethod ?? result.paymentMethod ?? null;
  const confidence = ocr.confidence ?? result.confidence ?? null;

  const paymentScreenDetected = normalized.paymentScreenDetected
    ?? result.paymentScreenDetected
    ?? (paymentStatus !== null || (extractedAmount !== null && recipient !== null));

  // Determine amount comparison status
  let comparison = normalized.amountComparison ?? result.amountComparison ?? null;
  if (!comparison && extractedAmount !== null && claimedAmount !== null) {
    comparison = Number(extractedAmount) === Number(claimedAmount) ? "MATCH" : "MISMATCH";
  } else if (!comparison) {
    comparison = "NEEDS_REVIEW";
  }

  // Determine findings and duplicates
  const rawFindings = normalized.findings || result.findings || [];
  const findingsList = Array.isArray(rawFindings) ? [...rawFindings] : (rawFindings ? [String(rawFindings)] : []);
  const duplicateRef = context.duplicateReference || result.duplicateReference || null;
  if (duplicateRef && !findingsList.includes("EXACT_SCREENSHOT_DUPLICATE")) {
    findingsList.push("EXACT_SCREENSHOT_DUPLICATE");
  }

  // Format amount display text
  let amountDisplay = notDetected;
  if (extractedAmount !== null && extractedAmount !== undefined) {
    const formattedNum = Number(extractedAmount).toLocaleString();
    const withCurrency = currency ? `${formattedNum} ${currency}` : formattedNum;
    if (claimedAmount !== null && claimedAmount !== undefined) {
      if (comparison === "MATCH") {
        amountDisplay = `${withCurrency} (matches ticket amount)`;
      } else if (comparison === "MISMATCH") {
        amountDisplay = `${withCurrency} (ticket claims ${Number(claimedAmount).toLocaleString()})`;
      } else {
        amountDisplay = withCurrency;
      }
    } else {
      amountDisplay = withCurrency;
    }
  }

  // Format timestamp for Discord <t:timestamp:f>
  let unixTimestamp = null;
  if (date) {
    const dateStr = time ? `${date} ${time}` : date;
    const parsed = Date.parse(dateStr);
    if (!Number.isNaN(parsed)) {
      unixTimestamp = Math.floor(parsed / 1000);
    }
  }
  if (!unixTimestamp) {
    const rawTs = context.timestamp ?? context.message?.createdTimestamp ?? Date.now();
    const parsedTs = typeof rawTs === "number" ? rawTs : Date.parse(rawTs);
    if (!Number.isNaN(parsedTs)) {
      unixTimestamp = Math.floor(parsedTs / 1000);
    }
  }
  const timeDisplay = unixTimestamp ? `<t:${unixTimestamp}:f>` : notDetected;

  // Format confidence
  const confidenceDisplay = (Number.isFinite(confidence) && confidence > 0)
    ? `${confidence}%`
    : notDetected;

  // Select color: warning for discrepancies, duplicates, or unreadable screenshots; primary green for clean checks
  const isWarning = findingsList.length > 0
    || duplicateRef
    || comparison === "MISMATCH"
    || result.status === "partial"
    || result.status === "unreadable";
  const embedColor = isWarning ? PTB_COLORS.WARNING : PTB_COLORS.DEPOSIT;

  // Determine title
  const code = context.ticket ? safeTicketCode(context.ticket) : (context.ticketCode || null);
  const title = code ? `Deposit receipt analysis · ${code}` : "Deposit receipt analysis";

  // Ticket opener's connected Roblox account takes priority for Sender
  const senderDisplay = claimedPayer
    || context.ticket?.requester_roblox_username
    || context.ticket?.roblox_username
    || result.claimedPayer
    || sender
    || notDetected;

  // Direct fields only: Amount, Recipient, Sender, Time, Confidence
  const embedFields = [
    { name: "Amount", value: truncate(amountDisplay, DISCORD_LIMITS.FIELD_VALUE), inline: true },
    { name: "Recipient", value: truncate(recipient || notDetected, DISCORD_LIMITS.FIELD_VALUE), inline: true },
    { name: "Sender", value: truncate(senderDisplay, DISCORD_LIMITS.FIELD_VALUE), inline: true },
    { name: "Time", value: truncate(timeDisplay, DISCORD_LIMITS.FIELD_VALUE), inline: true },
    { name: "Confidence", value: truncate(confidenceDisplay, DISCORD_LIMITS.FIELD_VALUE), inline: true },
  ];

  return buildPtbEmbed({
    color: embedColor,
    title,
    description: "The automated checks are advisory and still in beta testing.",
    fields: embedFields,
    footer: PTB_FOOTERS.ADVISORY_RECEIPT,
  });
}

// Aliases for compatibility with other ticket/treasury submodules
export const buildDepositReceiptEmbed = buildDepositAnalysisEmbed;
export const buildReceiptAnalysisEmbed = buildDepositAnalysisEmbed;
export const buildReceiptEmbed = buildDepositAnalysisEmbed;

/**
 * Reusable builder for staff notifications and audit events.
 * @param {object} options
 * @returns {EmbedBuilder}
 */
export function buildStaffNotificationEmbed({
  action,
  title,
  ticket,
  actor,
  actorId,
  requester,
  requesterId,
  amount,
  reason,
  details,
  statusBefore,
  statusAfter,
  severity,
  fields = [],
  color,
  footer,
} = {}) {
  const resolvedActor = actor || (actorId ? `<@${actorId}>` : "system");
  const reference = ticket ? safeTicketCode(ticket) : (ticket?.code || null);

  const actionTitles = {
    TICKET_OPENED: "Ticket opened",
    TICKET_APPROVED: "Ticket approved",
    TICKET_REJECTED: "Ticket rejected",
    TICKET_COMPLETED: "Ticket completed",
    TICKET_CLOSED: "Ticket closed",
    TICKET_USER_ADDED: "Ticket helper added",
    TICKET_ACTION_DENIED: "Ticket action denied",
    RECEIPT_ANALYSIS_FAILED: "Receipt analysis failed",
    RECEIPT_ANALYSIS_POSTED: "Receipt analysis posted",
    TREASURY_SUBMITTED: "Treasury submission received",
    TREASURY_VERIFIED: "Treasury payment verified",
    TREASURY_REJECTED: "Treasury payment rejected",
  };

  const actionColors = {
    TICKET_OPENED: PTB_COLORS.INFO,
    TICKET_APPROVED: PTB_COLORS.SUCCESS,
    TICKET_REJECTED: PTB_COLORS.ERROR,
    TICKET_COMPLETED: PTB_COLORS.PRIMARY,
    TICKET_CLOSED: PTB_COLORS.MUTED,
    TICKET_USER_ADDED: PTB_COLORS.WITHDRAW,
    TICKET_ACTION_DENIED: PTB_COLORS.WARNING,
    RECEIPT_ANALYSIS_FAILED: PTB_COLORS.WARNING,
    RECEIPT_ANALYSIS_POSTED: 0x0891B2,
  };

  const resolvedTitle = title || (action ? (actionTitles[action] || action) : "Staff Notification");
  let defaultColor = action ? (actionColors[action] || PTB_COLORS.PRIMARY) : PTB_COLORS.PRIMARY;
  if (severity === "error" || severity === "critical") defaultColor = PTB_COLORS.ERROR;
  else if (severity === "warning") defaultColor = PTB_COLORS.WARNING;
  else if (severity === "success") defaultColor = PTB_COLORS.SUCCESS;

  const resolvedColor = resolveColor(color, defaultColor);
  const embedFields = [];

  if (reference) {
    embedFields.push({ name: "Ticket", value: `\`${reference}\``, inline: true });
  }

  embedFields.push({ name: "Actor", value: resolvedActor, inline: true });

  const resolvedRequester = requester || (requesterId || ticket?.requester_id ? `<@${requesterId || ticket.requester_id}>` : null);
  if (resolvedRequester) {
    embedFields.push({ name: "Requester", value: resolvedRequester, inline: true });
  }

  const resolvedAmount = amount ?? ticket?.amount ?? null;
  if (resolvedAmount !== null && resolvedAmount !== undefined) {
    embedFields.push({ name: "Amount", value: Number(resolvedAmount).toLocaleString(), inline: true });
  }

  if (statusBefore) {
    embedFields.push({ name: "Previous status", value: statusBefore, inline: true });
  }

  if (statusAfter) {
    embedFields.push({ name: "New status", value: statusAfter, inline: true });
  }

  if (reason) {
    embedFields.push({ name: "Reason", value: truncate(reason, DISCORD_LIMITS.FIELD_VALUE) });
  }

  if (details) {
    embedFields.push({ name: "Details", value: truncate(details, DISCORD_LIMITS.FIELD_VALUE) });
  }

  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (f && (f.name || f.value)) {
        embedFields.push({
          name: truncate(f.name || "\u200B", DISCORD_LIMITS.FIELD_NAME),
          value: truncate(f.value || "\u200B", DISCORD_LIMITS.FIELD_VALUE),
          inline: Boolean(f.inline),
        });
      }
    }
  }

  return buildPtbEmbed({
    color: resolvedColor,
    title: `🛡️ Staff Notice | ${resolvedTitle}`,
    fields: embedFields,
    footer: footer || PTB_FOOTERS.AUDIT_LOG,
  });
}

/**
 * Reusable builder for ticket closure summaries and final records.
 * @param {object} options
 * @returns {EmbedBuilder}
 */
export function buildTicketClosureSummaryEmbed({
  ticket,
  closedBy,
  actorId,
  reason,
  statusBefore,
  finalStatus,
  transcript,
  transcriptUnavailableReason,
  ledgerId,
  color,
  footer,
} = {}) {
  const code = ticket ? safeTicketCode(ticket) : (ticket?.code || "unknown ticket");
  const kind = ticket?.kind || "ticket";
  const amount = ticket?.amount ? Number(ticket.amount).toLocaleString() : null;
  const actor = closedBy || actorId || "system";
  const actorMention = actor === "system" ? "system" : `<@${actor}>`;
  const requester = ticket?.requester_id ? `<@${ticket.requester_id}>` : "unknown";

  const resolvedStatus = finalStatus || (ticket?.status === "completed" ? "completed" : "closed");
  let defaultColor = PTB_COLORS.MUTED;
  if (resolvedStatus === "completed") defaultColor = PTB_COLORS.SUCCESS;
  else if (resolvedStatus === "rejected") defaultColor = PTB_COLORS.ERROR;

  const resolvedColor = resolveColor(color, defaultColor);

  const fields = [
    { name: "Ticket", value: `\`${code}\``, inline: true },
    { name: "Type", value: kind.charAt(0).toUpperCase() + kind.slice(1), inline: true },
    { name: "Requester", value: requester, inline: true },
    { name: "Closed by", value: actorMention, inline: true },
    { name: "Previous status", value: statusBefore || ticket?.status || "pending", inline: true },
    { name: "Final status", value: resolvedStatus, inline: true },
  ];

  if (amount) {
    fields.push({ name: "Amount", value: `**${amount}**`, inline: true });
  }

  if (ledgerId) {
    fields.push({ name: "Ledger Entry", value: `#${ledgerId}`, inline: true });
  }

  if (reason) {
    fields.push({ name: "Closure reason", value: truncate(reason, DISCORD_LIMITS.FIELD_VALUE) });
  }

  if (transcript?.name || transcript?.buffer) {
    fields.push({ name: "Transcript", value: `📄 Attached: \`${transcript.name || "ticket-transcript.txt"}\`` });
  } else if (transcriptUnavailableReason) {
    fields.push({ name: "Transcript", value: `⚠️ ${truncate(transcriptUnavailableReason, DISCORD_LIMITS.FIELD_VALUE)}` });
  }

  const financialNote = resolvedStatus === "completed"
    ? "Funds were moved and recorded in the ledger."
    : "No balances were changed or reserved upon closure.";

  fields.push({ name: "Financial outcome", value: financialNote });

  return buildPtbEmbed({
    color: resolvedColor,
    title: `Ticket closed · ${code}`,
    description: `Ticket \`${code}\` has been closed and archived.`,
    fields,
    footer: footer || "Pacific Trust Bank • Ticket Audit Record",
  });
}

// Alias for ticket closure embed
export const buildTicketClosureEmbed = buildTicketClosureSummaryEmbed;

/**
 * Validate options for custom administrator embeds.
 * Checks required fields, lengths, URLs, color syntax, and field limits.
 *
 * @param {object} options
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCustomEmbedOptions(options) {
  const errors = [];
  if (!options || typeof options !== "object") {
    return { valid: false, errors: ["Embed options must be an object."] };
  }

  if (!options.title || typeof options.title !== "string" || !options.title.trim()) {
    errors.push("Title is required and must be non-empty.");
  } else if (options.title.trim().length > DISCORD_LIMITS.TITLE) {
    errors.push(`Title exceeds Discord maximum limit of ${DISCORD_LIMITS.TITLE} characters.`);
  }

  if (!options.description || typeof options.description !== "string" || !options.description.trim()) {
    errors.push("Description is required and must be non-empty.");
  } else if (options.description.trim().length > DISCORD_LIMITS.DESCRIPTION) {
    errors.push(`Description exceeds Discord maximum limit of ${DISCORD_LIMITS.DESCRIPTION} characters.`);
  }

  if (options.color !== undefined && options.color !== null && options.color !== "") {
    if (typeof options.color === "string") {
      const trimmed = options.color.trim();
      const isHex = /^(?:#|0x)?[0-9a-f]{6}$/i.test(trimmed);
      const isNamed = ["primary", "deposit", "withdraw", "success", "warning", "error", "info", "muted", "neutral"].includes(trimmed.toLowerCase());
      if (!isHex && !isNamed) {
        errors.push(`Color '${options.color}' is invalid. Provide a 6-digit hex code (e.g. #0B3D2E) or a valid color name.`);
      }
    } else if (typeof options.color === "number") {
      if (!Number.isFinite(options.color) || options.color < 0 || options.color > 0xFFFFFF) {
        errors.push("Numeric color must be between 0 and 16,777,215 (0xFFFFFF).");
      }
    } else {
      errors.push("Color must be a hex string or number.");
    }
  }

  if (options.url !== undefined && options.url !== null && options.url !== "") {
    if (!isValidHttpUrl(options.url)) {
      errors.push("URL must be a valid absolute HTTP or HTTPS URL.");
    }
  }

  if (options.thumbnail !== undefined && options.thumbnail !== null && options.thumbnail !== "") {
    if (!isValidHttpUrl(options.thumbnail)) {
      errors.push("Thumbnail must be a valid absolute HTTP or HTTPS URL.");
    }
  }

  if (options.image !== undefined && options.image !== null && options.image !== "") {
    if (!isValidHttpUrl(options.image)) {
      errors.push("Image must be a valid absolute HTTP or HTTPS URL.");
    }
  }

  if (options.footer !== undefined && options.footer !== null) {
    if (String(options.footer).length > DISCORD_LIMITS.FOOTER) {
      errors.push(`Footer exceeds Discord maximum limit of ${DISCORD_LIMITS.FOOTER} characters.`);
    }
  }

  if (options.fields !== undefined && options.fields !== null) {
    if (!Array.isArray(options.fields)) {
      errors.push("Fields must be an array.");
    } else {
      if (options.fields.length > DISCORD_LIMITS.FIELDS) {
        errors.push(`Fields count (${options.fields.length}) exceeds Discord maximum of ${DISCORD_LIMITS.FIELDS}.`);
      }
      options.fields.forEach((field, index) => {
        if (!field || typeof field !== "object") {
          errors.push(`Field #${index + 1} must be an object with name and value.`);
        } else {
          if (!field.name || !String(field.name).trim()) {
            errors.push(`Field #${index + 1} name is required.`);
          } else if (String(field.name).length > DISCORD_LIMITS.FIELD_NAME) {
            errors.push(`Field #${index + 1} name exceeds limit of ${DISCORD_LIMITS.FIELD_NAME} characters.`);
          }

          if (!field.value || !String(field.value).trim()) {
            errors.push(`Field #${index + 1} value is required.`);
          } else if (String(field.value).length > DISCORD_LIMITS.FIELD_VALUE) {
            errors.push(`Field #${index + 1} value exceeds limit of ${DISCORD_LIMITS.FIELD_VALUE} characters.`);
          }
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Builder for custom administrator server embeds.
 * Enforces permissions, validates colors, URLs, and limits.
 *
 * @param {object} options
 * @param {boolean} [strict=false] If true, throws Error on validation failure
 * @returns {EmbedBuilder}
 */
export function buildCustomEmbed(options, strict = false) {
  const validation = validateCustomEmbedOptions(options);
  if (!validation.valid && strict) {
    throw new Error(`Custom embed validation failed: ${validation.errors.join("; ")}`);
  }

  const color = resolveColor(options?.color, PTB_COLORS.PRIMARY);
  return buildPtbEmbed({
    ...options,
    color,
    footer: options?.footer || PTB_FOOTERS.STANDARD,
  });
}

/**
 * Creates the slash command specification for `/server-embed`.
 * Requires Discord Administrator permissions by default.
 * @returns {SlashCommandBuilder}
/**
 * Converts hex color strings (#5865F2, 0x5865F2, 5865F2) into numeric integers.
 * Defaults to Discord Blurple (0x5865F2) if empty.
 * @param {string|number|null|undefined} value
 * @returns {number}
 */
export function parseEmbedColor(value) {
  if (!value) return 0x5865F2;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  const raw = String(value).trim();
  const normalized = raw.replace(/^#/, "").replace(/^0x/i, "");
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    // If it's a known named theme color, resolve it gracefully
    const named = resolveColor(raw, null);
    if (named !== null && named !== PTB_COLORS.PRIMARY) return named;
    throw new Error("Color must be a six-digit hex value, such as #5865F2.");
  }

  return parseInt(normalized, 16);
}

/**
 * Validates that the provided image URL has a valid syntax and uses http/https.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function validateImageUrl(value) {
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Image URL must be a valid http:// or https:// URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Image URL must begin with http:// or https://.");
  }

  return url.toString();
}

/**
 * Resolves an image or website URL into a valid image URL for Discord embeds.
 * If the URL points to a website homepage or HTML document (e.g. https://roblox.com,
 * https://github.com), it extracts opengraph/twitter images or link favicons, or
 * falls back to Google's high-res favicon service (256px), ensuring Discord never
 * leaves the thumbnail or embed image blank.
 *
 * @param {string|null|undefined} urlString
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<string|null>}
 */
export async function resolveWebsiteThumbnail(urlString, timeoutMs = 3000) {
  if (!urlString || typeof urlString !== "string") return null;
  const trimmed = urlString.trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  // If already a direct image extension, return as is
  if (/\.(?:png|jpe?g|gif|webp|svg|bmp|ico)(?:\?.*)?$/i.test(parsed.pathname)) {
    return trimmed;
  }

  // If it is a known Discord CDN attachment, return directly
  if (parsed.hostname.endsWith("discordapp.com") || parsed.hostname.endsWith("discordapp.net")) {
    return trimmed;
  }

  const fallbackFavicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=256`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(trimmed, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 PTB-EmbedResolver/1.0",
        "Accept": "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
      },
    }).catch(() => null);

    clearTimeout(timer);

    if (response && response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.toLowerCase().startsWith("image/")) {
        return trimmed;
      }

      // Read initial chunk of HTML text
      const text = await response.text();

      // Look for og:image or twitter:image
      const ogMatch = text.match(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ||
                      text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["']/i);

      if (ogMatch && ogMatch[1]) {
        try {
          const resolved = new URL(ogMatch[1], parsed.origin).href;
          if (["http:", "https:"].includes(new URL(resolved).protocol)) {
            return resolved;
          }
        } catch {
          // invalid og:image URL, continue to favicon
        }
      }

      // Look for favicon or icon link
      const iconMatch = text.match(/<link[^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]+href=["']([^"']+)["']/i) ||
                        text.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["']/i);

      if (iconMatch && iconMatch[1]) {
        try {
          const resolved = new URL(iconMatch[1], parsed.origin).href;
          if (["http:", "https:"].includes(new URL(resolved).protocol)) {
            return resolved;
          }
        } catch {
          // continue to fallback
        }
      }
    }
  } catch {
    // on network or parsing error, fallback gracefully
  }

  return fallbackFavicon;
}

/**
 * Truncates and sanitizes embed fields to fit within Discord boundaries.
 * Discord Limits:
 * - Title: 256 chars
 * - Description: 4096 chars
 * - Field Name: 256 chars
 * - Field Value: 1024 chars
 * - Max Fields: 25 fields
 * @param {object} embed
 * @returns {object}
 */
export function sanitizeEmbed(embed) {
  if (!embed) return embed;
  if (embed.title && embed.title.length > 256) {
    embed.title = embed.title.slice(0, 253) + "...";
  }
  if (embed.description && embed.description.length > 4096) {
    embed.description = embed.description.slice(0, 4093) + "...";
  }
  if (Array.isArray(embed.fields)) {
    const safeFields = [];
    for (const f of embed.fields) {
      if (safeFields.length >= 25) break;
      const name = (f.name || "Field").slice(0, 256);
      const val = String(f.value || "None");
      if (val.length <= 1024) {
        safeFields.push({ name, value: val, inline: Boolean(f.inline) });
      } else {
        let remaining = val;
        let part = 1;
        while (remaining.length > 0 && safeFields.length < 25) {
          const chunk = remaining.slice(0, 1000);
          remaining = remaining.slice(1000);
          safeFields.push({
            name: part === 1 ? name : `${name} (Cont. ${part})`.slice(0, 256),
            value: chunk,
            inline: false,
          });
          part++;
        }
      }
    }
    embed.fields = safeFields.slice(0, 25);
  }
  return embed;
}

/**
 * Splits lists of lines across multiple fields so no individual field exceeds 1024 characters.
 * @param {Array<object>} fields Target array to push chunked fields into
 * @param {string} baseName Base field name
 * @param {Array<string>} lines Lines to format into chunks
 * @param {string} [separator="\n\n"] Chunk separator
 * @param {number} [maxChunkLength=1000] Maximum length before splitting
 */
export function addSafeChunkedFields(fields, baseName, lines, separator = "\n\n", maxChunkLength = 1000) {
  if (!lines || lines.length === 0) return;
  let currentChunk = "";
  let part = 1;

  for (const rawLine of lines) {
    const line = String(rawLine).slice(0, maxChunkLength);
    const toAdd = currentChunk ? `${currentChunk}${separator}${line}` : line;

    if (toAdd.length > maxChunkLength) {
      if (currentChunk) {
        fields.push({
          name: part === 1 ? baseName : `${baseName} (Part ${part})`.slice(0, 256),
          value: currentChunk.slice(0, 1024),
          inline: false,
        });
        part++;
        currentChunk = line;
      } else {
        fields.push({
          name: part === 1 ? baseName : `${baseName} (Part ${part})`.slice(0, 256),
          value: line.slice(0, 1024),
          inline: false,
        });
        part++;
        currentChunk = "";
      }
    } else {
      currentChunk = toAdd;
    }

    if (fields.length >= 24) break;
  }

  if (currentChunk && fields.length < 25) {
    fields.push({
      name: part === 1 ? baseName : `${baseName} (Part ${part})`.slice(0, 256),
      value: currentChunk.slice(0, 1024),
      inline: false,
    });
  }
}

/**
 * Parses user input for dropdown select menu options.
 * Accepts newline-separated, pipe-separated ("Label | Description"),
 * or comma-separated items.
 *
/**
 * SQLite/LibSQL schema for persisting custom interactive embed dropdown option responses.
 */
export const embedDropdownSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS embed_dropdown_options (
    id TEXT PRIMARY KEY,
    custom_id TEXT NOT NULL,
    option_value TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    response_message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_embed_dropdown_lookup
    ON embed_dropdown_options (custom_id, option_value)`,
];

/**
 * In-memory cache for fast lookup of custom response messages for interactive dropdown choices.
 */
export const dropdownCustomResponses = new Map();

/**
 * Persists custom response messages for dropdown options to memory cache and database.
 *
 * @param {any} db
 * @param {string} customId
 * @param {Array<{ value: string, label: string, description?: string, responseMessage?: string }>} options
 */
export async function saveDropdownOptionResponses(db, customId, options = []) {
  if (!Array.isArray(options)) return;
  for (const opt of options) {
    if (opt.responseMessage) {
      const msg = String(opt.responseMessage).trim();
      dropdownCustomResponses.set(`${customId}:${opt.value}`, msg);
      dropdownCustomResponses.set(opt.value, msg);

      if (db && typeof db.execute === "function") {
        try {
          const id = `${customId}:${opt.value}`;
          await db.execute({
            sql: `INSERT OR REPLACE INTO embed_dropdown_options (id, custom_id, option_value, label, description, response_message)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [id, customId, opt.value, opt.label, opt.description || null, msg],
          });
        } catch (err) {
          console.warn("[PTB Embed] Could not persist dropdown option response to DB:", err?.message ?? err);
        }
      }
    }
  }
}

/**
 * Parses a single option entry into label, description, and custom response message.
 * Supports:
 * - "Label | Description | Custom Message"
 * - "Label | reply: Custom Message"
 * - Multi-line blocks (Line 1: Label, Line 2: Description, Line 3+: Custom Message)
 * - "Label - Description" or "Label: Description"
 *
 * @param {string} rawText
 * @param {number} [index=1]
 * @returns {{ label: string, value: string, description?: string, emoji?: string, responseMessage?: string } | null}
 */
export function parseSingleOption(rawText, index = 1) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return null;

  let label = trimmed;
  let description = null;
  let responseMessage = null;
  let emoji = null;

  if (trimmed.includes("|")) {
    const parts = trimmed.split("|").map((p) => p.trim());
    label = parts[0] || `Option ${index}`;
    if (parts.length >= 3) {
      description = parts[1] || null;
      responseMessage = parts.slice(2).join(" | ").trim() || null;
    } else if (parts.length === 2) {
      const msgMatch = parts[1].match(/^(?:reply|response|message|msg)\s*[:=]\s*(.+)$/is);
      if (msgMatch) {
        responseMessage = msgMatch[1].trim();
        description = responseMessage.slice(0, 100);
      } else {
        description = parts[1] || null;
      }
    }
  } else if (trimmed.includes("\n")) {
    const sublines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
    label = sublines[0] || `Option ${index}`;
    if (sublines.length === 2) {
      description = sublines[1];
    } else if (sublines.length >= 3) {
      description = sublines[1];
      responseMessage = sublines.slice(2).join("\n").trim();
    }
  } else if (trimmed.includes(" - ")) {
    const parts = trimmed.split(" - ").map((p) => p.trim());
    label = parts[0] || `Option ${index}`;
    description = parts[1] || null;
  } else if (trimmed.includes(": ") && !trimmed.startsWith("http")) {
    const parts = trimmed.split(": ").map((p) => p.trim());
    label = parts[0] || `Option ${index}`;
    description = parts[1] || null;
  }

  // Extract leading emoji from label if present
  const emojiMatch = label.match(/^(\p{Extended_Pictographic})\s*(.*)$/u);
  if (emojiMatch) {
    emoji = emojiMatch[1];
    label = emojiMatch[2] || label;
  }

  label = label.slice(0, 100);
  if (description) description = description.slice(0, 100);
  const sanitizedVal = label.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80);
  const value = `opt_${index}_${sanitizedVal || "item"}`.slice(0, 100);

  return {
    label,
    value,
    description: description || undefined,
    emoji: emoji || undefined,
    responseMessage: responseMessage || undefined,
  };
}

/**
 * Parses raw text or an array of strings into select menu option objects with optional custom responses.
 *
 * @param {string|string[]} rawInput
 * @returns {Array<{ label: string, value: string, description?: string, emoji?: string, responseMessage?: string }>}
 */
export function parseDropdownOptions(rawInput) {
  if (!rawInput) return [];

  const options = [];
  let extractedPlaceholder = null;
  let index = 1;

  if (Array.isArray(rawInput)) {
    for (const item of rawInput) {
      if (options.length >= 25) break;
      const parsed = parseSingleOption(item, index);
      if (parsed) {
        options.push(parsed);
        index++;
      }
    }
    return options;
  }

  if (typeof rawInput !== "string") return [];

  const lines = rawInput.includes("\n")
    ? rawInput.split("\n")
    : rawInput.split(/[,;]/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Optional first-line placeholder configuration (e.g. "Placeholder: Select service")
    const placeholderMatch = trimmed.match(/^(?:placeholder|prompt)\s*[:=]\s*(.+)$/i);
    if (placeholderMatch && !extractedPlaceholder && options.length === 0) {
      extractedPlaceholder = placeholderMatch[1].trim().slice(0, 150);
      continue;
    }

    if (options.length >= 25) break; // Discord maximum options per select menu

    const parsed = parseSingleOption(trimmed, index);
    if (parsed) {
      options.push(parsed);
      index++;
    }
  }

  if (extractedPlaceholder) {
    options.placeholder = extractedPlaceholder;
  }

  return options;
}

/**
 * Builds a Discord ActionRow containing a StringSelectMenuBuilder.
 *
 * @param {object} [params]
 * @param {string} [params.customId="server-embed-dropdown"]
 * @param {string} [params.placeholder="Select an option..."]
 * @param {Array<{ label: string, value: string, description?: string, emoji?: string }>} [params.options=[]]
 * @returns {ActionRowBuilder|null}
 */
export function buildDropdownComponent({
  customId = "server-embed-dropdown",
  placeholder = "Select an option...",
  options = [],
} = {}) {
  if (!Array.isArray(options) || options.length === 0) return null;

  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder((placeholder || "Select an option...").slice(0, 150))
    .setMinValues(1)
    .setMaxValues(1);

  for (const opt of options.slice(0, 25)) {
    const optionBuilder = new StringSelectMenuOptionBuilder()
      .setLabel(String(opt.label || "Option").slice(0, 100))
      .setValue(String(opt.value || `opt_${Math.random()}`).slice(0, 100));

    if (opt.description) {
      optionBuilder.setDescription(String(opt.description).slice(0, 100));
    }
    if (opt.emoji) {
      optionBuilder.setEmoji(opt.emoji);
    }
    select.addOptions(optionBuilder);
  }

  return new ActionRowBuilder().addComponents(select);
}

/**
 * Builds Discord ActionRow(s) containing ButtonBuilders for ticket options.
 * Each button opens a ticket in the exact same way as the default system,
 * carrying the ticket option name in the channel name and embed.
 *
 * @param {Array<{ label: string, value?: string, description?: string, emoji?: string }>} [options=[]]
 * @returns {Array<ActionRowBuilder>}
 */
export function buildTicketButtonsComponent(options = []) {
  if (!Array.isArray(options) || options.length === 0) return [];

  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (let i = 0; i < options.length && i < 25; i++) {
    const opt = options[i];
    const label = String(opt.label || `Ticket ${i + 1}`).trim().slice(0, 80);
    const sanitizedVal = label.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `btn_${i + 1}`;
    const customId = `server-embed-ticket-open:${sanitizedVal}:${encodeURIComponent(label).slice(0, 40)}`;

    let style = ButtonStyle.Primary;
    if (/\b(deposit|receipt|verify|approved?)\b/i.test(label)) {
      style = ButtonStyle.Success;
    } else if (/\b(urgent|emergency|report|fraud|danger)\b/i.test(label)) {
      style = ButtonStyle.Danger;
    } else if (/\b(info|help|faq|guide)\b/i.test(label)) {
      style = ButtonStyle.Secondary;
    }

    const button = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(style);

    let emoji = opt.emoji;
    if (!emoji) {
      const emojiMatch = label.match(/^(\p{Extended_Pictographic})/u) ||
                         (opt.description && opt.description.match(/(\p{Extended_Pictographic})/u));
      if (emojiMatch) {
        emoji = emojiMatch[1];
      }
    }
    if (emoji) {
      try {
        button.setEmoji(emoji);
      } catch {}
    }

    currentRow.addComponents(button);

    if (currentRow.components.length === 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }

  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Storage for pending dropdown and ticket modal configuration sessions.
 */
export const pendingEmbedModalConfigs = new Map();

/**
 * Slash command definition for /server-embed with dropdown and ticket buttons support.
 * Debloated, streamlined options without redundant fields, options text, or channel selectors.
 */
export const serverEmbedCommand = new SlashCommandBuilder()
  .setName("server-embed")
  .setDescription("Admin: Post a custom rich embed in this channel")
  .addStringOption((o) =>
    o.setName("title")
      .setDescription("Embed title")
      .setRequired(true)
      .setMaxLength(256))
  .addStringOption((o) =>
    o.setName("description")
      .setDescription("Embed description")
      .setRequired(false)
      .setMaxLength(4096))
  .addStringOption((o) =>
    o.setName("function")
      .setDescription("Embed functionality (select 'dropdown' or 'ticket')")
      .setRequired(false)
      .addChoices(
        { name: "dropdown", value: "dropdown" },
        { name: "ticket", value: "ticket" },
      ))
  .addStringOption((o) =>
    o.setName("color")
      .setDescription("Hex color, for example #5865F2")
      .setRequired(false)
      .setMaxLength(30))
  .addAttachmentOption((o) =>
    o.setName("image_file")
      .setDescription("Upload an image file directly (PNG, JPG, WebP, GIF)")
      .setRequired(false))
  .addStringOption((o) =>
    o.setName("image_url")
      .setDescription("Image URL or website link (auto-resolves thumbnail)")
      .setRequired(false)
      .setMaxLength(2048))
  .addStringOption((o) =>
    o.setName("thumbnail")
      .setDescription("Thumbnail image or website URL (small icon in top right)")
      .setRequired(false)
      .setMaxLength(2048))
  .addStringOption((o) =>
    o.setName("footer")
      .setDescription("Footer text")
      .setRequired(false)
      .setMaxLength(2048))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

/**
 * Creates the slash command specification for `/server-embed`.
 * Requires Discord Administrator permissions by default.
 * @returns {SlashCommandBuilder}
 */
export function createServerEmbedCommand() {
  return serverEmbedCommand;
}

/**
 * Handles `/server-embed` command execution.
 * Enforces administrator permissions, validates all inputs, and delivers the embed
 * directly in the current channel. If function:dropdown is selected, asks for the
 * number of options so dynamic modal fields can be generated.
 * Supports direct file uploads (image_file) and automatic website thumbnail resolution.
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleServerEmbedCommand(interaction) {
  // 1. Double-check administrator permissions server-side
  const hasAdmin = Boolean(
    interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );

  if (!hasAdmin) {
    const errorPayload = {
      content: "# Access Denied\nOnly server administrators can use the `/server-embed` command.\n-# Pacific Trust Bank • Staff Administration",
      flags: MessageFlags.Ephemeral,
    };
    if (typeof interaction.reply === "function") {
      await interaction.reply(errorPayload);
    }
    return;
  }

  const title = interaction.options.getString("title");
  const description = interaction.options.getString("description");
  const colorInput = interaction.options.getString("color");
  const imageUrlInput = interaction.options.getString("image_url") || interaction.options.getString?.("image");
  const imageFileInput = interaction.options.getAttachment?.("image_file")
    || interaction.options.getAttachment?.("file")
    || interaction.options.getAttachment?.("image");
  const thumbnailInput = interaction.options.getString?.("thumbnail")
    || interaction.options.getString?.("thumbnail_url");
  const footerText = interaction.options.getString("footer");
  const functionChoice = interaction.options.getString?.("function");
  const optionsRaw = interaction.options.getString?.("options") || interaction.options.getString?.("dropdown_options");

  // Validate color
  let color;
  try {
    color = parseEmbedColor(colorInput);
  } catch (err) {
    const errorMsg = `⚠️ ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  // Handle uploaded image file or image URL with website thumbnail resolution
  let imageUrl = null;
  let imageAttachment = null;
  if (imageFileInput && imageFileInput.url) {
    imageUrl = imageFileInput.url;
    imageAttachment = {
      attachment: imageFileInput.url,
      name: imageFileInput.name || "image.png",
    };
  } else if (imageUrlInput) {
    try {
      validateImageUrl(imageUrlInput);
      imageUrl = await resolveWebsiteThumbnail(imageUrlInput);
    } catch (err) {
      const errorMsg = `⚠️ ${err.message}`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: errorMsg });
      }
      return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    }
  }

  // Handle thumbnail URL with website thumbnail resolution
  let thumbnailUrl = null;
  if (thumbnailInput) {
    try {
      validateImageUrl(thumbnailInput);
      thumbnailUrl = await resolveWebsiteThumbnail(thumbnailInput);
    } catch (err) {
      const errorMsg = `⚠️ Thumbnail: ${err.message}`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: errorMsg });
      }
      return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    }
  }

  // 2. If function:dropdown or function:ticket is chosen and no pre-supplied options:
  // Ask for the number of options so it creates fields dynamically!
  const isTicketMode = functionChoice === "ticket";
  if ((functionChoice === "dropdown" || isTicketMode) && !optionsRaw) {
    const token = Math.random().toString(36).slice(2, 10);
    pendingEmbedModalConfigs.set(token, {
      mode: isTicketMode ? "ticket" : "dropdown",
      functionChoice,
      embedData: {
        title,
        description,
        color: colorInput,
        imageUrl,
        thumbnailUrl,
        imageAttachment,
        footerText,
      },
      channelId: interaction.channelId || interaction.channel?.id,
      createdAt: Date.now(),
      adminId: interaction.user?.id,
    });

    const promptTitle = isTicketMode ? "# Configure Ticket Buttons" : "# Configure Dropdown Menu";
    const promptSub = isTicketMode
      ? `How many ticket options would you like for **${title}**?\n-# Select the number of ticket buttons below. A modal will open with dedicated fields for each ticket button.`
      : `How many options would you like in the dropdown for **${title}**?\n-# Select the number of options below. A modal will open with dedicated fields for each option.`;
    const promptContent = `${promptTitle}\n${promptSub}`;
    const countRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`embed-opts-count:${token}:1`).setLabel("1 Option").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`embed-opts-count:${token}:2`).setLabel("2 Options").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`embed-opts-count:${token}:3`).setLabel("3 Options").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`embed-opts-count:${token}:4`).setLabel("4 Options").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`embed-opts-count:${token}:5`).setLabel("5 Options").setStyle(ButtonStyle.Primary),
    );

    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: promptContent, components: [countRow] });
    }
    return interaction.reply({ content: promptContent, components: [countRow], flags: MessageFlags.Ephemeral });
  }

  // Defer reply if available and not already acknowledged
  if (typeof interaction.deferReply === "function" && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply().catch(() => {});
  }

  // 3. Assemble the embed object
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color);

  if (description) embed.setDescription(description);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (imageUrl) embed.setImage(imageUrl);
  if (footerText) embed.setFooter({ text: footerText });

  const files = imageAttachment ? [imageAttachment] : [];

  // 4. Build dropdown or ticket buttons component if options are provided
  let components = [];
  if (optionsRaw) {
    const parsedOptions = parseDropdownOptions(optionsRaw);
    if (parsedOptions.length > 0) {
      if (functionChoice === "ticket") {
        const rows = buildTicketButtonsComponent(parsedOptions);
        if (rows?.length > 0) components.push(...rows);
      } else {
        const menuId = Math.random().toString(36).slice(2, 10);
        const dropdownCustomId = `server-embed-dropdown:${menuId}`;
        const placeholder = parsedOptions.placeholder || "Select an option...";
        const row = buildDropdownComponent({
          customId: dropdownCustomId,
          placeholder,
          options: parsedOptions,
        });
        if (row) components.push(row);
        void saveDropdownOptionResponses(interaction.client?.db || null, dropdownCustomId, parsedOptions);
      }
    }
  }

  // 5. Send the embed directly in the current channel (no channel parameter)
  if (interaction.channel && typeof interaction.channel.send === "function" && !interaction.deferred && !interaction.replied) {
    try {
      await interaction.channel.send({ embeds: [embed], components, files });
      return interaction.reply({
        content: `# Embed Published\nEmbed successfully posted in <#${interaction.channel.id}>.\n-# Pacific Trust Bank • Staff Administration`,
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      // Fall through to editReply / reply
    }
  }

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed], components, files });
  }
  return interaction.reply({ embeds: [embed], components, files });
}

/**
 * Handles button clicks when the administrator selects how many options to configure.
 * Dynamically builds a Discord modal with fields for each option.
 *
 * @param {import("discord.js").ButtonInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleServerEmbedOptionCountClick(interaction) {
  const parts = interaction.customId.split(":");
  const token = parts[1];
  const count = Math.min(5, Math.max(1, parseInt(parts[2], 10) || 1));

  const pending = pendingEmbedModalConfigs.get(token);
  if (!pending) {
    const errorMsg = "# Session Expired\n⚠️ This embed configuration session has expired. Please run `/server-embed` again.\n-# Pacific Trust Bank • Staff Administration";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  if (pending.adminId && interaction.user?.id && interaction.user.id !== pending.adminId) {
    const errorMsg = "⚠️ Only the administrator who started this command can configure it.";
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  const isTicketMode = pending.mode === "ticket";
  const modal = new ModalBuilder()
    .setCustomId(`server-embed-dynamic-modal:${token}:${count}`)
    .setTitle(
      (isTicketMode
        ? `Configure ${count} Ticket Button${count === 1 ? "" : "s"}`
        : `Configure ${count} Dropdown Option${count === 1 ? "" : "s"}`
      ).slice(0, 45)
    );

  // If dropdown and count <= 4, include a placeholder field (max 5 ActionRows per modal)
  if (!isTicketMode && count <= 4) {
    const placeholderInput = new TextInputBuilder()
      .setCustomId("placeholder")
      .setLabel("Dropdown Placeholder")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Select an option...")
      .setValue("Select an option...")
      .setRequired(false)
      .setMaxLength(150);
    modal.addComponents(new ActionRowBuilder().addComponents(placeholderInput));
  }

  // Dynamically add a field for each requested option / button
  for (let i = 1; i <= count; i++) {
    const label = isTicketMode
      ? `Button ${i} (Name | Description | Emoji)`.slice(0, 45)
      : `Option ${i} (Label | Desc | Custom Message)`.slice(0, 45);
    const placeholder = isTicketMode
      ? `e.g. Deposit Ticket | For account deposits | 💵`
      : `e.g. FAQ | General help | Here is our full support guide & info!`;
    const optionInput = new TextInputBuilder()
      .setCustomId(`opt_${i}`)
      .setLabel(label)
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder(placeholder)
      .setRequired(true)
      .setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder().addComponents(optionInput));
  }

  await interaction.showModal(modal);
}

/**
 * Handles dynamic modal submissions where the administrator filled in each dynamic option field.
 *
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleServerEmbedDynamicModalSubmit(interaction) {
  const parts = interaction.customId.split(":");
  const token = parts[1];
  const count = parseInt(parts[2], 10) || 1;

  const pending = pendingEmbedModalConfigs.get(token);
  if (!pending) {
    const errorMsg = "# Session Expired\n⚠️ This embed configuration session has expired. Please run `/server-embed` again.\n-# Pacific Trust Bank • Staff Administration";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  const isTicketMode = pending.mode === "ticket";

  if (typeof interaction.deferReply === "function" && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const placeholder = interaction.fields?.getTextInputValue?.("placeholder") || "Select an option...";
  const rawOptionLines = [];
  for (let i = 1; i <= count; i++) {
    const val = interaction.fields?.getTextInputValue?.(`opt_${i}`)?.trim();
    if (val) rawOptionLines.push(val);
  }

  const parsedOptions = parseDropdownOptions(rawOptionLines);
  if (parsedOptions.length === 0) {
    const errorMsg = isTicketMode
      ? "⚠️ Please provide at least one valid ticket button option (e.g. `Deposit Ticket | Open deposit ticket`)."
      : "⚠️ Please provide at least one valid dropdown option (e.g. `Option 1 | Description`).";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  const { title, description, color, imageUrl, thumbnailUrl, imageAttachment, footerText } = pending.embedData;
  const parsedColor = parseEmbedColor(color);
  const embed = new EmbedBuilder().setTitle(title).setColor(parsedColor);
  if (description) embed.setDescription(description);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (imageUrl) embed.setImage(imageUrl);
  if (footerText) embed.setFooter({ text: footerText });

  let components = [];
  if (isTicketMode) {
    const rows = buildTicketButtonsComponent(parsedOptions);
    if (rows?.length > 0) components = rows;
  } else {
    const menuId = Math.random().toString(36).slice(2, 10);
    const dropdownCustomId = `server-embed-dropdown:${menuId}`;
    const row = buildDropdownComponent({
      customId: dropdownCustomId,
      placeholder: parsedOptions.placeholder || placeholder,
      options: parsedOptions,
    });
    if (row) components = [row];
    void saveDropdownOptionResponses(interaction.client?.db || null, dropdownCustomId, parsedOptions);
  }
  const files = imageAttachment ? [imageAttachment] : [];

  const targetChannel = interaction.channel;

  try {
    if (targetChannel && typeof targetChannel.send === "function") {
      await targetChannel.send({ embeds: [embed], components, files });
      pendingEmbedModalConfigs.delete(token);
      const confirmation = isTicketMode
        ? `# Ticket Embed Published\nEmbed with **${parsedOptions.length}** ticket button${parsedOptions.length === 1 ? "" : "s"} successfully posted in <#${targetChannel.id}>.\n-# Pacific Trust Bank • Ticket System`
        : `# Dropdown Embed Published\nEmbed with **${parsedOptions.length}** interactive options successfully posted in <#${targetChannel.id}>.\n-# Pacific Trust Bank • Interactive Menu`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: confirmation });
      }
      return interaction.reply({ content: confirmation, flags: MessageFlags.Ephemeral });
    } else {
      pendingEmbedModalConfigs.delete(token);
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ embeds: [embed], components, files });
      }
      return interaction.reply({ embeds: [embed], components, files });
    }
  } catch (error) {
    console.error("[PTB Embed] Failed to send embed:", error);
    const errorMsg = `Failed to deliver embed: ${error?.message || "Unknown error"}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }
}

/**
 * Handles modal submissions for the server-embed dropdown configuration (single-modal fallback).
 *
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleServerEmbedModalSubmit(interaction) {
  const token = interaction.customId.replace("server-embed-dropdown-modal:", "");
  const pending = pendingEmbedModalConfigs.get(token);

  if (!pending) {
    const errorMsg = "# Session Expired\n⚠️ This embed configuration session has expired or was not found. Please run `/server-embed` again.\n-# Pacific Trust Bank • Staff Administration";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  const isTicketMode = pending.mode === "ticket";

  if (typeof interaction.deferReply === "function" && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const placeholder = interaction.fields?.getTextInputValue?.("placeholder") || "Select an option...";
  const optionsRaw = interaction.fields?.getTextInputValue?.("options") || "";
  const parsedOptions = parseDropdownOptions(optionsRaw);

  if (parsedOptions.length === 0) {
    const errorMsg = isTicketMode
      ? "⚠️ Please provide at least one valid ticket button option (e.g. `Deposit Ticket | Open deposit ticket`)."
      : "⚠️ Please provide at least one valid dropdown option (e.g. `Option 1 | Description`).";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  const { title, description, color, imageUrl, thumbnailUrl, imageAttachment, footerText } = pending.embedData;
  const parsedColor = parseEmbedColor(color);
  const embed = new EmbedBuilder().setTitle(title).setColor(parsedColor);
  if (description) embed.setDescription(description);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (imageUrl) embed.setImage(imageUrl);
  if (footerText) embed.setFooter({ text: footerText });

  let components = [];
  if (isTicketMode) {
    const rows = buildTicketButtonsComponent(parsedOptions);
    if (rows?.length > 0) components = rows;
  } else {
    const menuId = Math.random().toString(36).slice(2, 10);
    const dropdownCustomId = `server-embed-dropdown:${menuId}`;
    const row = buildDropdownComponent({
      customId: dropdownCustomId,
      placeholder: parsedOptions.placeholder || placeholder,
      options: parsedOptions,
    });
    if (row) components = [row];
    void saveDropdownOptionResponses(interaction.client?.db || null, dropdownCustomId, parsedOptions);
  }
  const files = imageAttachment ? [imageAttachment] : [];

  const targetChannel = interaction.channel;

  try {
    if (targetChannel && typeof targetChannel.send === "function") {
      await targetChannel.send({ embeds: [embed], components, files });
      pendingEmbedModalConfigs.delete(token);
      const confirmation = isTicketMode
        ? `# Ticket Embed Published\nEmbed with ticket buttons successfully posted in <#${targetChannel.id}>.\n-# Pacific Trust Bank • Ticket System`
        : `# Dropdown Embed Published\nEmbed with dropdown successfully posted in <#${targetChannel.id}>.\n-# Pacific Trust Bank • Interactive Menu`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: confirmation });
      }
      return interaction.reply({ content: confirmation, flags: MessageFlags.Ephemeral });
    } else {
      pendingEmbedModalConfigs.delete(token);
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ embeds: [embed], components, files });
      }
      return interaction.reply({ embeds: [embed], components, files });
    }
  } catch (error) {
    console.error("[PTB Embed] Failed to send embed:", error);
    const errorMsg = `Failed to deliver embed: ${error?.message || "Unknown error"}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }
}

/**
 * Handles button clicks when a user presses a ticket button created via `/server-embed function:ticket`.
 * Opens a private ticket channel for the user and staff, where both the welcome embed and channel name
 * carry the ticket option name, with full compatibility with the existing ticket tracking and closing lifecycle.
 *
 * @param {any} db
 * @param {import("discord.js").ButtonInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleServerEmbedTicketOpenClick(db, interaction) {
  if (!interaction.guild) {
    const errorMsg = "# Access Denied\nTickets can only be opened inside a Discord server.\n-# Pacific Trust Bank • Ticket System";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  // Parse button customId: server-embed-ticket-open:<slug>:<encodedLabel>
  const parts = interaction.customId.split(":");
  const rawSlug = parts[1] || "ticket";
  let ticketTitle = "Ticket";
  if (parts[2]) {
    try {
      ticketTitle = decodeURIComponent(parts[2]);
    } catch {
      ticketTitle = parts[2];
    }
  }
  const safeKind = rawSlug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "ticket";

  if (typeof interaction.deferReply === "function" && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // Check existing open ticket by channel topic
  const ticketPrefix = ticketTopicPrefix(safeKind, interaction.user.id);
  try {
    const channels = await interaction.guild.channels.fetch().catch(() => null);
    const existingTicket = channels?.find?.((channel) =>
      channel?.type === ChannelType.GuildText && channel.topic?.startsWith(ticketPrefix)
    );
    if (existingTicket) {
      const msg = `# Ticket Already Open\nYou already have an open ${ticketTitle} ticket: <#${existingTicket.id}>. Close it before opening another.\n-# Pacific Trust Bank • Ticket System`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: msg });
      }
      return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
  } catch (channelCheckError) {
    console.warn("[PTB Ticket] Could not check existing ticket channels by topic:", channelCheckError?.message ?? channelCheckError);
  }

  let ticketId;
  try {
    ticketId = await createPendingTicket(db, { kind: safeKind, requesterId: interaction.user.id, amount: 0 });
  } catch (error) {
    if (/idx_tickets_open_per_user|UNIQUE constraint failed/i.test(String(error?.message ?? ""))) {
      const msg = `# Ticket Already Open\nYou already have an open ${ticketTitle} ticket. Close it before opening another.\n-# Pacific Trust Bank • Ticket System`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: msg });
      }
      return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    console.error("[PTB Ticket] Could not create the ticket record:", error);
    const msg = "# Database Error\nCould not open ticket right now. Please try again shortly.\n-# Pacific Trust Bank • Ticket System";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: msg });
    }
    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }

  const resolvedTicketCode = formatTicketCode({ kind: safeKind, id: ticketId });
  const config = ticketConfig();
  const [category, staffRoles] = await Promise.all([
    resolveTicketCategory(interaction.guild, config?.categoryId),
    resolveStaffRoles(interaction.guild, config?.staffRoleIds),
  ]);

  const staffOverwrites = (staffRoles || []).map((role) => ({
    id: role.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ManageMessages,
    ],
  }));

  const safeUsername = (interaction.user?.username || interaction.user?.id || "user")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "user";

  const optionSlug = (ticketTitle || safeKind)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "ticket";

  const channelName = `${optionSlug}-${ticketId}-${safeUsername}`.slice(0, 100);

  const buildChannelCreateOptions = (parentCategory) => ({
    name: channelName,
    type: ChannelType.GuildText,
    topic: ticketTopic(safeKind, interaction.user.id, 0, ticketId),
    ...(parentCategory ? { parent: parentCategory.id } : {}),
    permissionOverwrites: [
      {
        id: interaction.guild.roles?.everyone?.id || interaction.guild.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: interaction.client?.user?.id || "bot",
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
        ],
      },
      ...staffOverwrites,
    ],
  });

  let channel;
  try {
    channel = await interaction.guild.channels.create(buildChannelCreateOptions(category));
  } catch (primaryError) {
    console.warn("[PTB Ticket] Channel creation with category failed, retrying without category:", primaryError?.message ?? primaryError);
    if (category) {
      try {
        channel = await interaction.guild.channels.create(buildChannelCreateOptions(null));
      } catch (fallbackError) {
        console.warn("[PTB Ticket] Fallback channel creation without category failed:", fallbackError?.message ?? fallbackError);
      }
    }
  }

  if (!channel) {
    await rejectTicketWithNote(db, ticketId, "Ticket channel could not be created").catch(() => {});
    const msg = "# Channel Creation Failed\nI could not open your ticket because the bot lacks permissions to create channels in this server (requires 'Manage Channels' permission), or the category is full. Please contact a server administrator.\n-# Pacific Trust Bank • Ticket System";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: msg });
    }
    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }

  try {
    await attachTicketChannel(db, ticketId, channel.id);
  } catch (error) {
    console.error("[PTB Ticket] Could not attach the ticket channel:", error);
    await rejectTicketWithNote(db, ticketId, "Ticket channel could not be linked to the ticket record").catch(() => {});
    await channel.delete("PTB ticket could not be linked to its record").catch(() => {});
    const msg = "I could not open the ticket right now because the database rejected it. Please try again shortly.";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: msg });
    }
    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }

  try {
    const payload = ticketPanelPayload({
      ticket: { id: ticketId, kind: safeKind },
      type: safeKind,
      amount: 0,
      balance: 0,
      requester: interaction.user,
      channelId: channel.id,
      ticketTitle,
    });
    await channel.send(payload);

    void logTicketEvent(interaction.client, {
      action: "TICKET_OPENED",
      ticket: { id: ticketId, kind: safeKind, requester_id: interaction.user.id, amount: 0, channel_id: channel.id },
      actorId: interaction.user.id,
      details: `Custom ticket **${ticketTitle}** channel <#${channel.id}>${channel.parentId ? ` in category <#${channel.parentId}>` : ""}.`,
    }, { config }).catch?.(() => {});
  } catch (error) {
    console.error("[PTB Ticket] Could not send ticket panel message:", error);
    await rejectTicketWithNote(db, ticketId, "Ticket message could not be posted").catch(() => {});
    await channel.delete("Could not initialize the PTB ticket").catch(() => {});
    const msg = "The ticket channel was created but the bot was unable to post the ticket panel. Please ensure the bot has 'Send Messages' and 'Embed Links' permissions.";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: msg });
    }
    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }

  const successReply = `# Ticket Created\nYour private **${ticketTitle}** ticket is open: <#${channel.id}> (\`${resolvedTicketCode}\`).\n-# Pacific Trust Bank • Ticket System`;
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content: successReply });
  }
  return interaction.reply({ content: successReply, flags: MessageFlags.Ephemeral });
}


/**
 * Handles interactions when a user selects an item from a server-embed dropdown.
 * Delivers custom configured response messages when defined by the administrator,
 * or differentiates functionality (links, banking actions, guidance) to make
 * dropdown options genuinely actionable, formatted with # (bold) and -# (small subtext).
 *
 * @param {import("discord.js").StringSelectMenuInteraction|any} interaction
 * @param {any} [db]
 * @returns {Promise<void>}
 */
export async function handleServerEmbedDropdownSelect(interaction, db) {
  let currentDb = db;
  let currentInteraction = interaction;
  if (interaction && typeof interaction.execute === "function" && db && db.isStringSelectMenu) {
    currentDb = interaction;
    currentInteraction = db;
  }

  const customId = currentInteraction.customId || "";
  const selectedValue = currentInteraction.values?.[0] || "";
  const selectedOption = currentInteraction.component?.options?.find((opt) => opt.value === selectedValue);
  const label = selectedOption?.label || selectedValue || "Unknown option";
  const desc = selectedOption?.description ? `\n> ${selectedOption.description}` : "";

  // 1. Check if a custom response message was configured for this option
  let customResponse = dropdownCustomResponses.get(`${customId}:${selectedValue}`)
                     || dropdownCustomResponses.get(selectedValue)
                     || null;

  if (!customResponse && currentDb && typeof currentDb.execute === "function") {
    try {
      const res = await currentDb.execute({
        sql: "SELECT response_message FROM embed_dropdown_options WHERE (custom_id = ? AND option_value = ?) OR option_value = ? LIMIT 1",
        args: [customId, selectedValue, selectedValue],
      });
      if (res.rows?.length > 0) {
        customResponse = res.rows[0].response_message;
        dropdownCustomResponses.set(`${customId}:${selectedValue}`, customResponse);
      }
    } catch (dbErr) {
      console.warn("[PTB Embed] Failed to query embed_dropdown_options:", dbErr?.message ?? dbErr);
    }
  }

  // If a custom response message was customized by the administrator, deliver it directly!
  if (customResponse) {
    const components = [];
    const urlMatch = customResponse.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      const url = urlMatch[0];
      try {
        const button = new ButtonBuilder()
          .setLabel(`Open Link`)
          .setStyle(ButtonStyle.Link)
          .setURL(url);
        components.push(new ActionRowBuilder().addComponents(button));
      } catch {}
    }

    let responseContent;
    if (customResponse.startsWith("#")) {
      responseContent = `${customResponse}\n-# Pacific Trust Bank • Interactive Menu`;
    } else {
      responseContent = `# ${label}${desc}\n\n${customResponse}\n-# Pacific Trust Bank • Interactive Menu`;
    }

    const payload = {
      content: responseContent,
      flags: MessageFlags.Ephemeral,
      ...(components.length > 0 ? { components } : {}),
    };

    if (currentInteraction.deferred || currentInteraction.replied) {
      return currentInteraction.editReply(payload);
    }
    return currentInteraction.reply(payload);
  }

  // Fallback to keyword-based smart differentiation when no custom response was provided
  const combined = `${label} ${selectedOption?.description || ""} ${selectedValue}`.toLowerCase();

  let actionAdvice = "";
  const components = [];

  // Check for link / URL
  const urlMatch = (selectedOption?.description || "").match(/https?:\/\/[^\s]+/i) ||
                   (label).match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    const url = urlMatch[0];
    actionAdvice = `\n\n🔗 **Link:** [Click here to open](${url})`;
    try {
      const button = new ButtonBuilder()
        .setLabel(`Open ${label.replace(/https?:\/\/[^\s]+/i, "").trim() || "Link"}`)
        .setStyle(ButtonStyle.Link)
        .setURL(url);
      components.push(new ActionRowBuilder().addComponents(button));
    } catch {
      // Fall through to text link
    }
  } else if (/\b(deposit|receipt)\b/i.test(combined)) {
    actionAdvice = "\n\n💡 **Action:** Run `/deposit` with your amount to open a private deposit ticket and submit your receipt.";
  } else if (/\b(withdraw|withdrawal)\b/i.test(combined)) {
    actionAdvice = "\n\n💡 **Action:** Run `/withdraw` with your amount to request a private withdrawal.";
  } else if (/\b(balance|funds|ledger)\b/i.test(combined)) {
    actionAdvice = "\n\n💡 **Action:** Run `/balance` to view your private ledger balance.";
  } else if (/\b(transfer|send money)\b/i.test(combined)) {
    actionAdvice = "\n\n💡 **Action:** Run `/transfer` to send funds to another registered citizen.";
  } else if (/\b(register|bloxlink|verify)\b/i.test(combined)) {
    actionAdvice = "\n\n💡 **Action:** Run `/register` to link your Roblox account with Bloxlink.";
  } else if (/\b(ticket|support|help|staff)\b/i.test(combined)) {
    actionAdvice = "\n\n💡 **Action:** Use `/deposit` or `/withdraw` to open a private ticket with bank staff.";
  }

  const responseContent = `# ${label}${desc}${actionAdvice}\n-# Pacific Trust Bank • Interactive Menu`;
  const responsePayload = {
    content: responseContent,
    flags: MessageFlags.Ephemeral,
  };
  if (components.length > 0) {
    responsePayload.components = components;
  }

  if (currentInteraction.deferred || currentInteraction.replied) {
    return currentInteraction.editReply(responsePayload);
  }
  return currentInteraction.reply(responsePayload);
}

export default {
  PTB_COLORS,
  PTB_FOOTERS,
  DISCORD_LIMITS,
  truncate,
  resolveColor,
  isValidHttpUrl,
  safeTicketCode,
  buildPtbEmbed,
  buildInfoEmbed,
  buildSuccessEmbed,
  buildWarningEmbed,
  buildErrorEmbed,
  buildTicketPanelEmbed,
  buildTicketWelcomeEmbed,
  formatOrdinal,
  formatImageLabel,
  resolveImageLabel,
  buildDepositAnalysisEmbed,
  buildDepositReceiptEmbed,
  buildReceiptAnalysisEmbed,
  buildReceiptEmbed,
  buildStaffNotificationEmbed,
  buildTicketClosureSummaryEmbed,
  buildTicketClosureEmbed,
  validateCustomEmbedOptions,
  buildCustomEmbed,
  parseEmbedColor,
  validateImageUrl,
  resolveWebsiteThumbnail,
  sanitizeEmbed,
  parseSingleOption,
  parseDropdownOptions,
  buildDropdownComponent,
  buildTicketButtonsComponent,
  embedDropdownSchemaStatements,
  dropdownCustomResponses,
  saveDropdownOptionResponses,
  pendingEmbedModalConfigs,
  serverEmbedCommand,
  createServerEmbedCommand,
  handleServerEmbedCommand,
  handleServerEmbedModalSubmit,
  handleServerEmbedOptionCountClick,
  handleServerEmbedDynamicModalSubmit,
  handleServerEmbedDropdownSelect,
  handleServerEmbedTicketOpenClick,
};

