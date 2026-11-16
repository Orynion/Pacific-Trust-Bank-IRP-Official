import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  applicationSchemaStatements,
  ensureApplicationRejectionReasonColumn,
  handleApplicationRejectModal,
  handleApplicationReviewButton,
} from "./applications.js";

const dirs = [];
test.after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

async function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "ptb-app-test-"));
  dirs.push(dir);
  const db = createClient({ url: `file:${join(dir, "test.db").replace(/\\/g, "/")}` });
  await db.batch(applicationSchemaStatements, "write");
  return db;
}

async function seedPendingApplication(db, userId = "200000000000000001") {
  const res = await db.execute({
    sql: "INSERT INTO applications (user_id, username, answers_json, status) VALUES (?, ?, ?, 'pending')",
    args: [userId, "applicant#0001", JSON.stringify({ role_desired: "Bank Teller" })],
  });
  return String(res.lastInsertRowid);
}

function makeReviewMessage() {
  const baseEmbed = new EmbedBuilder()
    .setColor(0x2563EB)
    .setTitle("New Staff Application #1 (Bank Teller)")
    .setDescription("Applicant: <@200000000000000001>");
  const edits = [];
  return {
    embeds: [baseEmbed.toJSON()],
    edits,
    async edit(payload) {
      edits.push(payload);
    },
  };
}

function makeClientWithDmSink(sentDms) {
  return {
    users: {
      async fetch(id) {
        return {
          id,
          async createDM() {
            return {
              async send(payload) {
                sentDms.push({ id, ...payload });
              },
            };
          },
        };
      },
    },
  };
}

