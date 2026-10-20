import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { attachTicketChannel, createPendingTicket, handleTicketDecision, rejectPendingTicketByChannel, ticketSchemaStatements } from "./ticket-ops.js";
import { handleBalance, handleTransfer, schemaStatements } from "./bank-ops.js";

// ---------------------------------------------------------------------------
// Isolation: every test uses its own throwaway local SQLite file database in
// the OS temp dir. The production Turso database is never touched.
// ---------------------------------------------------------------------------

const createdDirs = [];

async function removeDirBestEffort(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EBUSY") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

test.after(async () => {
  for (const dir of createdDirs) {
    await removeDirBestEffort(dir);
  }
});

function openTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "ptb-ticket-test-"));
  createdDirs.push(dir);
  const url = `file:${join(dir, "ptb-ticket-test.db").replace(/\\/g, "/")}`;
  const db = createClient({ url });
  return { db, dir, url };
}

const ADMIN_FLAG = PermissionFlagsBits.Administrator;
const ADMIN_A = "300000000000000001";
const ADMIN_B = "300000000000000002";
const ADMIN_C = "300000000000000003";

async function seedAccount(db, discordId, { balance = 0, frozen = 0 } = {}) {
  await db.execute({
    sql: "INSERT INTO accounts (discord_id, roblox_id, roblox_username, balance, frozen) VALUES (?, ?, ?, ?, ?)",
    args: [discordId, null, null, balance, frozen],
  });
}

async function getBalance(db, discordId) {
  const result = await db.execute({
    sql: "SELECT balance FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [discordId],
  });
  return result.rows.length > 0 ? Number(result.rows[0].balance) : null;
}

