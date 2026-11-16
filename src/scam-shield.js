import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { computePerceptualHash, computeSha256, isPerceptuallySimilar } from "./perceptual-hash.js";

export const MAX_SEEN_SCANNED_IDS = 10_000;
export const PERIODIC_SCAN_INTERVAL_MS = 10_000;
export const PERIODIC_FETCH_LIMIT = 15;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const PERCEPTUAL_HASH_THRESHOLD = 8;

/**
 * In-memory deduplication set of scanned message IDs, capped at 10,000 entries.
 */
export const seenScannedMessageIds = new Set();

/**
 * LibSQL / SQLite schema statements for ScamShield incident logs and known scam image hashes.
 */
export const scamShieldSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS scam_known_hashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT,
    perceptual_hash TEXT,
    reason TEXT NOT NULL DEFAULT 'Confirmed scam image',
    added_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scam_known_sha256 ON scam_known_hashes(sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_scam_known_phash ON scam_known_hashes(perceptual_hash)`,
  `CREATE TABLE IF NOT EXISTS scam_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    channel_id TEXT,
    message_id TEXT UNIQUE,
    author_id TEXT NOT NULL,
    author_tag TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'guild_realtime',
    severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high')),
    score INTEGER NOT NULL DEFAULT 0,
    reasons_json TEXT NOT NULL DEFAULT '[]',
    matched_urls_json TEXT NOT NULL DEFAULT '[]',
    matched_hashes_json TEXT NOT NULL DEFAULT '[]',
    content_excerpt TEXT NOT NULL DEFAULT '',
    action_taken TEXT NOT NULL DEFAULT 'reported',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'confirmed', 'dismissed')),
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scam_incidents_author ON scam_incidents(author_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_scam_incidents_status ON scam_incidents(status, created_at)`,
];

/**
 * Record a message ID into seenScannedMessageIds while keeping the set bounded at 10,000 IDs.
 * @param {string|null|undefined} messageId
 */
export function markMessageSeen(messageId) {
  if (!messageId) return;
  if (seenScannedMessageIds.has(messageId)) return;
  if (seenScannedMessageIds.size >= MAX_SEEN_SCANNED_IDS) {
    const oldest = seenScannedMessageIds.values().next().value;
    if (oldest !== undefined) {
      seenScannedMessageIds.delete(oldest);
    }
  }
  seenScannedMessageIds.add(messageId);
}

const TRUSTED_DOMAINS = new Set([
  "discord.com",
  "www.discord.com",
  "discord.gg",
  "discordapp.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "ptb.discord.com",
  "canary.discord.com",
  "roblox.com",
  "www.roblox.com",
  "create.roblox.com",
  "blox.link",
  "verify.blox.link",
  "auth.blox.link",
  "steampowered.com",
  "store.steampowered.com",
  "steamcommunity.com",
  "github.com",
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
]);

const URL_SHORTENERS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "cutt.ly",
  "rb.gy",
  "is.gd",
  "v.gd",
  "shorturl.at",
  "tiny.cc",
]);

const PHISHING_DOMAIN_PATTERNS = [
  /d[il1]sc[o0]rd[-_.]?(?:n[il1]tr[o0]|g[il1]ft|app|drop|prom[o0]|airdrop|giveaway|ver[il1]fy|support)/i,
  /\b(?:dlscord|discorcl|discrod|discrocl|disc0rd|disccrd|dicsord|discord-app|discord-nitro|discordgift)\b/i,
  /\b(?:stearnpowered|steamcornmunity|steampovvered|steamcommunitly|steamcommunity-gift|steam-gift)\b/i,
  /\b(?:robiox|r0blox|robox|roblox-free|rbx-free|blox-link|bloxllnk|bloxlink-verify)\b/i,
  /\b(?:nitro-gift|free-nitro|claim-nitro|wallet-connect|airdrop-claim)\b/i,
];

const LURE_PATTERNS = [
  { regex: /\b(?:free\s+nitro|claim\s+(?:your\s+)?nitro|discord\s+nitro\s+gift|who\s+wants\s+free\s+nitro)\b/i, weight: 45, reason: "Fake Discord Nitro / gift lure" },
  { regex: /\b(?:free\s+robux|claim\s+(?:your\s+)?robux|robux\s+generator)\b/i, weight: 45, reason: "Fake Robux / Roblox giveaway lure" },
  { regex: /\b(?:airdrop|wallet\s+drainer|seed\s+phrase|recovery\s+phrase|connect\s+(?:your\s+)?wallet|claim\s+(?:free\s+)?(?:eth|btc|sol|crypto|usdt))\b/i, weight: 45, reason: "Crypto wallet / airdrop phishing lure" },
  { regex: /\b(?:test\s+my\s+(?:new\s+)?game|download\s+(?:my|this)\s+beta|try\s+my\s+game\s+exe)\b/i, weight: 35, reason: "Suspicious game-tester / malware download lure" },
  { regex: /\b(?:your\s+account\s+(?:will\s+be|has\s+been)\s+(?:suspended|terminated|banned)|verify\s+(?:your\s+)?account\s+(?:urgently|immediately|within)|scan\s+(?:this|the)\s+qr\s+code)\b/i, weight: 45, reason: "Account suspension / QR verification phishing threat" },
  { regex: /\b(?:bloxlink\s+verification\s+failed|re-?verify\s+bloxlink\s+here)\b/i, weight: 40, reason: "Spoofed Bloxlink verification lure" },
  { regex: /\b(?:steam\s+gift|50\$\s+steam|trade\s+offer\s+link)\b/i, weight: 35, reason: "Fake Steam gift / trade lure" },
  { regex: /\b(?:guaranteed\s+profit|dm\s+me\s+for\s+(?:crypto|forex|investment)|double\s+your\s+(?:money|crypto))\b/i, weight: 40, reason: "Financial / investment scam lure" },
];

const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;

/**
 * Defang a URL so staff alerts never render clickable phishing links.
 * @param {string} rawUrl
 * @returns {string}
 */
export function defangUrl(rawUrl) {
  return String(rawUrl ?? "")
    .replace(/^https:\/\//i, "hxxps://")
    .replace(/^http:\/\//i, "hxxp://")
    .replace(/\./g, "[.]");
}

function getCollectionValues(collectionLike) {
  if (!collectionLike) return [];
  if (Array.isArray(collectionLike)) return collectionLike;
  if (typeof collectionLike.values === "function") return [...collectionLike.values()];
  return [];
}

/**
 * Extract all HTTP/HTTPS URLs from a message's content and embeds.
 * @param {any} message
 * @returns {string[]}
 */
export function extractUrlsFromMessage(message) {
  const chunks = [];
  if (typeof message?.content === "string" && message.content) {
    chunks.push(message.content);
  }
  const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    if (embed?.url) chunks.push(embed.url);
    if (embed?.title) chunks.push(embed.title);
    if (embed?.description) chunks.push(embed.description);
    if (Array.isArray(embed?.fields)) {
      for (const field of embed.fields) {
        if (field?.name) chunks.push(field.name);
        if (field?.value) chunks.push(field.value);
      }
    }
  }

  const found = new Set();
  for (const chunk of chunks) {
    const matches = String(chunk).match(URL_REGEX);
    if (!matches) continue;
    for (const raw of matches) {
      const cleaned = raw.replace(/[),.!?;:'"]+$/, "");
      if (cleaned) found.add(cleaned);
    }
  }
  return [...found];
}

/**
 * Returns true if the message contains attachments, embeds, or URLs.
 * @param {any} message
 * @returns {boolean}
 */
export function messageHasScannablePayload(message) {
  if (!message) return false;
  const attachments = getCollectionValues(message.attachments);
  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  if (attachments.length > 0 || embeds.length > 0) return true;
  return extractUrlsFromMessage(message).length > 0;
}

function isTrustedHostname(hostname) {
  const lower = hostname.toLowerCase();
  if (TRUSTED_DOMAINS.has(lower)) return true;
  for (const domain of TRUSTED_DOMAINS) {
    if (lower.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function isIpv4Hostname(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Analyze message text, embeds, and URLs deterministically for scam/phishing signals.
 * @param {any} message
 * @returns {{
 *   score: number,
 *   reasons: string[],
 *   matchedUrls: string[],
 *   hasSuspiciousUrl: boolean,
 *   hasShortener: boolean
 * }}
 */
export function analyzeMessageSignals(message) {
  let score = 0;
  const reasons = [];
  const matchedUrls = [];
  let hasSuspiciousUrl = false;
  let hasShortener = false;

  const textParts = [String(message?.content ?? "")];
  const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    if (embed?.title) textParts.push(embed.title);
    if (embed?.description) textParts.push(embed.description);
    if (Array.isArray(embed?.fields)) {
      for (const field of embed.fields) {
        if (field?.name) textParts.push(field.name);
        if (field?.value) textParts.push(field.value);
      }
    }
  }
  const combinedText = textParts.join("\n");

  const urls = extractUrlsFromMessage(message);
  for (const rawUrl of urls) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (isTrustedHostname(hostname)) {
      continue;
    }

    const fullLower = rawUrl.toLowerCase();
    if (PHISHING_DOMAIN_PATTERNS.some((pattern) => pattern.test(hostname) || pattern.test(fullLower))) {
      score += 75;
      hasSuspiciousUrl = true;
      matchedUrls.push(rawUrl);
      reasons.push(`Phishing/lookalike domain detected (${defangUrl(hostname)})`);
      continue;
    }

    if (hostname.startsWith("xn--") || hostname.includes(".xn--")) {
      score += 55;
      hasSuspiciousUrl = true;
      matchedUrls.push(rawUrl);
      reasons.push(`Punycode/IDN homograph domain detected (${defangUrl(hostname)})`);
      continue;
    }

    if (isIpv4Hostname(hostname)) {
      score += 45;
      hasSuspiciousUrl = true;
      matchedUrls.push(rawUrl);
      reasons.push(`Direct IP-literal URL detected (${defangUrl(hostname)})`);
      continue;
    }

    if (URL_SHORTENERS.has(hostname)) {
      hasShortener = true;
      score += 20;
      matchedUrls.push(rawUrl);
      reasons.push(`Shortened URL detected (${defangUrl(hostname)})`);
    }
  }

  let lureMatches = 0;
  for (const lure of LURE_PATTERNS) {
    if (lure.regex.test(combinedText)) {
      score += lure.weight;
      lureMatches += 1;
      reasons.push(lure.reason);
    }
  }

  // Mass mention + external URL or lure strongly indicates compromised account spam
  const hasMassMention = Boolean(message?.mentions?.everyone) || /@(?:everyone|here)\b/i.test(combinedText);
  if (hasMassMention && (urls.length > 0 || lureMatches > 0)) {
    score += 35;
    reasons.push("Mass mention combined with link or scam lure");
  }

  // External untrusted link + scam lure together elevate confidence to high
  if (urls.length > 0 && lureMatches > 0 && !hasSuspiciousUrl) {
    const hasUntrusted = urls.some((u) => {
      try {
        return !isTrustedHostname(new URL(u).hostname);
      } catch {
        return false;
      }
    });
    if (hasUntrusted) {
      score += 25;
      if (!matchedUrls.length) matchedUrls.push(...urls.slice(0, 3));
    }
  }

  // Suspicious executable attachments (.exe, .scr, .bat, .cmd, .vbs, .msi, .apk)
  const attachments = getCollectionValues(message?.attachments);
  for (const att of attachments) {
    const name = String(att?.name ?? "").toLowerCase();
    if (/\.(?:exe|scr|bat|cmd|vbs|ps1|msi|hta|jar)$/i.test(name)) {
      score += 70;
      reasons.push(`Executable/script attachment (${name})`);
    }
  }

  return {
    score,
    reasons: [...new Set(reasons)],
    matchedUrls: [...new Set(matchedUrls)],
    hasSuspiciousUrl,
    hasShortener,
  };
}

function isImageAttachment(attachment) {
  const contentType = String(attachment?.contentType ?? "").toLowerCase();
  const name = String(attachment?.name ?? "").toLowerCase();
  if (contentType.startsWith("image/")) return true;
  return /\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name);
}

async function defaultFetchAttachmentBuffer(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  timeout.unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) {
      return null;
    }
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compute SHA-256 and perceptual dHash for image attachments and compare against scam_known_hashes.
 * @param {any} message
 * @param {any} db
 * @param {{ fetchAttachmentBuffer?: (url: string, attachment: any) => Promise<Buffer|null> }} [options]
 */
export async function scanMessageImageHashes(message, db, options = {}) {
  const attachments = getCollectionValues(message?.attachments).filter(isImageAttachment);
  if (attachments.length === 0) {
    return { matched: false, hashes: [], reasons: [] };
  }

  const fetcher = typeof options.fetchAttachmentBuffer === "function"
    ? options.fetchAttachmentBuffer
    : (url) => defaultFetchAttachmentBuffer(url);

  let knownRows = [];
  if (db && typeof db.execute === "function") {
    try {
      const res = await db.execute("SELECT id, sha256, perceptual_hash, reason FROM scam_known_hashes");
      knownRows = res.rows ?? [];
    } catch {
      knownRows = [];
    }
  }

  const computedHashes = [];
  const reasons = [];
  let matched = false;

  for (const att of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    if (typeof att?.size === "number" && att.size > MAX_ATTACHMENT_BYTES) continue;
    const url = att?.url || att?.proxyURL;
    if (!url && typeof options.fetchAttachmentBuffer !== "function") continue;

    const buffer = await fetcher(url, att).catch(() => null);
    if (!buffer || buffer.byteLength === 0 || buffer.byteLength > MAX_ATTACHMENT_BYTES) continue;

    const sha256 = computeSha256(buffer);
    const perceptualHash = await computePerceptualHash(buffer);

    computedHashes.push({
      name: att?.name || "image",
      sha256,
      perceptualHash,
    });

    for (const known of knownRows) {
      if (sha256 && known.sha256 && sha256 === known.sha256) {
        matched = true;
        reasons.push(`Known scam image exact match (${known.reason || "flagged hash"})`);
        break;
      }
      if (perceptualHash && known.perceptual_hash) {
        const sim = isPerceptuallySimilar(perceptualHash, known.perceptual_hash, PERCEPTUAL_HASH_THRESHOLD);
        if (sim.similar) {
          matched = true;
          reasons.push(`Visually similar to known scam image (dHash distance ${sim.distance}, ${known.reason || "flagged hash"})`);
          break;
        }
      }
    }
  }

  return {
    matched,
    hashes: computedHashes,
    reasons: [...new Set(reasons)],
  };
}

function resolveAlertChannelId(config = {}) {
  return (
    config.alertChannelId ||
    process.env.SCAM_ALERT_CHANNEL_ID ||
    process.env.MOD_LOG_CHANNEL_ID ||
    process.env.TICKET_LOG_CHANNEL_ID ||
    process.env.APPLICATIONS_REVIEW_CHANNEL_ID ||
    null
  );
}

function isGuildAdmin(message) {
  return Boolean(message?.member?.permissions?.has?.(PermissionFlagsBits.Administrator));
}

function canReviewScamAlert(interaction) {
  if (
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }
  const ownerRoleId = process.env.OWNER_ROLE_ID;
  const cache = interaction.member?.roles?.cache;
  if (ownerRoleId && cache?.has?.(ownerRoleId)) return true;
  const staffRoles = String(process.env.TICKET_STAFF_ROLE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Boolean(cache && staffRoles.some((id) => cache.has(id)));
}

/**
 * Evaluate a single message (DM or guild channel) for scam/phishing indicators,
 * log incidents, optionally auto-delete high-severity guild scams, and notify staff.
 *
 * @param {any} message
 * @param {any} client
 * @param {{ source?: string, alertChannelId?: string, autoDelete?: boolean, scanAdmins?: boolean, fetchAttachmentBuffer?: Function }} [config]
 * @param {any} [db]
 */
export async function handleMessage(message, client, config = {}, db = null) {
  if (!message || message.author?.bot) {
    return { flagged: false, skipped: "bot_or_empty" };
  }

  if (message.id) {
    markMessageSeen(message.id);
  }

  if (message.guild && !config.scanAdmins && isGuildAdmin(message)) {
    return { flagged: false, skipped: "admin" };
  }

  const contentAnalysis = analyzeMessageSignals(message);
  const hashAnalysis = await scanMessageImageHashes(message, db, {
    fetchAttachmentBuffer: config.fetchAttachmentBuffer,
  });

  let totalScore = contentAnalysis.score + (hashAnalysis.matched ? 80 : 0);
  const reasons = [...new Set([...contentAnalysis.reasons, ...hashAnalysis.reasons])];

  // Threshold: >= 65 is HIGH severity, >= 40 is MEDIUM severity
  if (totalScore < 40 || reasons.length === 0) {
    return {
      flagged: false,
      score: totalScore,
      hashes: hashAnalysis.hashes,
    };
  }

  const severity = totalScore >= 65 || hashAnalysis.matched || contentAnalysis.hasSuspiciousUrl ? "high" : "medium";
  const source = config.source || (message.guild ? "guild_realtime" : "dm");
  const authorId = message.author?.id || "unknown";
  const authorTag = message.author?.tag || message.author?.username || "unknown";
  const excerpt = String(message.content ?? "").trim().slice(0, 300);

  let actionTaken = "reported";
  if (message.guild && severity === "high" && config.autoDelete !== false && typeof message.delete === "function") {
    try {
      await message.delete();
      actionTaken = "deleted_and_reported";
    } catch {
      actionTaken = "reported";
    }
  }

  let incidentId = null;
  if (db && typeof db.execute === "function") {
    try {
      if (message.id) {
        const existing = await db.execute({
          sql: "SELECT id FROM scam_incidents WHERE message_id = ? LIMIT 1",
          args: [message.id],
        });
        if (existing.rows?.length > 0) {
          return {
            flagged: true,
            duplicate: true,
            incidentId: Number(existing.rows[0].id),
            severity,
            score: totalScore,
            reasons,
          };
        }
      }

      const insertRes = await db.execute({
        sql: `INSERT INTO scam_incidents (
          guild_id, channel_id, message_id, author_id, author_tag, source, severity, score,
          reasons_json, matched_urls_json, matched_hashes_json, content_excerpt, action_taken
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          message.guild?.id ?? null,
          message.channelId ?? message.channel?.id ?? null,
          message.id ?? null,
          authorId,
          authorTag,
          source,
          severity,
          totalScore,
          JSON.stringify(reasons),
          JSON.stringify(contentAnalysis.matchedUrls),
          JSON.stringify(hashAnalysis.hashes),
          excerpt,
          actionTaken,
        ],
      });
      incidentId = Number(insertRes.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String(err?.message ?? err))) {
        return { flagged: true, duplicate: true, severity, score: totalScore, reasons };
      }
      console.error("[PTB ScamShield] Failed to record scam incident:", err);
    }
  }

  // Send staff alert embed if an alert channel is configured
  const alertChannelId = resolveAlertChannelId(config);
  if (alertChannelId && client?.channels?.fetch) {
    try {
      const alertChannel = await client.channels.fetch(alertChannelId).catch(() => null);
      if (alertChannel && typeof alertChannel.send === "function") {
        const locationLabel = message.guild
          ? `<#${message.channelId ?? message.channel?.id}> (${message.guild.name})`
          : "Direct Message (DM)";

        const embed = new EmbedBuilder()
          .setColor(severity === "high" ? 0xDC2626 : 0xD97706)
          .setTitle(`ScamShield Alert${incidentId ? ` #${incidentId}` : ""} [${severity.toUpperCase()}]`)
          .setDescription(`Suspicious message detected from <@${authorId}> (\`${authorTag}\`).`)
          .addFields(
            { name: "Source", value: `${locationLabel} • \`${source}\``, inline: true },
            { name: "Action Taken", value: actionTaken === "deleted_and_reported" ? "Message Deleted & Logged" : "Logged for Review", inline: true },
            { name: "Confidence Score", value: String(totalScore), inline: true },
            { name: "Detection Signals", value: reasons.map((r) => `• ${r}`).join("\n").slice(0, 1024) },
          )
          .setTimestamp();

        if (contentAnalysis.matchedUrls.length > 0) {
          embed.addFields({
            name: "Flagged URLs (Defanged)",
            value: contentAnalysis.matchedUrls.map((u) => `• \`${defangUrl(u)}\``).join("\n").slice(0, 1024),
          });
        }

        if (excerpt) {
          embed.addFields({
            name: "Message Excerpt",
            value: `\`\`\`\n${excerpt.replace(/```/g, "'''").slice(0, 950)}\n\`\`\``,
          });
        }

        const components = [];
        if (incidentId) {
          components.push(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`scam:confirm:${incidentId}`)
                .setLabel("Confirm Scam & Block Hash")
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`scam:dismiss:${incidentId}`)
                .setLabel("Dismiss (False Positive)")
                .setStyle(ButtonStyle.Secondary)
            )
          );
        }

        await alertChannel.send({ embeds: [embed], components });
      }
    } catch (err) {
      console.error("[PTB ScamShield] Failed to send staff alert:", err);
    }
  }

  return {
    flagged: true,
    incidentId,
    severity,
    score: totalScore,
    reasons,
    matchedUrls: contentAnalysis.matchedUrls,
    hashes: hashAnalysis.hashes,
    actionTaken,
  };
}