test("legacy applications table gets rejection_reason column via idempotent migration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-app-legacy-"));
  dirs.push(dir);
  const db = createClient({ url: `file:${join(dir, "legacy.db").replace(/\\/g, "/")}` });
  await db.execute(`CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  try {
    assert.equal(await ensureApplicationRejectionReasonColumn(db), true);
    assert.equal(await ensureApplicationRejectionReasonColumn(db), true);
    await db.execute({
      sql: "INSERT INTO applications (user_id, username, answers_json, status, rejection_reason) VALUES ('u1', 'user', '{}', 'rejected', 'Insufficient availability')",
      args: [],
    });
    const row = await db.execute("SELECT rejection_reason FROM applications WHERE user_id = 'u1'");
    assert.equal(row.rows[0].rejection_reason, "Insufficient availability");
  } finally {
    await db.close();
  }
});

test("clicking Reject Application opens an optional-reason modal for reviewers and blocks non-admins", async () => {
  const db = await openDb();
  const appId = await seedPendingApplication(db);
  try {
    let deniedReply = null;
    await handleApplicationReviewButton(db, {
      customId: `app:reject:${appId}:200000000000000001`,
      user: { id: "9001" },
      memberPermissions: { has: () => false },
      reply: async (payload) => { deniedReply = payload; },
      showModal: async () => { throw new Error("should not show modal to non-admin"); },
    });
    assert.equal(deniedReply.flags, MessageFlags.Ephemeral);
    assert.match(deniedReply.content, /Only administrators/);

    let shownModal = null;
    await handleApplicationReviewButton(db, {
      customId: `app:reject:${appId}:200000000000000001`,
      user: { id: "3001" },
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      showModal: async (modal) => { shownModal = modal.toJSON(); },
    });

    assert.ok(shownModal, "modal should be displayed");
    assert.equal(shownModal.custom_id, `app:reject-modal:${appId}:200000000000000001`);
    const input = shownModal.components[0].components[0];
    assert.equal(input.custom_id, "reason");
    assert.equal(input.required, false);
    assert.match(input.label, /optional/i);

    const row = await db.execute({ sql: "SELECT status FROM applications WHERE id = ?", args: [appId] });
    assert.equal(row.rows[0].status, "pending");
  } finally {
    await db.close();
  }
});

test("submitting rejection modal with a reason records it, DMs applicant, and updates review embed", async () => {
  const db = await openDb();
  const appId = await seedPendingApplication(db, "200000000000000001");
  const sentDms = [];
  const message = makeReviewMessage();
  let deferred = false;
  try {
    await handleApplicationRejectModal(db, {
      customId: `app:reject-modal:${appId}:200000000000000001`,
      isModalSubmit: () => true,
      user: { id: "3001", tag: "Reviewer#0001" },
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      fields: { getTextInputValue: (id) => (id === "reason" ? "  Needs more roleplay experience  " : "") },
      message,
      client: makeClientWithDmSink(sentDms),
      deferUpdate: async () => { deferred = true; },
    });

    assert.equal(deferred, true);
    const row = await db.execute({
      sql: "SELECT status, reviewed_by, rejection_reason FROM applications WHERE id = ?",
      args: [appId],
    });
    assert.equal(row.rows[0].status, "rejected");
    assert.equal(row.rows[0].reviewed_by, "3001");
    assert.equal(row.rows[0].rejection_reason, "Needs more roleplay experience");

    assert.equal(sentDms.length, 1);
    assert.match(sentDms[0].content, /not accepted at this time/);
    assert.match(sentDms[0].content, /Reason:\*\* Needs more roleplay experience/);

    assert.equal(message.edits.length, 1);
    assert.deepEqual(message.edits[0].components, []);
    const fields = message.edits[0].embeds[0].data.fields;
    assert.ok(fields.some((f) => f.name === "Review Status" && /\*\*REJECTED\*\* by <@3001>/.test(f.value)));
    assert.ok(fields.some((f) => f.name === "Rejection Reason" && f.value === "Needs more roleplay experience"));
  } finally {
    await db.close();
  }
});

test("submitting rejection modal without a reason rejects cleanly with null rejection_reason", async () => {
  const db = await openDb();
  const appId = await seedPendingApplication(db, "200000000000000002");
  const sentDms = [];
  const message = makeReviewMessage();
  try {
    await handleApplicationRejectModal(db, {
      customId: `app:reject-modal:${appId}:200000000000000002`,
      isModalSubmit: () => true,
      user: { id: "3002", tag: "Reviewer#0002" },
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      fields: { getTextInputValue: () => "   " },
      message,
      client: makeClientWithDmSink(sentDms),
      deferUpdate: async () => {},
    });

    const row = await db.execute({
      sql: "SELECT status, reviewed_by, rejection_reason FROM applications WHERE id = ?",
      args: [appId],
    });
    assert.equal(row.rows[0].status, "rejected");
    assert.equal(row.rows[0].reviewed_by, "3002");
    assert.equal(row.rows[0].rejection_reason, null);

    assert.equal(sentDms.length, 1);
    assert.match(sentDms[0].content, /not accepted at this time/);
    assert.doesNotMatch(sentDms[0].content, /Reason:/);

    const fields = message.edits[0].embeds[0].data.fields;
    assert.ok(fields.some((f) => f.name === "Review Status" && /\*\*REJECTED\*\* by <@3002>/.test(f.value)));
    assert.equal(fields.some((f) => f.name === "Rejection Reason"), false);
  } finally {
    await db.close();
  }
});

test("rejection modal refuses non-admins and prevents duplicate review overwrites", async () => {
  const db = await openDb();
  const appId = await seedPendingApplication(db, "200000000000000003");
  const sentDms = [];
  try {
    let deniedReply = null;
    await handleApplicationRejectModal(db, {
      customId: `app:reject-modal:${appId}:200000000000000003`,
      isModalSubmit: () => true,
      user: { id: "9999" },
      memberPermissions: { has: () => false },
      fields: { getTextInputValue: () => "Spoofed" },
      reply: async (payload) => { deniedReply = payload; },
    });
    assert.equal(deniedReply.flags, MessageFlags.Ephemeral);
    assert.match(deniedReply.content, /Only administrators/);

    await handleApplicationRejectModal(db, {
      customId: `app:reject-modal:${appId}:200000000000000003`,
      isModalSubmit: () => true,
      user: { id: "3001" },
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      fields: { getTextInputValue: () => "First decision" },
      message: makeReviewMessage(),
      client: makeClientWithDmSink(sentDms),
      deferUpdate: async () => {},
    });

    let replayFollowUp = null;
    await handleApplicationRejectModal(db, {
      customId: `app:reject-modal:${appId}:200000000000000003`,
      isModalSubmit: () => true,
      user: { id: "3002" },
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      fields: { getTextInputValue: () => "Second decision" },
      message: makeReviewMessage(),
      client: makeClientWithDmSink(sentDms),
      deferred: true,
      deferUpdate: async () => {},
      followUp: async (payload) => { replayFollowUp = payload; },
    });

    assert.equal(sentDms.length, 1);
    assert.match(replayFollowUp.content, /already been \*\*REJECTED\*\*/);
    const row = await db.execute({
      sql: "SELECT reviewed_by, rejection_reason FROM applications WHERE id = ?",
      args: [appId],
    });
    assert.equal(row.rows[0].reviewed_by, "3001");
    assert.equal(row.rows[0].rejection_reason, "First decision");
  } finally {
    await db.close();
  }
});
