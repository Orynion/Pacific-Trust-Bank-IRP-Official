import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { ChannelType, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { handleMoneyRequest, schemaStatements } from "./bank-ops.js";
import { handleAddUser, handleTicketClose, ticketSchemaStatements } from "./ticket-ops.js";
import {
  __setDepositTicketDependencies,
  handleDepositTicketImage,
  ticketDepositSchemaStatements,
} from "./ticket-deposit.js";
import { treasurySchemaStatements } from "./treasury-ops.js";

const createdDirs = [];
test.after(async () => {
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const TEST_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZ8AAAAASUVORK5CYII=", "base64");

async function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "ptb-ticket-improvements-"));
  createdDirs.push(dir);
  const db = createClient({ url: `file:${join(dir, "test.db").replace(/\\/g, "/")}` });
  await db.batch([
    ...schemaStatements,
    ...ticketSchemaStatements,
    ...ticketDepositSchemaStatements,
    ...treasurySchemaStatements,
  ], "write");
  return db;
}

async function seedAccount(db, id, { balance = 0 } = {}) {
  await db.execute({
    sql: "INSERT INTO accounts (discord_id, roblox_id, roblox_username, balance) VALUES (?, ?, ?, ?)",
    args: [id, `r-${id}`, "Alice_1", balance],
  });
}

function setTicketEnv(values) {
  const saved = {
    category: process.env.TICKET_CATEGORY_ID,
    staff: process.env.TICKET_STAFF_ROLE_IDS,
    log: process.env.TICKET_LOG_CHANNEL_ID,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    if (saved.category === undefined) delete process.env.TICKET_CATEGORY_ID;
    else process.env.TICKET_CATEGORY_ID = saved.category;
    if (saved.staff === undefined) delete process.env.TICKET_STAFF_ROLE_IDS;
    else process.env.TICKET_STAFF_ROLE_IDS = saved.staff;
    if (saved.log === undefined) delete process.env.TICKET_LOG_CHANNEL_ID;
    else process.env.TICKET_LOG_CHANNEL_ID = saved.log;
  };
}

function makeMoneyInteraction({ userId = "100", amount = 500, guild, inGuild = true } = {}) {
  const state = { replies: [], edits: [], deferred: false, replied: false };
  const interaction = {
    user: { id: userId, username: "Alice", bot: false, tag: "Alice#0001" },
    memberPermissions: { has: () => false },
    options: { getInteger: () => amount },
    inGuild: () => inGuild,
    guild,
    client: { user: { id: "bot-999" }, channels: { fetch: async () => null } },
    async deferReply() { state.deferred = true; },
    async editReply(content) { state.edits.push(content); return content; },
    async reply(payload) {
      if (state.replied) throw new Error("reply called twice");
      state.replied = true;
      state.replies.push(payload);
      return payload;
    },
  };
  interaction.state = state;
  return interaction;
}

function makeTicketGuild() {
  const category = { id: "cat-1", type: ChannelType.GuildCategory };
  const staffRole = { id: "staff-1", managed: false };
  const created = [];
  const guild = {
    id: "guild-1",
    roles: { everyone: { id: "everyone-1" }, cache: new Map([["staff-1", staffRole]]) },
    channels: {
      async fetch(id) {
        if (id === undefined) return { find: () => undefined };
        if (id === "cat-1") return category;
        throw new Error(`Unexpected channel fetch ${id}`);
      },
      async create(setup) {
        const sent = [];
        const channel = {
          id: `chan-${created.length + 1}`,
          name: setup.name,
          topic: setup.topic,
          parentId: setup.parent,
          setup,
          sent,
          deleted: false,
          permissionOverwrites: { edit: async () => ({}) },
          messages: { fetch: async () => new Map() },
          async send(payload) { sent.push(payload); return payload; },
          async delete() { channel.deleted = true; return channel; },
        };
        created.push(channel);
        return channel;
      },
    },
  };
  return { guild, category, staffRole, created };
}

