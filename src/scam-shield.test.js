import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import sharp from "sharp";
import { PermissionFlagsBits } from "discord.js";
import {
  computePerceptualHash,
  computeSha256,
  hammingDistance,
  isPerceptuallySimilar,
} from "./perceptual-hash.js";
import {
  defangUrl,
  handleMessage,
  handleScamReviewButton,
  markMessageSeen,
  MAX_SEEN_SCANNED_IDS,
  scanRecentGuildChannels,
  scamShieldSchemaStatements,
  seenScannedMessageIds,
  startPeriodicScanner,
} from "./scam-shield.js";

const dirs = [];
test.after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

async function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "ptb-scam-test-"));
  dirs.push(dir);
  const db = createClient({ url: `file:${join(dir, "test.db").replace(/\\/g, "/")}` });
  await db.batch(scamShieldSchemaStatements, "write");
  return db;
}

async function makeGradientImageBuffer(format = "png", brightnessOffset = 0) {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      const val = Math.max(0, Math.min(255, Math.floor((x / width) * 220) + brightnessOffset));
      raw[idx] = val;
      raw[idx + 1] = Math.floor((y / height) * 180);
      raw[idx + 2] = 100;
    }
  }
  const pipeline = sharp(raw, { raw: { width, height, channels: 3 } });
  return format === "jpeg" ? pipeline.jpeg({ quality: 85 }).toBuffer() : pipeline.png().toBuffer();
}