/**
 * Handles staff review buttons (scam:confirm:<id> / scam:dismiss:<id>) on ScamShield alert embeds.
 * @param {any} db
 * @param {import("discord.js").ButtonInteraction} interaction
 */
export async function handleScamReviewButton(db, interaction) {
  if (!interaction.customId?.startsWith("scam:")) return;
  const [, action, incidentId] = interaction.customId.split(":");
  if (!["confirm", "dismiss"].includes(action) || !incidentId) return;

  if (!canReviewScamAlert(interaction)) {
    return interaction.reply({
      content: "Only server administrators or authorized staff can review ScamShield alerts.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (typeof interaction.deferUpdate === "function" && !interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  const newStatus = action === "confirm" ? "confirmed" : "dismissed";
  let matchedHashes = [];
  let updatedRows = 1;

  if (db && typeof db.execute === "function") {
    const existingRes = await db.execute({
      sql: "SELECT status, matched_hashes_json, reasons_json, reviewed_by FROM scam_incidents WHERE id = ? LIMIT 1",
      args: [incidentId],
    }).catch(() => null);
    const existing = existingRes?.rows?.[0];
    if (existing && existing.status !== "open") {
      const msg = `ScamShield Incident #${incidentId} has already been **${String(existing.status).toUpperCase()}**${existing.reviewed_by ? ` by <@${existing.reviewed_by}>` : ""}.`;
      if (interaction.deferred && typeof interaction.followUp === "function") {
        await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }

    if (existing?.matched_hashes_json) {
      try {
        matchedHashes = JSON.parse(existing.matched_hashes_json);
      } catch {
        matchedHashes = [];
      }
    }

    const updateRes = await db.execute({
      sql: "UPDATE scam_incidents SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'",
      args: [newStatus, interaction.user.id, incidentId],
    });
    if (updateRes?.rowsAffected !== undefined) {
      updatedRows = Number(updateRes.rowsAffected);
    }

    if (updatedRows > 0 && action === "confirm" && Array.isArray(matchedHashes)) {
      for (const h of matchedHashes) {
        if (!h?.sha256 && !h?.perceptualHash) continue;
        await db.execute({
          sql: "INSERT INTO scam_known_hashes (sha256, perceptual_hash, reason, added_by) VALUES (?, ?, ?, ?)",
          args: [
            h.sha256 ?? null,
            h.perceptualHash ?? null,
            `Confirmed incident #${incidentId}`,
            interaction.user.id,
          ],
        }).catch(() => {});
      }
    }
  }

  const oldEmbed = interaction.message?.embeds?.[0];
  if (oldEmbed) {
    const updatedEmbed = EmbedBuilder.from(oldEmbed)
      .setColor(action === "confirm" ? 0x991B1B : 0x475569)
      .addFields({
        name: "Staff Review",
        value: `**${newStatus.toUpperCase()}** by <@${interaction.user.id}>`,
      });
    await interaction.message.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});
  }
}

/**
 * Sweep all text-based channels in cached guilds, fetch the latest 15 messages per channel,
 * skip bots and previously seen message IDs, and scan messages containing attachments, embeds, or URLs.
 * Note: This periodic sweep only polls guild channels; DMs are scanned via real-time MessageCreate.
 *
 * @param {any} client
 * @param {any} [db=null]
 * @param {object} [config={}]
 * @returns {Promise<{ channelsScanned: number, messagesChecked: number, incidentsDetected: number }>}
 */
export async function scanRecentGuildChannels(client, db = null, config = {}) {
  const stats = { channelsScanned: 0, messagesChecked: 0, incidentsDetected: 0 };
  const guilds = getCollectionValues(client?.guilds?.cache);

  for (const guild of guilds) {
    const channels = getCollectionValues(guild?.channels?.cache);
    for (const channel of channels) {
      if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) continue;
      if (typeof channel.messages?.fetch !== "function") continue;

      stats.channelsScanned += 1;
      let messages;
      try {
        messages = await channel.messages.fetch({ limit: PERIODIC_FETCH_LIMIT });
      } catch {
        continue;
      }

      const messageList = getCollectionValues(messages);
      for (const msg of messageList) {
        if (!msg || msg.author?.bot) continue;
        if (msg.id && seenScannedMessageIds.has(msg.id)) continue;

        if (msg.id) {
          markMessageSeen(msg.id);
        }

        if (!messageHasScannablePayload(msg)) continue;

        stats.messagesChecked += 1;
        const result = await handleMessage(msg, client, { ...config, source: "guild_sweep" }, db).catch(() => null);
        if (result?.flagged && !result?.duplicate) {
          stats.incidentsDetected += 1;
        }
      }
    }
  }

  return stats;
}

let activeScannerInterval = null;

/**
 * Start the 10-second periodic guild channel scanner (idempotent; replaces any prior interval).
 * @param {any} client
 * @param {any} [db=null]
 * @param {{ intervalMs?: number, alertChannelId?: string }} [config={}]
 */
export function startPeriodicScanner(client, db = null, config = {}) {
  if (activeScannerInterval) {
    clearInterval(activeScannerInterval);
    activeScannerInterval = null;
  }

  const intervalMs = Number(config.intervalMs) > 0 ? Number(config.intervalMs) : PERIODIC_SCAN_INTERVAL_MS;
  let scanning = false;

  const runOnce = async () => {
    if (scanning) return null;
    scanning = true;
    try {
      return await scanRecentGuildChannels(client, db, config);
    } catch (error) {
      console.error("[PTB ScamShield] Periodic guild scan failed:", error);
      return null;
    } finally {
      scanning = false;
    }
  };

  activeScannerInterval = setInterval(() => {
    void runOnce();
  }, intervalMs);
  activeScannerInterval.unref?.();

  return {
    interval: activeScannerInterval,
    runOnce,
    stop() {
      if (activeScannerInterval) {
        clearInterval(activeScannerInterval);
        activeScannerInterval = null;
      }
    },
  };
}