test("ticket creation is private, placed in the configured category, and duplicate-safe", async () => {
  const db = await openDb();
  const restoreEnv = setTicketEnv({
    TICKET_CATEGORY_ID: "cat-1",
    TICKET_STAFF_ROLE_IDS: "staff-1",
    TICKET_LOG_CHANNEL_ID: undefined,
  });
  try {
    await seedAccount(db, "100", { balance: 10 });
    const { guild, created } = makeTicketGuild();
    const interaction = makeMoneyInteraction({ guild });

    await handleMoneyRequest(db, interaction, "deposit");
    assert.equal(created.length, 1);

    const channel = created[0];
    assert.match(channel.name, /^deposit-\d+-alice$/);
    assert.equal(channel.parentId, "cat-1", "ticket must use the configured category");

    const overwrites = channel.setup.permissionOverwrites;
    const everyone = overwrites.find((entry) => entry.id === "everyone-1");
    assert.ok(everyone.deny.includes(PermissionFlagsBits.ViewChannel), "@everyone must not see the ticket");
    const requester = overwrites.find((entry) => entry.id === "100");
    assert.ok(requester.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(requester.allow.includes(PermissionFlagsBits.SendMessages));
    assert.ok(requester.allow.includes(PermissionFlagsBits.AttachFiles));
    const bot = overwrites.find((entry) => entry.id === "bot-999");
    assert.ok(bot.allow.includes(PermissionFlagsBits.ManageChannels));
    const staff = overwrites.find((entry) => entry.id === "staff-1");
    assert.ok(staff.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(staff.allow.includes(PermissionFlagsBits.SendMessages));

    const panel = channel.sent[0];
    assert.match(panel.embeds[0].data.title, /Deposit request/);
    assert.ok(panel.embeds[0].data.fields.some((field) => field.name === "Ticket ID"));
    assert.ok(panel.components.flatMap((row) => row.components).some((button) => /^ticket-close:/.test(button.data.custom_id)));

    const row = await db.execute("SELECT id,channel_id,status FROM tickets WHERE requester_id = '100'");
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].status, "pending");
    assert.equal(row.rows[0].channel_id, channel.id);

    const duplicate = makeMoneyInteraction({ guild });
    await handleMoneyRequest(db, duplicate, "deposit");
    assert.equal(created.length, 1, "a second /deposit must not create another channel");
    assert.match(duplicate.state.edits[0], /already have an open deposit ticket/i);
  } finally {
    restoreEnv();
    await db.close();
  }
});

function makeTicketChannel({ ticket, requesterId, messages = [] }) {
  const edits = [];
  const channel = {
    id: `ticket-${ticket.id}`,
    topic: `ptb-ticket:${ticket.kind}:${requesterId}:${ticket.amount}:${ticket.id}`,
    deleted: false,
    permissionEdits: [],
    permissionOverwrites: {
      async edit(userId, permissions) { channel.permissionEdits.push({ userId, permissions }); return permissions; },
    },
    messages: { fetch: async () => new Map(messages.map((message, index) => [String(index), message])) },
    async delete() { channel.deleted = true; return channel; },
    async send(payload) { edits.push(payload); return payload; },
  };
  return channel;
}

function makeStaffInteraction({ userId = "staff-user", permissions = [], roles = [], channel, memberPermissions = null } = {}) {
  const state = { replies: [], edits: [], deferred: false, replied: false, modal: null };
  const memberPermissionObject = memberPermissions === null
    ? { has: (flag) => permissions.includes(flag) }
    : memberPermissions;
  const interaction = {
    user: { id: userId, username: `user_${userId}`, bot: false, tag: `user_${userId}#0001` },
    memberPermissions: memberPermissionObject,
    member: { roles: { cache: new Map(roles.map((role) => [role, true])) } },
    channelId: channel?.id,
    channel,
    client: { channels: { fetch: async () => null } },
    options: { getUser: () => null },
    inGuild: () => true,
    guild: { id: "guild-1" },
    async deferReply() { state.deferred = true; },
    async editReply(content) { state.edits.push(content); return content; },
    async reply(payload) {
      if (state.replied) throw new Error("reply called twice");
      state.replied = true;
      state.replies.push(payload);
      return payload;
    },
    async showModal(modal) { state.modal = modal; return modal; },
  };
  interaction.state = state;
  return interaction;
}