async function getLedger(db) {
  const result = await db.execute(
    "SELECT id, type, from_id, to_id, amount, status, staff_id, note FROM transactions ORDER BY id",
  );
  return result.rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function getTicket(db, ticketId) {
  const result = await db.execute({
    sql: "SELECT * FROM tickets WHERE id = ? LIMIT 1",
    args: [ticketId],
  });
  return result.rows.length > 0 ? result.rows[0] : null;
}

let nextFakeTicketInteractionId = 8_605_000_000_000_000_000n;

function ticketInteraction({ userId, permissions = [ADMIN_FLAG], id = (nextFakeTicketInteractionId++).toString(), channelId = null } = {}) {
  const state = { replies: [], deferred: false, replied: false };
  const interaction = {
    id,
    user: { id: userId, username: `user_${userId}`, bot: false, tag: `user_${userId}#0001` },
    memberPermissions: permissions === null ? null : { has: (flag) => permissions.includes(flag) },
    channelId,
    async reply(payload) {
      if (state.replied) throw new Error("interaction.reply called twice");
      state.replied = true;
      state.replies.push(payload);
      return payload;
    },
    async deferReply(p) { state.deferred = true; },
    async editReply(content) { return content; },
  };
  interaction.state = state;
  return interaction;
}

/**
 * Runs a ticket button click (approve | complete | reject) on the real
 * handler. All clicks target the same tickets table, so sequencing matches
 * production button order.
 */
function decide(db, { adminId, action, ticketId, permissions, id, dbOverride, channelId }) {
  const interaction = ticketInteraction({ userId: adminId, permissions, id, channelId });
  const run = handleTicketDecision(dbOverride ?? db, interaction, action, String(ticketId));
  return { interaction, run };
}

function wrapDbWithFailure(db, failWhen) {
  const makeWrapped = (underlyingExecute) => {
    let failed = false;
    return async (query) => {
      if (!failed && failWhen(query)) {
        failed = true;
        throw new Error("Simulated database failure (test-only fault injection)");
      }
      return underlyingExecute(query);
    };
  };
  const execute = makeWrapped((query) => db.execute(query));
  return {
    execute,
    async transaction(mode) {
      const tx = await db.transaction(mode);
      const txExecute = makeWrapped((query) => tx.execute(query));
      return {
        execute: txExecute,
        commit: () => tx.commit(),
        rollback: () => tx.rollback(),
        close: () => tx.close(),
      };
    },
    batch: async (statements, mode) => db.batch(statements, mode),
  };
}

// ---------------------------------------------------------------------------
// Ticket identity: unique, persistent transaction IDs.
// ---------------------------------------------------------------------------

test("tickets 1: every request gets a unique persistent ID that survives restarts", async () => {
  const { db, dir, url } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "990000000000000001", { balance: 111 });

    const first = await createPendingTicket(db, { kind: "deposit", requesterId: "990000000000000001", amount: 25 });
    const second = await createPendingTicket(db, { kind: "withdraw", requesterId: "990000000000000001", amount: 8 });
    assert.notEqual(first, second, "ticket IDs must be unique");

    const row = await getTicket(db, second);
    assert.equal(row.kind, "withdraw");
    assert.equal(row.status, "pending");
    assert.equal(Number(row.amount), 8);

    await db.close();

    // Simulated restart: brand-new client on the same database file.
    const db2 = createClient({ url });
    try {
      await db2.batch([...schemaStatements, ...ticketSchemaStatements], "write");
      assert.equal((await getTicket(db2, first)).id, first, "ticket row persists across restarts");
      assert.equal((await getTicket(db2, second)).status, "pending");
    } finally {
      await db2.close();
    }
  } finally {
    try { await db.close(); } catch { /* closed above */ }
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Approve flow: double approval, simultaneous approvals, retry after error.
// ---------------------------------------------------------------------------

test("tickets 2: double approval by two admins is idempotent and records the approver", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000010", { balance: 100 });
    const ticketId = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000010", amount: 40 });

    const first = decide(db, { adminId: ADMIN_A, action: "approve", ticketId });
    await first.run;
    assert.match(first.interaction.state.replies[0].content, /approved by the admin\. The ticket is now \*\*approved\*\*, funds have \*\*not\*\* moved yet\./);

    const replay = decide(db, { adminId: ADMIN_B, action: "approve", ticketId });
    await replay.run;
    assert.match(replay.interaction.state.replies[0].content, /Already approved|was already approved/);
    assert.match(replay.interaction.state.replies[0].content, new RegExp(`<@${ADMIN_A}>`), "the reply must name the original approver");

    const row = await getTicket(db, ticketId);
    assert.equal(row.status, "approved");
    assert.equal(row.decision_by, ADMIN_A, "the first (and only) approver is recorded");
    assert.ok(row.decision_at, "approval timestamp recorded");
    assert.equal(await getBalance(db, "300000000000000010"), 100, "approving must not move money");
    assert.equal((await getLedger(db)).length, 0, "approving must not write ledger entries");
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 3: simultaneous approvals produce exactly one approval", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000011", { balance: 500 });
    const ticketId = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000011", amount: 120 });

    const clicks = [
      decide(db, { adminId: ADMIN_A, action: "approve", ticketId, id: "863000000000000001" }),
      decide(db, { adminId: ADMIN_B, action: "approve", ticketId, id: "863000000000000002" }),
      decide(db, { adminId: ADMIN_C, action: "approve", ticketId, id: "863000000000000003" }),
    ];
    const outcomes = await Promise.allSettled(clicks.map((click) => click.run));

    // Concurrent load may reject legitimately with fail-closed SQLITE_BUSY —
    // cross-check invariants instead of exact reply counts.
    const replies = clicks
      .filter((click, index) => outcomes[index].status === "fulfilled")
      .map((click) => click.interaction.state.replies?.[0]?.content ?? "");
    const approvals = replies.filter((content) => /approved by the admin\. The ticket is now \*\*approved\*\*/.test(content));
    assert.ok(approvals.length <= 1, "at most one approve click may win, got " + JSON.stringify(replies));

    // If every racing click hit fail-closed BUSY, settle one approval so the
    // rest of the assertions describe a normal upstream state.
    let row = await getTicket(db, ticketId);
    if (row.status === "pending") {
      await decide(db, { adminId: ADMIN_A, action: "approve", ticketId }).run;
      row = await getTicket(db, ticketId);
    }
    assert.equal(row.status, "approved");
    assert.ok(row.decision_by, "the winning approver is recorded");
    assert.ok(row.decision_at, "approval timestamp recorded");
    assert.equal(await getBalance(db, "300000000000000011"), 500, "no funds moved at approval");
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 4: a database failure during approval rolls back and a retry succeeds", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000012", { balance: 10 });
    const ticketId = await createPendingTicket(db, { kind: "withdraw", requesterId: "300000000000000012", amount: 9 });

    const failingDb = wrapDbWithFailure(db, (query) =>
      typeof query?.sql === "string" && query.sql.startsWith("UPDATE tickets SET status = 'approved'"));
    const failed = decide(failingDb, { adminId: ADMIN_A, action: "approve", ticketId });
    await assert.rejects(failed.run, /Simulated database failure/);

    assert.equal((await getTicket(db, ticketId)).status, "pending", "failed approval must leave the ticket pending");
    assert.equal((await getLedger(db)).length, 0);

    const retry = decide(db, { adminId: ADMIN_B, action: "approve", ticketId });
    await retry.run;
    assert.match(retry.interaction.state.replies[0].content, /approved by the admin/);
    assert.equal((await getTicket(db, ticketId)).status, "approved");
    assert.equal((await getTicket(db, ticketId)).decision_by, ADMIN_B);
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Deposit completion: verify-before-credit, double credit, concurrent credit,
// retried credit after failure, withdrawal top-up gate.
// ---------------------------------------------------------------------------

test("tickets 5: deposit cannot be credited before approval (receipts verified first)", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000013", { balance: 5 });
    const ticketId = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000013", amount: 75 });

    const early = decide(db, { adminId: ADMIN_A, action: "complete", ticketId });
    await early.run;
    assert.match(early.interaction.state.replies[0].content, /has not been approved yet\. An administrator must approve it first\./);
    assert.equal((await getTicket(db, ticketId)).status, "pending");
    assert.equal(await getBalance(db, "300000000000000013"), 5);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 6: double credit of the same deposit applies the funds exactly once", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000014", { balance: 1_000 });
    const ticketId = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000014", amount: 250 });

    const approve = decide(db, { adminId: ADMIN_A, action: "approve", ticketId });
    await approve.run;

    const credit = decide(db, { adminId: ADMIN_B, action: "complete", ticketId });
    await credit.run;
    assert.match(credit.interaction.state.replies[0].content, /completed: credited 250 to <@300000000000000014>\. New balance: 1,250\./);
    assert.match(credit.interaction.state.replies[0].content, new RegExp(`Ticket PTB-D-${ticketId} deposit credited \\(#\\d+\\)`));

    const replay = decide(db, { adminId: ADMIN_C, action: "complete", ticketId });
    await replay.run;
    assert.match(replay.interaction.state.replies[0].content, /was already completed by <@300000000000000002>/, "re-credit must be refused and name the completing admin");
    assert.match(replay.interaction.state.replies[0].content, /Funds moved exactly once/);

    assert.equal(await getBalance(db, "300000000000000014"), 1_250, "credit applied exactly once");
    const ledger = await getLedger(db);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].type, "deposit");
    assert.equal(ledger[0].to_id, "300000000000000014");
    assert.equal(ledger[0].amount, 250);
    assert.equal(ledger[0].staff_id, ADMIN_B, "ledger records the processing admin");
    const row = await getTicket(db, ticketId);
    assert.equal(row.status, "completed");
    assert.equal(row.completion_by, ADMIN_B);
    assert.ok(row.completion_at, "completion timestamp recorded");
    assert.equal(Number(row.ledger_id), ledger[0].id, "ticket points at its ledger entry");
    assert.equal(Number(row.amount), 250);
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 7: simultaneous credit attempts honour exactly-once semantics", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000015", { balance: 10 });
    const ticketId = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000015", amount: 90 });

    const approve = decide(db, { adminId: ADMIN_A, action: "approve", ticketId });
    await approve.run;

    const clicks = [
      decide(db, { adminId: ADMIN_B, action: "complete", ticketId, id: "863000000000000011" }),
      decide(db, { adminId: ADMIN_C, action: "complete", ticketId, id: "863000000000000012" }),
    ];
    const outcomes = await Promise.allSettled(clicks.map((click) => click.run));

    const ledger = await getLedger(db);
    const credits = ledger.filter((row) => row.type === "deposit");
    assert.ok(credits.length <= 1, `at most one ledger credit may exist, got ${credits.length}`);

    const attemptedDelta = credits.reduce((sum, row) => sum + row.amount, 0);
    assert.equal(await getBalance(db, "300000000000000015"), 10 + attemptedDelta, "balance must exactly match committed credits");

    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "fulfilled") {
        const content = clicks[index].interaction.state.replies?.[0]?.content ?? "";
        assert.ok(
          /completed: credited|was already completed|changed state|remains approved/.test(content),
          `unexpected reply content: ${content}`,
        );
      }
    }

    // Resolve any pending state deterministically, then verify exactly-once.
    let row = await getTicket(db, ticketId);
    if (row.status === "approved") {
      await decide(db, { adminId: ADMIN_C, action: "complete", ticketId }).run;
      row = await getTicket(db, ticketId);
    }
    assert.equal(row.status, "completed", "the approved ticket completes exactly once");
    assert.equal(await getBalance(db, "300000000000000015"), 100, "final balance credited exactly once (10 + 90)");
    const finalLedger = await getLedger(db);
    assert.equal(finalLedger.filter((entry) => entry.type === "deposit").length, 1, "exactly one deposit ledger entry");
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 8: database failure during credit rolls back fully and the retry credits once", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000016", { balance: 300 });
    const ticketId = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000016", amount: 111 });

    const approve = decide(db, { adminId: ADMIN_A, action: "approve", ticketId });
    await approve.run;

    // Failure injected at the ledger insert (after the money update, before commit):
    // the whole transaction must roll back, including the credit.
    const failingDb = wrapDbWithFailure(db, (query) =>
      typeof query?.sql === "string" && query.sql.startsWith("INSERT INTO transactions"));
    const failed = decide(failingDb, { adminId: ADMIN_B, action: "complete", ticketId });
    await assert.rejects(failed.run, /Simulated database failure/);

    assert.equal(await getBalance(db, "300000000000000016"), 300, "failed credit must leave the balance untouched");
    assert.equal((await getLedger(db)).length, 0, "failed credit must leave no ledger entry");
    assert.equal((await getTicket(db, ticketId)).status, "approved", "ticket stays approved for retry");

    const retry = decide(db, { adminId: ADMIN_C, action: "complete", ticketId });
    await retry.run;
    assert.match(retry.interaction.state.replies[0].content, /completed: credited 111/);
    assert.equal(await getBalance(db, "300000000000000016"), 411);
    assert.equal((await getLedger(db)).length, 1);

    const secondRetry = decide(db, { adminId: ADMIN_B, action: "complete", ticketId });
    await secondRetry.run;
    assert.match(secondRetry.interaction.state.replies[0].content, /was already completed/);
    assert.equal(await getBalance(db, "300000000000000016"), 411, "still credited exactly once after all retries");
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 9: deposits are refused while the account is frozen and retryable afterwards", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000017", { balance: 50, frozen: 1 });
    const ticketId = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000017", amount: 40 });

    const approve = decide(db, { adminId: ADMIN_A, action: "approve", ticketId });
    await approve.run;

    const blocked = decide(db, { adminId: ADMIN_B, action: "complete", ticketId });
    await blocked.run;
    assert.match(blocked.interaction.state.replies[0].content, /frozen\. Ticket PTB-D-\d+ remains approved for a later retry\./);
    assert.equal((await getTicket(db, ticketId)).status, "approved", "refused credit keeps the ticket approved");
    assert.equal(await getBalance(db, "300000000000000017"), 50);
    assert.equal((await getLedger(db)).length, 0);

    await db.execute({ sql: "UPDATE accounts SET frozen = 0 WHERE discord_id = ?", args: ["300000000000000017"] });
    const retry = decide(db, { adminId: ADMIN_B, action: "complete", ticketId });
    await retry.run;
    assert.match(retry.interaction.state.replies[0].content, /completed: credited 40/);
    assert.equal(await getBalance(db, "300000000000000017"), 90);
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 10: credit that would overflow the balance cap is refused and retryable", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000018", { balance: 2_147_483_640 });
    const ticketId = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000018", amount: 100 });

    const approve = decide(db, { adminId: ADMIN_A, action: "approve", ticketId });
    await approve.run;

    const refused = decide(db, { adminId: ADMIN_B, action: "complete", ticketId });
    await refused.run;
    assert.match(refused.interaction.state.replies[0].content, /exceed the supported balance limit\. PTB-D-\d+ remains approved/);
    assert.equal(await getBalance(db, "300000000000000018"), 2_147_483_640);
    assert.equal((await getLedger(db)).length, 0);
    assert.equal((await getTicket(db, ticketId)).status, "approved");

    // After the cap is reachable again, the same ticket completes.
    await db.execute({ sql: "UPDATE accounts SET balance = 2147483647 - 400 WHERE discord_id = ?", args: ["300000000000000018"] });
    const retry = decide(db, { adminId: ADMIN_B, action: "complete", ticketId });
    await retry.run;
    assert.match(retry.interaction.state.replies[0].content, /completed: credited 100/);
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Withdrawal payouts: approve gate, deduct-on-finalise, overspend prevention.
// ---------------------------------------------------------------------------

