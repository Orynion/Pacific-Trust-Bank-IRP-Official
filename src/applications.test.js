import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  activeApplicationSessions,
  APPLICATION_QUESTIONS,
  applicationSchemaStatements,
  DEFAULT_APPLICATIONS_REVIEW_CHANNEL_ID,
  ensureApplicationRejectionReasonColumn,
  handleApplicationApplyButton,
  handleApplicationCommand,
  handleApplicationRejectModal,
  handleApplicationReviewButton,
  handleDirectMessage,
  resolveReviewChannelId,
  SESSION_TIMEOUT_MS,
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

test("interactive DM questionnaire progresses through 5 questions, guards empty replies, confirms via embed, and notifies staff", async () => {
  const db = await openDb();
  const userId = "200000000000000099";
  activeApplicationSessions.delete(userId);
  const sentDmMessages = [];
  const staffChannelMessages = [];

  await db.execute({
    sql: "INSERT INTO application_settings (key, value) VALUES ('status', 'open'), ('review_channel_id', 'rev-chan-1')",
    args: [],
  });

  const mockClient = {
    channels: {
      async fetch(id) {
        if (id === "rev-chan-1") {
          return {
            async send(payload) {
              staffChannelMessages.push(payload);
            },
          };
        }
        return null;
      },
    },
  };

  try {
    let editReplyPayload = null;
    await handleApplicationApplyButton(db, {
      customId: "app:apply_rep",
      user: {
        id: userId,
        username: "ApplicantRep",
        async createDM() {
          return {
            async send(payload) {
              sentDmMessages.push(payload);
            },
          };
        },
      },
      async deferReply() {},
      async editReply(payload) {
        editReplyPayload = payload;
      },
    });

    assert.match(editReplyPayload.content, /Questionnaire Started/);
    assert.equal(sentDmMessages.length, 1);
    assert.match(sentDmMessages[0].content, /1\/5\./);
    assert.ok(activeApplicationSessions.has(userId));

    // Empty reply should prompt again without advancing step
    const replies = [];
    const makeDmMsg = (content) => ({
      author: { id: userId, username: "ApplicantRep", tag: "ApplicantRep#0001", bot: false },
      guild: null,
      client: mockClient,
      content,
      async reply(payload) {
        replies.push(payload);
      },
    });

    const emptyHandled = await handleDirectMessage(makeDmMsg("   "), mockClient, db);
    assert.equal(emptyHandled, true);
    assert.equal(activeApplicationSessions.get(userId).step, 0);
    assert.match(replies.at(-1), /Please enter a text answer/);

    // Answer all 5 questions
    const answers = [
      "RobloxUser / 12345678",
      "ApplicantRep#0001",
      "2 years banking RP",
      "EST / 15 hours",
      "Verify staff approval first before processing",
    ];
    for (let i = 0; i < answers.length; i += 1) {
      const handled = await handleDirectMessage(makeDmMsg(answers[i]), mockClient, db);
      assert.equal(handled, true);
    }

    // Session cleared, DB row inserted, DM confirmation embed sent, staff review posted
    assert.equal(activeApplicationSessions.has(userId), false);
    const dbRes = await db.execute({ sql: "SELECT * FROM applications WHERE user_id = ?", args: [userId] });
    assert.equal(dbRes.rows.length, 1);
    assert.equal(dbRes.rows[0].status, "pending");
    const parsedAnswers = JSON.parse(dbRes.rows[0].answers_json);
    assert.equal(parsedAnswers.role_desired, "Bank Representative");
    assert.equal(parsedAnswers.roblox_identity, answers[0]);
    assert.equal(parsedAnswers.scenario, answers[4]);

    const finalDmReply = replies.at(-1);
    assert.ok(finalDmReply.embeds && finalDmReply.embeds.length === 1);
    assert.match(finalDmReply.embeds[0].data.title, /Application Submitted/);

    assert.equal(staffChannelMessages.length, 1);
    assert.equal(staffChannelMessages[0].components.length, 1);
    assert.equal(staffChannelMessages[0].embeds[0].data.fields.length, 6);
  } finally {
    activeApplicationSessions.delete(userId);
    await db.close();
  }
});