async function makeInvertedImageBuffer() {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      raw[idx] = 255 - Math.floor((x / width) * 220);
      raw[idx + 1] = 40;
      raw[idx + 2] = 200;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test("perceptual-hash computes 64-bit dHash across PNG/JPEG and detects visual similarity", async () => {
  const pngBuf = await makeGradientImageBuffer("png", 0);
  const jpgBuf = await makeGradientImageBuffer("jpeg", 5);
  const diffBuf = await makeInvertedImageBuffer();

  const pngHash = await computePerceptualHash(pngBuf);
  const jpgHash = await computePerceptualHash(jpgBuf);
  const diffHash = await computePerceptualHash(diffBuf);

  assert.match(pngHash, /^[0-9a-f]{16}$/);
  assert.match(jpgHash, /^[0-9a-f]{16}$/);
  assert.match(diffHash, /^[0-9a-f]{16}$/);

  const sameSim = isPerceptuallySimilar(pngHash, jpgHash, 8);
  assert.equal(sameSim.similar, true);
  assert.ok(sameSim.distance <= 8, `expected small distance, got ${sameSim.distance}`);

  const diffDist = hammingDistance(pngHash, diffHash);
  assert.ok(diffDist > 20, `expected large distance for inverted image, got ${diffDist}`);
  assert.equal(await computePerceptualHash(Buffer.from("not an image")), null);
});

test("handleMessage flags phishing DMs and guild scams, deletes high-severity guild messages, and ignores benign traffic", async () => {
  const db = await openDb();
  const alertMessages = [];
  const mockClient = {
    channels: {
      async fetch(id) {
        if (id === "mod-log-1") {
          return {
            async send(payload) {
              alertMessages.push(payload);
            },
          };
        }
        return null;
      },
    },
  };

  try {
    // 1. Benign message with trusted Discord/Roblox links should NOT be flagged
    const benignResult = await handleMessage(
      {
        id: "msg-benign-1",
        author: { id: "user-1", tag: "User#0001", bot: false },
        guild: { id: "guild-1", name: "PTB Server" },
        channelId: "chan-1",
        content: "Verify via https://verify.blox.link or check https://discord.com/guidelines",
      },
      mockClient,
      { alertChannelId: "mod-log-1" },
      db,
    );
    assert.equal(benignResult.flagged, false);
    assert.equal(alertMessages.length, 0);

    // 2. Phishing DM message should be flagged and reported to staff with defanged URL
    const dmScamResult = await handleMessage(
      {
        id: "msg-dm-scam-1",
        author: { id: "scammer-1", tag: "Scammer#1337", bot: false },
        guild: null,
        channelId: "dm-1",
        content: "Claim your free nitro gift here: https://dlscord-nitro.com/claim",
      },
      mockClient,
      { alertChannelId: "mod-log-1" },
      db,
    );
    assert.equal(dmScamResult.flagged, true);
    assert.equal(dmScamResult.severity, "high");
    assert.equal(alertMessages.length, 1);
    const alertEmbed = alertMessages[0].embeds[0].toJSON();
    assert.match(alertEmbed.title, /\[HIGH\]/);
    assert.ok(alertEmbed.fields.some((f) => f.name === "Flagged URLs (Defanged)" && /hxxps:\/\/dlscord-nitro\[.\]com/.test(f.value)));
    assert.equal(defangUrl("https://evil.test"), "hxxps://evil[.]test");

    // 3. High-severity guild scam should be auto-deleted and logged
    let deleted = false;
    const guildScamResult = await handleMessage(
      {
        id: "msg-guild-scam-1",
        author: { id: "scammer-2", tag: "Scammer#2222", bot: false },
        guild: { id: "guild-1", name: "PTB Server" },
        channelId: "chan-1",
        content: "@everyone Claim free Robux now at https://robiox.com/free",
        async delete() {
          deleted = true;
        },
      },
      mockClient,
      { alertChannelId: "mod-log-1" },
      db,
    );
    assert.equal(guildScamResult.flagged, true);
    assert.equal(guildScamResult.actionTaken, "deleted_and_reported");
    assert.equal(deleted, true);

    const rows = await db.execute("SELECT COUNT(*) AS cnt FROM scam_incidents");
    assert.equal(Number(rows.rows[0].cnt), 2);
  } finally {
    await db.close();
  }
});

test("confirming a scam incident stores attachment perceptual hash and catches visually similar re-uploads", async () => {
  const db = await openDb();
  const pngScam = await makeGradientImageBuffer("png", 0);
  const jpgReupload = await makeGradientImageBuffer("jpeg", 4);
  const alertMessages = [];
  const mockClient = {
    channels: {
      async fetch() {
        return {
          async send(payload) {
            alertMessages.push(payload);
          },
        };
      },
    },
  };

  try {
    // Seed an incident containing an image attachment
    const first = await handleMessage(
      {
        id: "msg-img-1",
        author: { id: "scammer-3", tag: "Scammer#3333", bot: false },
        guild: { id: "guild-1", name: "PTB Server" },
        channelId: "chan-1",
        content: "Free nitro giveaway! https://discord-gift.example.com/nitro",
        attachments: [{ name: "nitro.png", contentType: "image/png", size: pngScam.length, url: "mem://png" }],
      },
      mockClient,
      {
        alertChannelId: "mod-log-1",
        fetchAttachmentBuffer: async () => pngScam,
      },
      db,
    );
    assert.equal(first.flagged, true);
    assert.equal(first.hashes.length, 1);
    assert.equal(first.hashes[0].sha256, computeSha256(pngScam));

    // Staff clicks Confirm Scam & Block Hash
    const edits = [];
    await handleScamReviewButton(db, {
      customId: `scam:confirm:${first.incidentId}`,
      user: { id: "admin-1" },
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      message: {
        embeds: [alertMessages[0].embeds[0].toJSON()],
        async edit(payload) {
          edits.push(payload);
        },
      },
      async deferUpdate() {},
    });
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].components, []);

    const known = await db.execute("SELECT * FROM scam_known_hashes");
    assert.equal(known.rows.length, 1);

    // Now a DIFFERENT user uploads a re-compressed JPEG variant with NO text or URLs at all
    const reuploadResult = await handleMessage(
      {
        id: "msg-img-2",
        author: { id: "alt-4", tag: "Alt#4444", bot: false },
        guild: { id: "guild-1", name: "PTB Server" },
        channelId: "chan-2",
        content: "",
        attachments: [{ name: "promo.jpg", contentType: "image/jpeg", size: jpgReupload.length, url: "mem://jpg" }],
      },
      mockClient,
      {
        alertChannelId: "mod-log-1",
        fetchAttachmentBuffer: async () => jpgReupload,
      },
      db,
    );
    assert.equal(reuploadResult.flagged, true);
    assert.equal(reuploadResult.severity, "high");
    assert.ok(reuploadResult.reasons.some((r) => /Visually similar to known scam image/i.test(r)));
  } finally {
    await db.close();
  }
});