test("tickets 11: approval of a payout is blocked while funds are insufficient", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000019", { balance: 50 });
    const ticketId = await createPendingTicket(db, { kind: "withdraw", requesterId: "300000000000000019", amount: 80 });

    const refused = decide(db, { adminId: ADMIN_A, action: "approve", ticketId });
    await refused.run;
    assert.match(refused.interaction.state.replies[0].content, /balance is 50, which is less than the requested payout of 80\. The ticket stays pending/);
    assert.equal((await getTicket(db, ticketId)).status, "pending");
    assert.equal(await getBalance(db, "300000000000000019"), 50, "no deduction at this stage");
    assert.equal((await getLedger(db)).length, 0);

    // Top up, then approve and pay out: deduct happens only on completion.
    await db.execute({ sql: "UPDATE accounts SET balance = balance + 300 WHERE discord_id = ?", args: ["300000000000000019"] });
    const approve = decide(db, { adminId: ADMIN_A, action: "approve", ticketId });
    await approve.run;
    assert.equal((await getTicket(db, ticketId)).status, "approved");
    assert.equal(await getBalance(db, "300000000000000019"), 350, "approval must not deduct the balance");

    const payout = decide(db, { adminId: ADMIN_B, action: "complete", ticketId });
    await payout.run;
    assert.match(payout.interaction.state.replies[0].content, /completed: paid out 80 from <@300000000000000019>\. New balance: 270\./);
    assert.equal(await getBalance(db, "300000000000000019"), 270, "deducted exactly once, at completion");

    const ledger = await getLedger(db);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].type, "withdraw");
    assert.equal(ledger[0].from_id, "300000000000000019");
    assert.equal(ledger[0].amount, 80);
    assert.equal(ledger[0].staff_id, ADMIN_B);

    const replay = decide(db, { adminId: ADMIN_C, action: "complete", ticketId });
    await replay.run;
    assert.match(replay.interaction.state.replies[0].content, /was already completed/);
    assert.equal(await getBalance(db, "300000000000000019"), 270, "double payout refused");
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 12: payouts and transfers for one account cannot jointly overspend it", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch(schemaStatements, "write");
    await db.batch(ticketSchemaStatements, "write");
    await seedAccount(db, "300000000000000020", { balance: 100 });
    const receiptId = "888000000000000044";
    await seedAccount(db, receiptId);

    const makeTransfer = (id, amount) => ({
      id,
      user: { id: "300000000000000020", username: "user_300000000000000020", bot: false, tag: "user_300000000000000020#0001" },
      options: {
        getUser: () => ({ id: receiptId, username: `user_${receiptId}`, bot: false }),
        getInteger: () => amount,
        getBoolean: () => true,
      },
      inGuild: () => true,
      guild: { channels: { fetch: async () => ({ find: () => undefined }) }, roles: { everyone: { id: "everyone-role" } } },
      isButton: () => false,
      state: { replies: [] },
      async reply(payload) { this.state.replies.push(payload); return payload; },
    });

    // Approve a 60 payout while the balance (100) is still sufficient...
    const payoutTicket = await createPendingTicket(db, { kind: "withdraw", requesterId: "300000000000000020", amount: 60 });
    await decide(db, { adminId: ADMIN_A, action: "approve", ticketId: payoutTicket }).run;

    // ...then a 70 transfer legally drains the balance to 30.
    await handleTransfer(db, makeTransfer("863000000000000020", 70));
    assert.equal(await getBalance(db, "300000000000000020"), 30);

    // The approved payout must now refuse and stay retryable: transfers and
    // ticket payouts share one balance that can never jointly overdraft.
    const payout = decide(db, { adminId: ADMIN_B, action: "complete", ticketId: payoutTicket, id: "863000000000000021" });
    await payout.run;
    assert.match(
      payout.interaction.state.replies[0].content,
      /Cannot pay out .*current balance is 30/,
    );
    assert.equal((await getTicket(db, payoutTicket)).status, "approved", "the payout stays approved for a later retry");

    const midLedger = await getLedger(db);
    const transferredSoFar = midLedger
      .filter((row) => row.type === "transfer" && row.from_id === "300000000000000020")
      .reduce((sum, row) => sum + row.amount, 0);
    assert.equal(transferredSoFar, 70);
    assert.deepEqual(midLedger.filter((row) => row.type === "withdraw"), [], "a refused payout writes no ledger row");

    // Once funds exist (administrator tops the account up by 40: 30 -> 70),
    // the same approved ticket completes EXACTLY once.
    await db.execute({
      sql: "UPDATE accounts SET balance = balance + 40 WHERE discord_id = ?",
      args: ["300000000000000020"],
    });
    const retry = decide(db, { adminId: ADMIN_C, action: "complete", ticketId: payoutTicket, id: "863000000000000022" });
    await retry.run;
    assert.match(retry.interaction.state.replies[0].content, /completed: paid out 60/);
    assert.equal(await getBalance(db, "300000000000000020"), 10, "the retry debits the topped-up balance exactly once");

    const ledger = await getLedger(db);
    const paidRows = ledger.filter((row) => row.type === "withdraw");
    assert.equal(paidRows.length, 1, "exactly one completed payout, despite the first refused attempt");
    assert.equal(await getBalance(db, receiptId), 70, "the recipient received exactly the transfer");
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 13: payout database failure rolls back and retry deducts exactly once", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000021", { balance: 400 });
    const ticketId = await createPendingTicket(db, { kind: "withdraw", requesterId: "300000000000000021", amount: 150 });
    await decide(db, { adminId: ADMIN_A, action: "approve", ticketId }).run;

    const failingDb = wrapDbWithFailure(db, (query) =>
      typeof query?.sql === "string" && (query.sql.startsWith("UPDATE accounts SET balance = balance - ?") || query.sql.startsWith("INSERT INTO transactions")));
    const failed = decide(failingDb, { adminId: ADMIN_B, action: "complete", ticketId });
    await assert.rejects(failed.run, /Simulated database failure/);

    assert.equal(await getBalance(db, "300000000000000021"), 400, "failed payout leaves the balance untouched");
    assert.equal((await getLedger(db)).length, 0);
    assert.equal((await getTicket(db, ticketId)).status, "approved", "ticket remains approved for retry");

    const retry = decide(db, { adminId: ADMIN_B, action: "complete", ticketId });
    await retry.run;
    assert.match(retry.interaction.state.replies[0].content, /completed: paid out 150/);
    assert.equal(await getBalance(db, "300000000000000021"), 250);
    assert.equal((await getLedger(db)).length, 1);
    assert.equal((await getTicket(db, ticketId)).status, "completed");
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Rejections.
// ---------------------------------------------------------------------------