test("only ticket staff can close; closure records a reason and a transcript", async () => {
  const db = await openDb();
  const restoreEnv = setTicketEnv({
    TICKET_CATEGORY_ID: undefined,
    TICKET_STAFF_ROLE_IDS: "staff-1",
    TICKET_LOG_CHANNEL_ID: "log-1",
  });
  try {
    await seedAccount(db, "200", { balance: 100 });
    const inserted = await db.execute({
      sql: "INSERT INTO tickets (kind, requester_id, amount, status) VALUES ('withdraw', '200', 25, 'pending')",
      args: [],
    });
    const ticketId = Number(inserted.lastInsertRowid);
    const channel = makeTicketChannel({
      ticket: { id: ticketId, kind: "withdraw", amount: 25 },
      requesterId: "200",
      messages: [{
        createdTimestamp: Date.now(),
        createdAt: new Date(),
        author: { id: "200", tag: "Alice#0001" },
        content: "Please pay out 25.",
        attachments: new Map(),
        embeds: [],
      }],
    });
    await db.execute({ sql: "UPDATE tickets SET channel_id = ? WHERE id = ?", args: [channel.id, ticketId] });

    const owner = makeStaffInteraction({ userId: "200", permissions: [], roles: [], channel });
    await handleTicketClose(db, owner, channel.id, ticketId, { reason: "wrong" });
    assert.match(owner.state.replies[0].content, /Only ticket staff/);
    assert.equal(channel.deleted, false);

    const logs = [];
    const staff = makeStaffInteraction({ userId: "staff-user", roles: ["staff-1"], channel });
    staff.client.channels.fetch = async (id) => id === "log-1"
      ? { send: async (payload) => { logs.push(payload); return payload; } }
      : null;
    await handleTicketClose(db, staff, channel.id, ticketId, { reason: "Request handled in game" });

    assert.equal(channel.deleted, true);
    const row = await db.execute({ sql: "SELECT status,note,decision_by FROM tickets WHERE id = ?", args: [ticketId] });
    assert.equal(row.rows[0].status, "rejected");
    assert.match(row.rows[0].note, /Request handled in game/);
    assert.equal(row.rows[0].decision_by, "staff-user");
    assert.equal(logs.length, 1);
    assert.match(logs[0].embeds[0].data.title, /Ticket closed/);
    assert.match(logs[0].embeds[0].data.description, /\*\*New status:\*\* rejected/);
    assert.ok(Array.isArray(logs[0].files) && logs[0].files[0].name.endsWith(".txt"), "closure log must include a transcript file");
  } finally {
    restoreEnv();
    await db.close();
  }
});

test("/add-user is staff-only, refuses bots, and grants only ticket-level access", async () => {
  const db = await openDb();
  const restoreEnv = setTicketEnv({ TICKET_STAFF_ROLE_IDS: "staff-1", TICKET_CATEGORY_ID: undefined, TICKET_LOG_CHANNEL_ID: undefined });
  try {
    await seedAccount(db, "300", { balance: 100 });
    const inserted = await db.execute({
      sql: "INSERT INTO tickets (kind, requester_id, amount, status) VALUES ('deposit', '300', 50, 'pending')",
      args: [],
    });
    const ticketId = Number(inserted.lastInsertRowid);
    const channel = makeTicketChannel({ ticket: { id: ticketId, kind: "deposit", amount: 50 }, requesterId: "300" });
    await db.execute({ sql: "UPDATE tickets SET channel_id = ? WHERE id = ?", args: [channel.id, ticketId] });

    const nonStaff = makeStaffInteraction({ userId: "400", permissions: [], roles: [], channel });
    nonStaff.options.getUser = () => ({ id: "500", bot: false });
    await handleAddUser(db, nonStaff, "staff-1");
    assert.match(nonStaff.state.replies[0].content, /Only ticket staff/);
    assert.equal(channel.permissionEdits.length, 0);

    const staff = makeStaffInteraction({ userId: "staff-user", roles: ["staff-1"], channel });
    staff.options.getUser = () => ({ id: "500", username: "Helper", bot: false });
    await handleAddUser(db, staff, "staff-1");
    assert.equal(channel.permissionEdits.length, 1);
    assert.equal(channel.permissionEdits[0].userId, "500");
    assert.equal(channel.permissionEdits[0].permissions.ViewChannel, true);
    assert.match(staff.state.edits[0], /can now view and reply/);

    const botTarget = makeStaffInteraction({ userId: "staff-user", roles: ["staff-1"], channel });
    botTarget.options.getUser = () => ({ id: "600", username: "Bot", bot: true });
    await handleAddUser(db, botTarget, "staff-1");
    assert.match(botTarget.state.replies[0].content, /Bots cannot be added/);
    assert.equal(channel.permissionEdits.length, 1);
  } finally {
    restoreEnv();
    await db.close();
  }
});

