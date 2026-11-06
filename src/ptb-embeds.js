import {
  ActionRowBuilder,
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
    const letter = isWithdraw ? "W" : "D";
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
} = {}) {
  const resolvedType = type || ticket?.kind || "deposit";
  const isDeposit = resolvedType === "deposit";
  const resolvedCode = code || (ticket ? safeTicketCode({ ...ticket, kind: resolvedType }) : `PTB-${isDeposit ? "D" : "W"}-?`);
  const resolvedAmount = amount ?? ticket?.amount ?? 0;
  const requesterId = requester?.id || ticket?.requester_id || requester || "unknown";
  const defaultColor = isDeposit ? PTB_COLORS.DEPOSIT : PTB_COLORS.WITHDRAW;
  const resolvedColor = resolveColor(color, defaultColor);

  const nextStep = isDeposit
    ? "Upload a clear PNG, JPEG, or WebP screenshot of the in-game payment in this channel. PTB will post an advisory receipt analysis here. A screenshot never approves or credits a deposit by itself."
    : "Tell ticket staff which in-game payout you are requesting. Your balance is not reserved while this ticket is open; staff will verify and deliver the payout before the ledger is debited.";
  const staffNote = "Only ticket staff can close this ticket. Administrators review, approve, and finalise ledger movements. Staff can add a helper with `/add-user`.";

  const fields = [
    { name: "Requester", value: `<@${requesterId}>`, inline: true },
    { name: "Amount", value: `**${Number(resolvedAmount).toLocaleString()}**`, inline: true },
    { name: "Status", value: "🟡 Pending review", inline: true },
    { name: "Ticket ID", value: `\`${resolvedCode}\``, inline: true },
  ];

  if (Number.isFinite(balance)) {
    fields.push({ name: "Balance at opening", value: Number(balance).toLocaleString(), inline: true });
  }

  fields.push(
    { name: "What happens next", value: nextStep },
    { name: "Staff controls", value: staffNote },
  );

  return buildPtbEmbed({
    color: resolvedColor,
    title: `🎫 ${isDeposit ? "Deposit" : "Withdrawal"} request · ${resolvedCode}`,
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
 * @param {string} rawInput
 * @returns {Array<{ label: string, value: string, description?: string }>}
 */
export function parseDropdownOptions(rawInput) {
  if (!rawInput || typeof rawInput !== "string") return [];

  const lines = rawInput.includes("\n")
    ? rawInput.split("\n")
    : rawInput.split(/[,;]/);

  const options = [];
  let index = 1;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (options.length >= 25) break; // Discord maximum options per select menu

    let label = trimmed;
    let description = null;

    if (trimmed.includes("|")) {
      const parts = trimmed.split("|").map((p) => p.trim());
      label = parts[0] || `Option ${index}`;
      description = parts[1] || null;
    } else if (trimmed.includes(" - ")) {
      const parts = trimmed.split(" - ").map((p) => p.trim());
      label = parts[0] || `Option ${index}`;
      description = parts[1] || null;
    } else if (trimmed.includes(": ") && !trimmed.startsWith("http")) {
      const parts = trimmed.split(": ").map((p) => p.trim());
      label = parts[0] || `Option ${index}`;
      description = parts[1] || null;
    }

    label = label.slice(0, 100);
    if (description) description = description.slice(0, 100);
    const sanitizedVal = label.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80);
    const value = `opt_${index}_${sanitizedVal || "item"}`.slice(0, 100);

    options.push({
      label,
      value,
      description: description || undefined,
    });
    index++;
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
 * Storage for pending dropdown modal configuration sessions.
 */
export const pendingEmbedModalConfigs = new Map();

/**
 * Slash command definition for /server-embed with dropdown support.
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
    o.setName("color")
      .setDescription("Hex color, for example #5865F2")
      .setRequired(false)
      .setMaxLength(30))
  .addStringOption((o) =>
    o.setName("image_url")
      .setDescription("Image URL beginning with http:// or https://")
      .setRequired(false)
      .setMaxLength(2048))
  .addStringOption((o) =>
    o.setName("footer")
      .setDescription("Footer text")
      .setRequired(false)
      .setMaxLength(2048))
  .addStringOption((o) =>
    o.setName("function")
      .setDescription("Embed functionality (select 'dropdown' to attach a select menu)")
      .setRequired(false)
      .addChoices(
        { name: "dropdown", value: "dropdown" },
      ))
  .addStringOption((o) =>
    o.setName("dropdown_placeholder")
      .setDescription("Placeholder text for the dropdown (e.g. Choose an option...)")
      .setRequired(false)
      .setMaxLength(150))
  .addStringOption((o) =>
    o.setName("dropdown_options")
      .setDescription("Dropdown options (e.g. Option 1 | Details, Option 2 | Details)")
      .setRequired(false)
      .setMaxLength(2000))
  .addChannelOption((o) =>
    o.setName("channel")
      .setDescription("Target channel to post in (defaults to current channel)"))
  .addStringOption((o) =>
    o.setName("thumbnail")
      .setDescription("Thumbnail image URL (http/https)")
      .setRequired(false)
      .setMaxLength(500))
  .addStringOption((o) =>
    o.setName("image")
      .setDescription("Large banner image URL (http/https)")
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
 * with optional dropdown select menu (via modal setup or direct parameters).
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
      content: "Only server administrators can use the `/server-embed` command.",
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
  const imageUrlInput = interaction.options.getString("image_url") || interaction.options.getString("image");
  const thumbnailInput = interaction.options.getString?.("thumbnail");
  const footerText = interaction.options.getString("footer");
  const functionChoice = interaction.options.getString?.("function");
  const dropdownPlaceholder = interaction.options.getString?.("dropdown_placeholder");
  const dropdownOptionsRaw = interaction.options.getString?.("dropdown_options");
  const targetChannel = interaction.options.getChannel?.("channel");

  // If function:dropdown selected without options provided, open modal so admin can fill out options
  const wantsDropdownModal = (functionChoice === "dropdown" && !dropdownOptionsRaw);
  if (wantsDropdownModal && typeof interaction.showModal === "function" && !interaction.deferred && !interaction.replied) {
    try {
      if (colorInput) parseEmbedColor(colorInput);
      if (imageUrlInput) validateImageUrl(imageUrlInput);
      if (thumbnailInput) validateImageUrl(thumbnailInput);
    } catch (err) {
      return interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
    }

    const token = Math.random().toString(36).slice(2, 10);
    pendingEmbedModalConfigs.set(token, {
      embedData: { title, description, color: colorInput, imageUrl: imageUrlInput, thumbnailUrl: thumbnailInput, footerText },
      targetChannelId: targetChannel?.id || interaction.channelId,
      createdAt: Date.now(),
      adminId: interaction.user?.id,
    });

    const modal = new ModalBuilder()
      .setCustomId(`server-embed-dropdown-modal:${token}`)
      .setTitle("Configure Dropdown Menu");

    const placeholderInput = new TextInputBuilder()
      .setCustomId("placeholder")
      .setLabel("Dropdown Placeholder")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(dropdownPlaceholder || "Select an option...")
      .setValue(dropdownPlaceholder || "Select an option...")
      .setRequired(false)
      .setMaxLength(150);

    const optionsInput = new TextInputBuilder()
      .setCustomId("options")
      .setLabel("Dropdown Options (one per line: Label | Desc)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Option 1 | Details about option 1\nOption 2 | Details about option 2\nOption 3")
      .setRequired(true)
      .setMaxLength(2000);

    modal.addComponents(
      new ActionRowBuilder().addComponents(placeholderInput),
      new ActionRowBuilder().addComponents(optionsInput),
    );

    await interaction.showModal(modal);
    return;
  }

  // Defer reply if available and not already acknowledged
  if (typeof interaction.deferReply === "function" && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply().catch(() => {});
  }

  // 2. Parse and validate inputs with user-friendly error messages
  let color;
  let imageUrl = null;
  let thumbnailUrl = null;
  try {
    color = parseEmbedColor(colorInput);
    imageUrl = validateImageUrl(imageUrlInput);
    if (thumbnailInput) thumbnailUrl = validateImageUrl(thumbnailInput);
  } catch (err) {
    const errorMsg = `⚠️ ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  // 3. Assemble the embed object
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color);

  if (description) embed.setDescription(description);
  if (imageUrl) embed.setImage(imageUrl);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (footerText) embed.setFooter({ text: footerText });

  // 4. Build dropdown component if options are provided or function is dropdown
  let components = [];
  if (dropdownOptionsRaw) {
    const parsedOptions = parseDropdownOptions(dropdownOptionsRaw);
    if (parsedOptions.length > 0) {
      const row = buildDropdownComponent({
        placeholder: dropdownPlaceholder || "Select an option...",
        options: parsedOptions,
      });
      if (row) components.push(row);
    }
  }

  // 5. Send the embed
  if (targetChannel && typeof targetChannel.send === "function" && targetChannel.id !== interaction.channel?.id) {
    try {
      await targetChannel.send({ embeds: [embed], components });
      const confirmation = `Embed successfully posted in <#${targetChannel.id}>.`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: confirmation });
      }
      return interaction.reply({ content: confirmation, flags: MessageFlags.Ephemeral });
    } catch (sendError) {
      const failMsg = `Failed to deliver embed: ${sendError?.message || "Unknown Discord API error"}`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: failMsg });
      }
      return interaction.reply({ content: failMsg, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.channel && typeof interaction.channel.send === "function" && !interaction.deferred && !interaction.replied) {
    try {
      await interaction.channel.send({ embeds: [embed], components });
      return interaction.reply({
        content: `Embed successfully posted in <#${interaction.channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      // Fall through to editReply / reply
    }
  }

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed], components });
  }
  return interaction.reply({ embeds: [embed], components });
}

/**
 * Handles modal submissions for the server-embed dropdown configuration.
 *
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleServerEmbedModalSubmit(interaction) {
  const token = interaction.customId.replace("server-embed-dropdown-modal:", "");
  const pending = pendingEmbedModalConfigs.get(token);

  if (!pending) {
    const errorMsg = "⚠️ This embed configuration session has expired or was not found. Please run `/server-embed` again.";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  if (typeof interaction.deferReply === "function" && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const placeholder = interaction.fields?.getTextInputValue?.("placeholder") || "Select an option...";
  const optionsRaw = interaction.fields?.getTextInputValue?.("options") || "";
  const parsedOptions = parseDropdownOptions(optionsRaw);

  if (parsedOptions.length === 0) {
    const errorMsg = "⚠️ Please provide at least one valid dropdown option (e.g. `Option 1 | Description`).";
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }

  const { title, description, color, imageUrl, thumbnailUrl, footerText } = pending.embedData;
  const parsedColor = parseEmbedColor(color);
  const embed = new EmbedBuilder().setTitle(title).setColor(parsedColor);
  if (description) embed.setDescription(description);
  if (imageUrl) embed.setImage(imageUrl);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (footerText) embed.setFooter({ text: footerText });

  const row = buildDropdownComponent({
    placeholder,
    options: parsedOptions,
  });
  const components = row ? [row] : [];

  let targetChannel = null;
  if (interaction.client?.channels && pending.targetChannelId) {
    try {
      targetChannel = await interaction.client.channels.fetch(pending.targetChannelId);
    } catch {
      targetChannel = interaction.channel;
    }
  } else {
    targetChannel = interaction.channel;
  }

  try {
    if (targetChannel && typeof targetChannel.send === "function") {
      await targetChannel.send({ embeds: [embed], components });
      pendingEmbedModalConfigs.delete(token);
      const confirmation = `Embed with dropdown successfully posted in <#${targetChannel.id}>.`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: confirmation });
      }
      return interaction.reply({ content: confirmation, flags: MessageFlags.Ephemeral });
    } else {
      pendingEmbedModalConfigs.delete(token);
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ embeds: [embed], components });
      }
      return interaction.reply({ embeds: [embed], components });
    }
  } catch (error) {
    console.error("[PTB Embed] Failed to send embed with dropdown:", error);
    const errorMsg = `Failed to deliver embed: ${error?.message || "Unknown error"}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errorMsg });
    }
    return interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
  }
}

/**
 * Handles interactions when a user selects an item from a server-embed dropdown.
 *
 * @param {import("discord.js").StringSelectMenuInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleServerEmbedDropdownSelect(interaction) {
  const selectedValue = interaction.values?.[0];
  const selectedOption = interaction.component?.options?.find((opt) => opt.value === selectedValue);
  const label = selectedOption?.label || selectedValue || "Unknown option";
  const desc = selectedOption?.description ? `\n> ${selectedOption.description}` : "";

  const responseContent = `You selected **${label}**${desc}`;
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content: responseContent });
  }
  return interaction.reply({ content: responseContent, flags: MessageFlags.Ephemeral });
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
  sanitizeEmbed,
  addSafeChunkedFields,
  parseDropdownOptions,
  buildDropdownComponent,
  pendingEmbedModalConfigs,
  serverEmbedCommand,
  createServerEmbedCommand,
  handleServerEmbedCommand,
  handleServerEmbedModalSubmit,
  handleServerEmbedDropdownSelect,
};