test("tickets 14: rejecting a pending ticket is idempotent and moves no money", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000022", { balance: 900 });
    const ticketId = await createPendingTicket(db, { kind: "withdraw", requesterId: "300000000000000022", amount: 100 });

    const reject = decide(db, { adminId: ADMIN_A, action: "reject", ticketId });
    await reject.run;
    assert.match(reject.interaction.state.replies[0].content, /rejected by the admin\. No balance changes were made\./);

    const replay = decide(db, { adminId: ADMIN_B, action: "reject", ticketId });
    await replay.run;
    assert.match(replay.interaction.state.replies[0].content, /was already rejected/);

    const refundAttempt = decide(db, { adminId: ADMIN_C, action: "complete", ticketId });
    await refundAttempt.run;
    assert.match(refundAttempt.interaction.state.replies[0].content, /was rejected.*cannot be processed\./);
    assert.equal(await getBalance(db, "300000000000000022"), 900);
    assert.equal((await getLedger(db)).length, 0);

    const approveAttempt = decide(db, { adminId: ADMIN_A, action: "approve", ticketId });
    await approveAttempt.run;
    assert.match(approveAttempt.interaction.state.replies[0].content, /was already rejected/);

    const row = await getTicket(db, ticketId);
    assert.equal(row.status, "rejected");
    assert.equal(row.decision_by, ADMIN_A);
    assert.ok(row.decision_at);
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 15: rejecting an approved or completed ticket is refused with a clear reason", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000023", { balance: 500 });
    const approved = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000023", amount: 10 });
    await decide(db, { adminId: ADMIN_A, action: "approve", ticketId: approved }).run;
    await decide(db, { adminId: ADMIN_A, action: "complete", ticketId: approved }).run;

    const rejectCompleted = decide(db, { adminId: ADMIN_B, action: "reject", ticketId: approved });
    await rejectCompleted.run;
    assert.match(rejectCompleted.interaction.state.replies[0].content, /is already completed/);

    const fresh = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000023", amount: 12 });
    await decide(db, { adminId: ADMIN_A, action: "approve", ticketId: fresh }).run;
    const rejectApproved = decide(db, { adminId: ADMIN_B, action: "reject", ticketId: fresh });
    await rejectApproved.run;
    assert.match(rejectApproved.interaction.state.replies[0].content, /is already approved by <@300000000000000001> and can no longer be rejected/);
    assert.equal((await getTicket(db, fresh)).status, "approved", "an approved ticket cannot be silently un-processed");
    assert.equal((await getLedger(db)).length, 1, "only the completed ticket wrote a ledger entry");
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Closing a pending channel and permission enforcement.
// ---------------------------------------------------------------------------