function makeDepositMessage({ ticket, requesterId, attachmentId = "att-1", name = "proof.png" }) {
  const sent = [];
  const message = {
    id: `message-${ticket.id}`,
    guild: { id: "guild-1" },
    client: { channels: { fetch: async () => null } },
    author: { id: requesterId, bot: false },
    channelId: `ticket-${ticket.id}`,
    channel: {
      topic: `ptb-ticket:${ticket.kind}:${requesterId}:${ticket.amount}:${ticket.id}`,
      async send(payload) { sent.push(payload); return payload; },
    },
    attachments: new Map([[attachmentId, {
      id: attachmentId,
      contentType: "image/png",
      size: TEST_PNG.length,
      url: "https://cdn.example/receipt.png",
      name,
    }]]),
  };
  return { message, sent };
}

async function insertDepositTicket(db, requesterId, amount = 500) {
  await seedAccount(db, requesterId, { balance: 10 });
  const inserted = await db.execute({
    sql: "INSERT INTO tickets (kind, requester_id, amount, status) VALUES ('deposit', ?, ?, 'pending')",
    args: [requesterId, amount],
  });
  const ticketId = Number(inserted.lastInsertRowid);
  const channelId = `ticket-${ticketId}`;
  await db.execute({ sql: "UPDATE tickets SET channel_id = ? WHERE id = ?", args: [channelId, ticketId] });
  return { id: ticketId, kind: "deposit", amount, requester_id: requesterId, channel_id: channelId, status: "pending" };
}

test("deposit image upload invokes the OCR module and shared embed builder only once per attachment", async () => {
  const db = await openDb();
  const originalFetch = globalThis.fetch;
  const analyzerCalls = [];
  const embedCalls = [];
  globalThis.fetch = async () => new Response(TEST_PNG, { status: 200, headers: { "content-length": String(TEST_PNG.length) } });
  __setDepositTicketDependencies({
    analyzeReceipt: async (buffer) => {
      analyzerCalls.push(buffer);
      return {
        status: "ok",
        fields: {
          amount: 500,
          currency: "USD",
          recipient: "IRP Treasury",
          sender: "Alice_1",
          transactionId: "TX-123",
          date: "2026-10-24",
          time: "12:30",
          paymentStatus: "completed",
          paymentMethod: "Gamepay",
        },
        ocr: {
          text: "Payment successful\nAmount paid: 500 USD\nRecipient: IRP Treasury",
          confidence: 92.5,
          confidenceUnit: "percent",
        },
        error: null,
      };
    },
    buildEmbed: (raw, context) => {
      embedCalls.push({ raw, context });
      return new EmbedBuilder().setTitle("Shared receipt embed").addFields({ name: "Amount", value: String(raw.fields.amount) });
    },
  });
  try {
    const ticket = await insertDepositTicket(db, "700", 500);
    const { message, sent } = makeDepositMessage({ ticket, requesterId: "700" });

    assert.equal(await handleDepositTicketImage(db, message), true);
    assert.equal(analyzerCalls.length, 1, "OCR runs exactly once");
    assert.ok(Buffer.isBuffer(analyzerCalls[0]), "OCR receives the image buffer");
    assert.equal(embedCalls.length, 1, "the shared embed utility receives the extracted result");
    assert.equal(embedCalls[0].raw.fields.amount, 500);
    assert.equal(embedCalls[0].context.ticket.id, ticket.id);
    assert.equal(sent.length, 1);
    assert.match(sent[0].embeds[0].data.title, /Shared receipt embed/);

    const processing = await db.execute({
      sql: "SELECT status FROM ticket_receipt_processing WHERE ticket_id = ? AND attachment_id = ?",
      args: [ticket.id, "att-1"],
    });
    assert.equal(processing.rows[0].status, "completed");
    const checks = await db.execute({
      sql: "SELECT extracted_amount,duplicate_reference FROM treasury_ticket_receipt_checks WHERE ticket_id = ?",
      args: [ticket.id],
    });
    assert.equal(Number(checks.rows[0].extracted_amount), 500);

    assert.equal(await handleDepositTicketImage(db, message), false);
    assert.equal(analyzerCalls.length, 1, "the same attachment must not be processed twice");
    assert.equal(sent.length, 1, "no duplicate analysis embed is posted");
  } finally {
    __setDepositTicketDependencies({ analyzeReceipt: null, buildEmbed: null });
    globalThis.fetch = originalFetch;
    await db.close();
  }
});