test("DM questionnaire supports cancel and expires after 30 minutes (SESSION_TIMEOUT_MS)", async () => {
  const db = await openDb();
  const userId = "200000000000000088";
  activeApplicationSessions.delete(userId);
  const replies = [];
  const makeDmMsg = (content) => ({
    author: { id: userId, username: "CancelUser", bot: false },
    guild: null,
    content,
    async reply(payload) {
      replies.push(payload);
    },
  });

  try {
    activeApplicationSessions.set(userId, {
      roleDesired: "Bank Teller",
      step: 1,
      currentIndex: 1,
      answers: { roblox_identity: "User / 1" },
      startedAt: Date.now() - SESSION_TIMEOUT_MS - 1000,
      createdAt: Date.now() - SESSION_TIMEOUT_MS - 1000,
    });

    const expiredHandled = await handleDirectMessage(makeDmMsg("My answer"), null, db);
    assert.equal(expiredHandled, true);
    assert.equal(activeApplicationSessions.has(userId), false);
    assert.match(replies.at(-1), /Expired/i);

    // Start a fresh session and cancel it
    activeApplicationSessions.set(userId, {
      roleDesired: "Bank Teller",
      step: 0,
      currentIndex: 0,
      answers: {},
      startedAt: Date.now(),
      createdAt: Date.now(),
    });
    const cancelHandled = await handleDirectMessage(makeDmMsg("CANCEL"), null, db);
    assert.equal(cancelHandled, true);
    assert.equal(activeApplicationSessions.has(userId), false);
    assert.match(replies.at(-1), /Cancelled/i);
  } finally {
    activeApplicationSessions.delete(userId);
    await db.close();
  }
});

test("OWNER_ROLE_ID reviewer can accept via app:review:accept and assign REPRESENTATIVE_ROLE_ID", async () => {
  const db = await openDb();
  const appId = await seedPendingApplication(db, "200000000000000077");
  const prevOwner = process.env.OWNER_ROLE_ID;
  const prevRep = process.env.REPRESENTATIVE_ROLE_ID;
  process.env.OWNER_ROLE_ID = "owner-role-1";
  process.env.REPRESENTATIVE_ROLE_ID = "rep-role-1";

  const sentDms = [];
  const addedRoles = [];
  const message = makeReviewMessage();

  try {
    await handleApplicationReviewButton(db, {
      customId: `app:review:accept:${appId}:200000000000000077`,
      user: { id: "owner-1", tag: "Owner#0001" },
      member: {
        permissions: { has: () => false },
        roles: { cache: new Set(["owner-role-1"]) },
      },
      guild: {
        members: {
          async fetch(id) {
            return {
              id,
              roles: {
                async add(roleId) {
                  addedRoles.push(roleId);
                },
              },
            };
          },
        },
      },
      message,
      client: makeClientWithDmSink(sentDms),
      async deferUpdate() {},
    });

    assert.deepEqual(addedRoles, ["rep-role-1"]);
    assert.equal(sentDms.length, 1);
    assert.match(sentDms[0].content, /ACCEPTED/);
    const row = await db.execute({ sql: "SELECT status, reviewed_by FROM applications WHERE id = ?", args: [appId] });
    assert.equal(row.rows[0].status, "accepted");
    assert.equal(row.rows[0].reviewed_by, "owner-1");
  } finally {
    if (prevOwner === undefined) delete process.env.OWNER_ROLE_ID;
    else process.env.OWNER_ROLE_ID = prevOwner;
    if (prevRep === undefined) delete process.env.REPRESENTATIVE_ROLE_ID;
    else process.env.REPRESENTATIVE_ROLE_ID = prevRep;
    await db.close();
  }
});

test("review channel defaults to 1571934368619045056 and is not overwritten by public panel channel", async () => {
  const db = await openDb();
  const prevEnv = process.env.APPLICATIONS_REVIEW_CHANNEL_ID;
  delete process.env.APPLICATIONS_REVIEW_CHANNEL_ID;

  try {
    assert.equal(DEFAULT_APPLICATIONS_REVIEW_CHANNEL_ID, "1571934368619045056");
    assert.equal(await resolveReviewChannelId(db), "1571934368619045056");

    const panelMessages = [];
    let commandReply = null;
    await handleApplicationCommand(db, {
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      channel: {
        id: "public-apply-chan",
        async send(payload) {
          panelMessages.push(payload);
        },
      },
      options: {
        getString: (name) => (name === "action" ? "open" : null),
        getChannel: () => null,
      },
      async reply(payload) {
        commandReply = payload;
      },
    });

    assert.equal(panelMessages.length, 1);
    assert.equal(await resolveReviewChannelId(db), "1571934368619045056");
    assert.match(commandReply.content, /<#public-apply-chan>/);
    assert.match(commandReply.content, /<#1571934368619045056>/);
  } finally {
    if (prevEnv === undefined) delete process.env.APPLICATIONS_REVIEW_CHANNEL_ID;
    else process.env.APPLICATIONS_REVIEW_CHANNEL_ID = prevEnv;
    await db.close();
  }
});
