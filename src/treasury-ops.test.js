import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PermissionFlagsBits } from "discord.js";
import { applyTreasuryReview, handleDepositTicketImage, handleTreasuryButton, handleTreasuryReport, inspectReceiptText, submitTreasuryPayment, treasuryReviewer, treasurySchemaStatements, validateReceiptInput } from "./treasury-ops.js";
import { schemaStatements } from "./bank-ops.js";
import { ticketSchemaStatements } from "./ticket-ops.js";

const dirs = [];
test.after(async () => { for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch {} } });
async function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "ptb-treasury-test-")); dirs.push(dir);
  const db = createClient({ url: `file:${join(dir, "test.db").replace(/\\/g, "/")}` });
  await db.batch([...schemaStatements, ...ticketSchemaStatements, ...treasurySchemaStatements], "write");
  return db;
}
const ADMIN = { memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator } };

test("OCR findings identify amount mismatch and unreadable screenshots as review-only", () => {
  const mismatch = inspectReceiptText("Payer Alice paid IRP Treasury Amount: 500", { payer: "Alice", amount: 400 });
  assert.equal(mismatch.extractedAmount, 500);
  assert.ok(mismatch.findings.includes("AMOUNT_MISMATCH"));
  const unreadable = inspectReceiptText("", { payer: "Alice", amount: 400 });
  assert.ok(unreadable.findings.includes("OCR_UNAVAILABLE_OR_UNREADABLE"));
  assert.ok(unreadable.findings.includes("AMOUNT_NOT_READABLE"));
});

test("permission checks allow only configured roles and administrators", () => {
  assert.equal(treasuryReviewer({ memberPermissions: { has: () => false }, member: { roles: { cache: new Map([["r1", true]]) } } }, "r1,r2"), true);
  assert.equal(treasuryReviewer({ memberPermissions: { has: () => false }, member: { roles: { cache: new Map() } } }, "r1,r2"), false);
  assert.equal(treasuryReviewer(ADMIN, ""), true);
});

test("submission records exact screenshot duplicates and keeps them for review", async () => {
  const db = await openDb();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZ8AAAAASUVORK5CYII=", "base64");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } });
  try {
    const results = [];
    const makeInteraction = () => ({
      user: { id: "100" }, client: { channels: { fetch: async () => ({ guildId: "guild", type: 0, permissionsFor: (target) => ({ has: () => target !== "everyone" }), send: async () => {} }) } },
      guild: { id: "guild", roles: { everyone: "everyone", cache: new Map() }, members: { me: "bot" } },
      options: { getString: (name) => name === "payer" ? "Alice_1" : "Salary", getInteger: () => 500, getAttachment: () => ({ contentType: "image/png", size: png.length, url: "https://cdn.example/receipt.png", name: "receipt.png" }) },
      inGuild: () => true, deferReply: async () => {}, editReply: async (content) => results.push(content),
    });
    await submitTreasuryPayment(db, makeInteraction(), { reviewChannelId: "chan" });
    await submitTreasuryPayment(db, makeInteraction(), { reviewChannelId: "chan" });
    const rows = await db.execute("SELECT reference,status,duplicate_of,perceptual_hash FROM treasury_submissions ORDER BY id");
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0].reference, "IRPT-000001");
    assert.equal(rows.rows[1].status, "DUPLICATE");
    assert.equal(rows.rows[1].duplicate_of, "IRPT-000001");
    assert.ok(rows.rows[0].perceptual_hash);
    assert.match(results[0], /IRPT-000001/);
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});

test("input validation requires an image and positive supported amount", () => {
  const base = { payer: "Alice_1", amount: 5, purpose: "Donation", attachment: { contentType: "image/png", size: 50 } };
  assert.equal(validateReceiptInput(base), null);
  assert.match(validateReceiptInput({ ...base, amount: 0 }), /positive whole number/);
  assert.match(validateReceiptInput({ ...base, attachment: null }), /Attach a screenshot/);
  assert.match(validateReceiptInput({ ...base, attachment: { contentType: "text/plain", size: 50 } }), /PNG, JPEG, or WebP/);
});