test("the real deposit-detection result shape renders through the shared deposit embed utility", async () => {
  const db = await openDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(TEST_PNG, { status: 200, headers: { "content-length": String(TEST_PNG.length) } });
  __setDepositTicketDependencies({
    analyzeReceipt: async () => ({
      status: "partial",
      fields: {
        amount: 500,
        currency: "USD",
        recipient: "IRP Treasury",
        sender: "Alice_1",
        transactionId: "TX-987654",
        date: "2026-10-24",
        time: "12:30",
        paymentStatus: "completed",
        paymentMethod: "Gamepay",
      },
      ocr: {
        text: "Payment successful\nAmount paid: 500 USD\nRecipient: IRP Treasury",
        confidence: 91.5,
        confidenceUnit: "percent",
      },
      error: null,
    }),
    buildEmbed: null,
  });
  try {
    const ticket = await insertDepositTicket(db, "710", 500);
    const { message, sent } = makeDepositMessage({ ticket, requesterId: "710" });

    assert.equal(await handleDepositTicketImage(db, message), true);
    assert.equal(sent.length, 1);
    const embed = sent[0].embeds[0].data;
    assert.match(embed.title, /^Deposit receipt analysis · PTB-D-\d+$/);
    assert.match(embed.description, /advisory/i);
    const fields = new Map(embed.fields.map((field) => [field.name, field.value]));
    assert.equal(fields.get("Amount & Currency"), "500 USD (matches ticket amount)");
    assert.equal(fields.get("Recipient"), "IRP Treasury");
    assert.equal(fields.get("Sender / Payer"), "Alice_1");
    assert.match(fields.get("Transaction ID"), /TX-987654/);
    assert.match(fields.get("Receipt Status"), /completed/);
    assert.equal(fields.get("OCR Confidence"), "91.5%");
    assert.match(fields.get("Verified Payment Status"), /Pending staff approval/);

    const check = await db.execute({
      sql: "SELECT ocr_text,extracted_payer,extracted_recipient,extracted_amount FROM treasury_ticket_receipt_checks WHERE ticket_id = ?",
      args: [ticket.id],
    });
    assert.match(check.rows[0].ocr_text, /Payment successful/, "OCR text must be read from the reader's ocr.text field");
    assert.equal(check.rows[0].extracted_payer, "Alice_1");
    assert.equal(check.rows[0].extracted_recipient, "IRP Treasury");
    assert.equal(Number(check.rows[0].extracted_amount), 500);

    const ticketRow = await db.execute({ sql: "SELECT status FROM tickets WHERE id = ?", args: [ticket.id] });
    assert.equal(ticketRow.rows[0].status, "pending", "receipt analysis must not approve or alter the ticket");
    const account = await db.execute({ sql: "SELECT balance FROM accounts WHERE discord_id = '710'" });
    assert.equal(Number(account.rows[0].balance), 10, "receipt analysis must not change balances");
  } finally {
    __setDepositTicketDependencies({ analyzeReceipt: null, buildEmbed: null });
    globalThis.fetch = originalFetch;
    await db.close();
  }
});