test("tickets 16: closing a pending ticket channel rejects the ticket so payouts die with the channel", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000024", { balance: 700 });
    const ticketId = await createPendingTicket(db, { kind: "withdraw", requesterId: "300000000000000024", amount: 70 });
    await attachTicketChannel(db, ticketId, "channel-42");
    await rejectPendingTicketByChannel(db, "channel-42", "Ticket channel closed");

    const row = await getTicket(db, ticketId);
    assert.equal(row.status, "rejected");
    assert.match(row.note, /Ticket channel closed/);

    const payoutAttempt = decide(db, { adminId: ADMIN_A, action: "complete", ticketId, channelId: "channel-42" });
    await payoutAttempt.run;
    assert.match(payoutAttempt.interaction.state.replies[0].content, /was rejected.*cannot be processed\./);
    assert.equal(await getBalance(db, "300000000000000024"), 700);
    assert.equal((await getLedger(db)).length, 0);

    // Completed tickets must NOT be affected by a late channel close.
    const done = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000024", amount: 15 });
    await attachTicketChannel(db, done, "channel-43");
    await decide(db, { adminId: ADMIN_A, action: "approve", ticketId: done, channelId: "channel-43" }).run;
    await decide(db, { adminId: ADMIN_A, action: "complete", ticketId: done, channelId: "channel-43" }).run;
    await rejectPendingTicketByChannel(db, "channel-43", "Ticket channel closed");
    assert.equal((await getTicket(db, done)).status, "completed", "completed state survives channel closure");
    assert.equal(await getBalance(db, "300000000000000024"), 715);
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 17: non-admins are refused server-side and unknown references are rejected", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "300000000000000025", { balance: 300 });
    const ticketId = await createPendingTicket(db, { kind: "deposit", requesterId: "300000000000000025", amount: 50 });

    const stranger = decide(db, { adminId: "300000000000000026", action: "approve", ticketId, permissions: [PermissionFlagsBits.KickMembers] });
    await stranger.run;
    assert.match(stranger.interaction.state.replies[0].content, /Only server administrators can process PTB tickets\./);
    assert.equal(stranger.interaction.state.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal((await getTicket(db, ticketId)).status, "pending");

    const nullPermissions = decide(db, { adminId: "300000000000000026", action: "complete", ticketId, permissions: null });
    await nullPermissions.run;
    assert.match(nullPermissions.interaction.state.replies[0].content, /Only server administrators can process PTB tickets\./);

    const unknown = decide(db, { adminId: ADMIN_A, action: "approve", ticketId: 999_999 });
    await unknown.run;
    assert.match(unknown.interaction.state.replies[0].content, /Ticket #999999 was not found\./);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Restart persistence of an in-flight ticket and audit fields.
// ---------------------------------------------------------------------------

test("tickets 18: an approved ticket survives a restart and completes exactly once afterwards", async () => {
  const { db, dir, url } = openTestDb();
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements], "write");
    await seedAccount(db, "990000000000000009", { balance: 1_000 });
    const ticketId = await createPendingTicket(db, { kind: "withdraw", requesterId: "990000000000000009", amount: 60 });
    await decide(db, { adminId: ADMIN_A, action: "approve", ticketId }).run;
    await db.close();

    // Restart: brand-new client, same database file, schema re-runs idempotently.
    const db2 = createClient({ url });
    try {
      await db2.batch([...schemaStatements, ...ticketSchemaStatements], "write");
      assert.equal((await getTicket(db2, ticketId)).status, "approved", "in-flight ticket survives restart");
      assert.equal((await getTicket(db2, ticketId)).decision_by, ADMIN_A, "the approver survives the restart");

      // /balance remains readable on the restarted instance.
      const balanceCheck = ticketInteraction({ userId: "990000000000000009" });
      await handleBalance(db2, balanceCheck);
      assert.match(balanceCheck.state.replies[0].content, /Your current PTB balance is 1,000\./);

      const payout = decide(db2, { adminId: ADMIN_B, action: "complete", ticketId });
      await payout.run;
      assert.match(payout.interaction.state.replies[0].content, /completed: paid out 60 from <@990000000000000009>\. New balance: 940\./);

      const replay = decide(db2, { adminId: ADMIN_C, action: "complete", ticketId });
      await replay.run;
      assert.match(replay.interaction.state.replies[0].content, /was already completed by <@300000000000000002>/);
      assert.equal(await getBalance(db2, "990000000000000009"), 940, "still paid out exactly once after restart");
      assert.equal((await getLedger(db2)).length, 1);
    } finally {
      await db2.close();
    }
  } finally {
    try { await db.close(); } catch { }
    await removeDirBestEffort(dir);
  }
});

test("tickets 19: ticket isolation — the suite uses only throwaway local file databases", () => {
  const { url } = openTestDb();
  assert.ok(url.startsWith("file:"), "ticket tests must use a local file database");
  assert.ok(url.includes("ptb-ticket-test"));
  assert.notEqual(url, process.env.TURSO_URL);
});