test("seenScannedMessageIds stays capped at 10,000 and scanRecentGuildChannels sweeps text channels cleanly", async () => {
  seenScannedMessageIds.clear();
  for (let i = 0; i < MAX_SEEN_SCANNED_IDS + 25; i += 1) {
    markMessageSeen(`cap-${i}`);
  }
  assert.equal(seenScannedMessageIds.size, MAX_SEEN_SCANNED_IDS);
  assert.equal(seenScannedMessageIds.has("cap-0"), false);
  assert.equal(seenScannedMessageIds.has(`cap-${MAX_SEEN_SCANNED_IDS + 24}`), true);

  seenScannedMessageIds.clear();
  const db = await openDb();
  const alerts = [];

  const textMessages = [
    { id: "m-bot", author: { id: "b1", bot: true }, content: "https://dlscord.com/free" },
    { id: "m-plain", author: { id: "u1", bot: false }, content: "just chatting, no urls or embeds" },
    { id: "m-seen", author: { id: "u2", bot: false }, content: "https://dlscord-nitro.com/a" },
    {
      id: "m-scam",
      author: { id: "u3", tag: "Bad#0003", bot: false },
      guild: { id: "g1", name: "PTB" },
      channelId: "c-text",
      content: "Check this out: https://dlscord-nitro.com/gift",
    },
  ];
  markMessageSeen("m-seen");

  const mockClient = {
    guilds: {
      cache: new Map([
        [
          "g1",
          {
            id: "g1",
            name: "PTB",
            channels: {
              cache: new Map([
                ["c-voice", { id: "c-voice", isTextBased: () => false }],
                [
                  "c-locked",
                  {
                    id: "c-locked",
                    isTextBased: () => true,
                    messages: {
                      async fetch() {
                        throw new Error("Missing Access");
                      },
                    },
                  },
                ],
                [
                  "c-text",
                  {
                    id: "c-text",
                    isTextBased: () => true,
                    messages: {
                      async fetch({ limit }) {
                        assert.equal(limit, 15);
                        return textMessages;
                      },
                    },
                  },
                ],
              ]),
            },
          },
        ],
      ]),
    },
    channels: {
      async fetch(id) {
        if (id === "mod-log-1") {
          return {
            async send(payload) {
              alerts.push(payload);
            },
          };
        }
        return null;
      },
    },
  };

  try {
    const stats = await scanRecentGuildChannels(mockClient, db, { alertChannelId: "mod-log-1" });
    assert.equal(stats.channelsScanned, 2);
    assert.equal(stats.messagesChecked, 1);
    assert.equal(stats.incidentsDetected, 1);
    assert.equal(alerts.length, 1);

    // Second sweep immediately after skips already-seen messages
    const secondStats = await scanRecentGuildChannels(mockClient, db, { alertChannelId: "mod-log-1" });
    assert.equal(secondStats.messagesChecked, 0);
    assert.equal(secondStats.incidentsDetected, 0);

    // startPeriodicScanner starts and stops cleanly
    const handle = startPeriodicScanner(mockClient, db, { intervalMs: 10_000, alertChannelId: "mod-log-1" });
    assert.ok(handle.interval);
    handle.stop();
  } finally {
    seenScannedMessageIds.clear();
    await db.close();
  }
});