test("a receipt-reader status:error result is recorded as a failed analysis", async () => {
  const db = await openDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(TEST_PNG, { status: 200, headers: { "content-length": String(TEST_PNG.length) } });
  __setDepositTicketDependencies({
    analyzeReceipt: async () => ({
      status: "error",
      fields: {
        amount: null,
        currency: null,
        recipient: null,
        sender: null,
        transactionId: null,
        date: null,
        time: null,
        paymentStatus: null,
        paymentMethod: null,
      },
      ocr: { text: "", confidence: null, confidenceUnit: null },
      error: { code: "OCR_TIMEOUT", message: "OCR exceeded the processing time limit." },
    }),
    buildEmbed: null,
  });
  try {
    const ticket = await insertDepositTicket(db, "720", 500);
    const { message, sent } = makeDepositMessage({ ticket, requesterId: "720" });

    assert.equal(await handleDepositTicketImage(db, message), true);
    assert.equal(sent.length, 1);
    const embed = sent[0].embeds[0].data;
    assert.match(embed.title, /Receipt check unavailable/);
    assert.match(embed.description, /OCR exceeded the processing time limit/);
    assert.match(embed.description, /OCR_TIMEOUT/);

    const processing = await db.execute({
      sql: "SELECT status,error FROM ticket_receipt_processing WHERE ticket_id = ?",
      args: [ticket.id],
    });
    assert.equal(processing.rows[0].status, "failed");
    assert.match(processing.rows[0].error, /OCR_TIMEOUT/);
    const checks = await db.execute({
      sql: "SELECT COUNT(*) AS count FROM treasury_ticket_receipt_checks WHERE ticket_id = ?",
      args: [ticket.id],
    });
    assert.equal(Number(checks.rows[0].count), 0, "failed OCR results must not be saved as receipt checks");
  } finally {
    __setDepositTicketDependencies({ analyzeReceipt: null, buildEmbed: null });
    globalThis.fetch = originalFetch;
    await db.close();
  }
});

test("OCR failures are reported in the ticket and withdraw tickets never run OCR", async () => {
  const db = await openDb();
  const originalFetch = globalThis.fetch;
  let analyzerCalls = 0;
  globalThis.fetch = async () => new Response(TEST_PNG, { status: 200, headers: { "content-length": String(TEST_PNG.length) } });
  __setDepositTicketDependencies({
    analyzeReceipt: async () => {
      analyzerCalls += 1;
      throw new Error("Simulated OCR engine failure");
    },
    buildEmbed: null,
  });
  try {
    const deposit = await insertDepositTicket(db, "800", 500);
    const { message, sent } = makeDepositMessage({ ticket: deposit, requesterId: "800" });
    assert.equal(await handleDepositTicketImage(db, message), true);
    assert.equal(analyzerCalls, 1);
    assert.match(sent[0].embeds[0].data.title, /Receipt check unavailable/);
    const processing = await db.execute({
      sql: "SELECT status,error FROM ticket_receipt_processing WHERE ticket_id = ?",
      args: [deposit.id],
    });
    assert.equal(processing.rows[0].status, "failed");
    assert.match(processing.rows[0].error, /Simulated OCR engine failure/);

    await seedAccount(db, "801", { balance: 10 });
    const withdraw = await db.execute({
      sql: "INSERT INTO tickets (kind, requester_id, amount, status) VALUES ('withdraw', '801', 20, 'pending')",
      args: [],
    });
    const withdrawId = Number(withdraw.lastInsertRowid);
    await db.execute({ sql: "UPDATE tickets SET channel_id = ? WHERE id = ?", args: [`ticket-${withdrawId}`, withdrawId] });
    const withdrawMessage = makeDepositMessage({
      ticket: { id: withdrawId, kind: "withdraw", amount: 20 },
      requesterId: "801",
    });
    assert.equal(await handleDepositTicketImage(db, withdrawMessage.message), false);
    assert.equal(analyzerCalls, 1, "withdraw tickets must not invoke OCR");
  } finally {
    __setDepositTicketDependencies({ analyzeReceipt: null, buildEmbed: null });
    globalThis.fetch = originalFetch;
    await db.close();
  }
});