test("unauthorized approval is refused; concurrent reviews cannot double finalize", async () => {
  const db = await openDb();
  await db.execute({ sql: "INSERT INTO treasury_submissions (reference,submitter_id,payer_username,amount,purpose,attachment_url,attachment_name,screenshot_hash,status) VALUES ('IRPT-000001','100','Alice',50,'Fee','https://example.test/a','a.png','abc','PENDING')" });
  let denied;
  await handleTreasuryButton(db, { ...ADMIN, memberPermissions: { has: () => false }, member: { roles: { cache: new Map() } }, reply: async (v) => { denied = v; } }, "approve", "IRPT-000001", "reviewer-role");
  assert.match(denied.content, /Only configured/);
  const results = await Promise.allSettled([
    applyTreasuryReview(db, "IRPT-000001", "reviewer-a", "VERIFIED", "checked"),
    applyTreasuryReview(db, "IRPT-000001", "reviewer-b", "REJECTED", "declined"),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled" && item.value.ok).length, 1);
  assert.ok(results.some((item) => item.status === "rejected" || !item.value?.ok));
  const row = await db.execute("SELECT status FROM treasury_submissions WHERE reference='IRPT-000001'");
  assert.ok(["VERIFIED", "REJECTED"].includes(row.rows[0].status));
  const audit = await db.execute("SELECT COUNT(*) count FROM treasury_audit_log WHERE reference='IRPT-000001'");
  assert.equal(Number(audit.rows[0].count), 1);
  await db.close();
});

test("reports count only verified amounts", async () => {
  const db = await openDb();
  for (const [ref, status, amount] of [["IRPT-000001", "VERIFIED", 120], ["IRPT-000002", "PENDING", 80], ["IRPT-000003", "REJECTED", 90]]) {
    await db.execute({ sql: "INSERT INTO treasury_submissions (reference,submitter_id,payer_username,amount,purpose,attachment_url,attachment_name,screenshot_hash,status) VALUES (?,?,?,?,?,'url','a.png',?,?)", args: [ref, "100", "Alice", amount, "Donation", ref, status] });
  }
  let reply;
  await handleTreasuryReport(db, { ...ADMIN, reply: async (payload) => { reply = payload; } }, "", {});
  const description = reply.embeds[0].data.description;
  assert.match(description, /Verified total: 120/);
  assert.match(description, /Pending \/ review: 1/);
  assert.match(description, /Rejected: 1/);
  await db.close();
});

test("first image in a pending deposit ticket gets an advisory detection report", async () => {
  const db = await openDb();
  await db.execute({ sql: "INSERT INTO accounts (discord_id,roblox_id,roblox_username) VALUES ('100','r1','Alice_1')" });
  await db.execute({ sql: "INSERT INTO tickets (id,kind,requester_id,amount,status,channel_id) VALUES (7,'deposit','100',500,'pending','channel-7')" });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZ8AAAAASUVORK5CYII=", "base64");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(png, { status: 200, headers: { "content-length": String(png.length) } });
  let sent;
  try {
    const message = {
      guild: {}, author: { id: "100", bot: false }, channelId: "channel-7",
      channel: { topic: "ptb-ticket:deposit:100:500:7", send: async (payload) => { sent = payload; } },
      attachments: new Map([["att", { contentType: "image/png", size: png.length, url: "https://cdn.example/receipt.png", name: "proof.png" }]]),
    };
    assert.equal(await handleDepositTicketImage(db, message), true);
    assert.match(sent.embeds[0].data.title, /Experimental receipt detection/);
    const saved = await db.execute("SELECT ticket_id,extracted_amount FROM treasury_ticket_receipt_checks");
    assert.equal(Number(saved.rows[0].ticket_id), 7);
  } finally { globalThis.fetch = originalFetch; await db.close(); }
});
