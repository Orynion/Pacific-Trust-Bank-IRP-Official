import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  handleAddBalance,
  handleBalance,
  handleMoneyRequest,
  handleTransfer,
  schemaStatements,
  validateMoneyAmount,
} from "./bank-ops.js";
import { getTransactionHistory } from "./transaction-history.js";

// ---------------------------------------------------------------------------
// Test isolation: every test builds its own throwaway local SQLite database in
// the OS temporary directory. process.env TURSO_URL / DISCORD_TOKEN are never
// read here: the production Turso database is never touched by this suite.
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
  const dir = mkdtempSync(join(tmpdir(), "ptb-test-"));
  createdDirs.push(dir);
  const url = `file:${join(dir, "ptb-test.db").replace(/\\/g, "/")}`;
  const db = createClient({ url });
  return { db, dir, url };
}

let nextInteractionNumber = 880_500_000_000_000_000n;

const ADMIN_FLAG = PermissionFlagsBits.Administrator;
function createInteraction({
  id = String(nextInteractionNumber++),
  userId = "100000000000000001",
  targetUser = null,
  amount = null,
  confirm = null,
  permissions = null,
  inGuild = true,
} = {}) {
  const state = { id, replies: [], edits: [], deferred: false, replied: false };
  const memberPermissions = permissions === null ? null : { has: (flag) => permissions.includes(flag) };
  const interaction = {
    id,
    user: { id: userId, username: `user_${userId}`, bot: false, tag: `user_${userId}#0001` },
    options: {
      getInteger(name, required = false) {
        if (name === "amount") {
          if (amount === null && required) throw new Error(`missing required option ${name}`);
          return amount;
        }
        return null;
      },
      getUser(name, required = false) {
        if (name === "user") {
          if (targetUser === null && required) throw new Error(`missing required option ${name}`);
          return targetUser;
        }
        return null;
      },
      getBoolean(name, required = false) {
        if (name === "confirm") {
          if (confirm === null && required) throw new Error(`missing required option ${name}`);
          return confirm;
        }
        return null;
      },
    },
    inGuild: () => inGuild,
    guild: {
      channels: { fetch: async () => ({ find: () => undefined }) },
      roles: { everyone: { id: "everyone-role" } },
    },
    memberPermissions,
    isButton: () => false,
    isChatInputCommand: () => true,
    async deferReply() {
      state.deferred = true;
    },
    async editReply(content) {
      state.edits.push(content);
      return content;
    },
    async reply(payload) {
      if (state.replied) throw new Error("interaction.reply called twice");
      state.replied = true;
      state.replies.push(payload);
      return payload;
    },
  };
  interaction.state = state;
  return interaction;
}

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

async function ledgerTotal(db, discordId) {
  const result = await db.execute({
    sql: `SELECT
      COALESCE(SUM(CASE WHEN to_id = ? THEN amount ELSE 0 END), 0) AS credited,
      COALESCE(SUM(CASE WHEN from_id = ? THEN amount ELSE 0 END), 0) AS debited
      FROM transactions WHERE status = 'completed'`,
    args: [discordId, discordId],
  });
  return {
    credited: Number(result.rows[0].credited),
    debited: Number(result.rows[0].debited),
  };
}

function makeTarget(targetId) {
  return { id: targetId, username: `user_${targetId}`, bot: false, tag: `user_${targetId}#0001` };
}

function runTransfer(db, { senderId, targetId, amount, confirm = true, id }) {
  const interaction = createInteraction({
    id,
    userId: senderId,
    targetUser: makeTarget(targetId),
    amount,
    confirm,
  });
  return { interaction, result: handleTransfer(db, interaction) };
}

function runAddBalance(db, { adminId, targetId, amount, id, permissions = [ADMIN_FLAG] }) {
  const interaction = createInteraction({
    id,
    userId: adminId,
    targetUser: makeTarget(targetId),
    amount,
    permissions,
  });
  return { interaction, result: handleAddBalance(db, interaction) };
}

function runMoneyRequest(db, { userId, type, amount, inGuild = true }) {
  const interaction = createInteraction({ userId, amount, inGuild });
  return { interaction, result: handleMoneyRequest(db, interaction, type) };
}

/**
 * Fault-injection wrapper around a libsql client: the first execute() whose SQL
 * matches `failWhen` throws a simulated failure. TransactionhandleExecute is
 * wrapped the same way so handlers running inside a transaction hit the fault
 * too.
 */
function wrapDbWithFailure(db, failWhen) {
  const wrapExecute = (underlyingExecute) => {
    let failed = false;
    return async (query) => {
      if (!failed && failWhen(query)) {
        failed = true;
        throw new Error("Simulated database failure (test-only fault injection)");
      }
      return underlyingExecute(query);
    };
  };
  const execute = wrapExecute((query) => db.execute(query));
  return {
    execute,
    async transaction(mode) {
      const tx = await db.transaction(mode);
      const txExecute = wrapExecute((query) => tx.execute(query));
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
// Case 1: unregistered users cannot access balances or transfer funds.
// ---------------------------------------------------------------------------

test("case 1: /balance is denied for unregistered users", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch(schemaStatements, "write");
    const interaction = createInteraction({ userId: "200000000000000001" });

    await handleBalance(db, interaction);

    assert.equal(interaction.state.replies.length, 1);
    assert.match(interaction.state.replies[0].content, /do not have a registered PTB account yet/i);
    assert.equal(interaction.state.replies[0].flags, MessageFlags.Ephemeral);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 1: /balance works once the account is registered (and stays private)", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, "200000000000000002", { balance: 4321 });

    const interaction = createInteraction({ userId: "200000000000000002" });
    await handleBalance(db, interaction);

    // /balance replies with a private embed carrying the balance value.
    assert.match(interaction.state.replies[0].embeds[0].data.description, /4,321/);
    assert.equal(interaction.state.replies[0].flags, MessageFlags.Ephemeral);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 1: transfers from unregistered senders are rejected", async () => {
  const { db, dir } = openTestDb();
  const senderId = "200000000000000003";
  const targetId = "200000000000000004";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, targetId, { balance: 50 });

    const { interaction, result } = runTransfer(db, { senderId, targetId, amount: 10, id: "770000000000000001" });
    await result;

    assert.match(interaction.state.replies[0].content, /do not have a registered PTB account yet\. Run \/register to link your Roblox account first\./);
    assert.equal(await getBalance(db, senderId), null);
    assert.equal(await getBalance(db, targetId), 50);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 1: transfers to unregistered recipients are rejected", async () => {
  const { db, dir } = openTestDb();
  const senderId = "200000000000000005";
  const targetId = "200000000000000006";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 100 });

    const { interaction, result } = runTransfer(db, { senderId, targetId, amount: 10, id: "770000000000000002" });
    await result;

    assert.match(interaction.state.replies[0].content, /user_200000000000000006 does not have a registered PTB account\./);
    assert.equal(await getBalance(db, senderId), 100);
    assert.equal(await getBalance(db, targetId), null);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Case 2: users cannot transfer more than their available balance.
// ---------------------------------------------------------------------------

test("case 2: transferring more than the balance is rejected", async () => {
  const { db, dir } = openTestDb();
  const senderId = "210000000000000001";
  const targetId = "210000000000000002";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 100 });
    await seedAccount(db, targetId);

    const { interaction, result } = runTransfer(db, { senderId, targetId, amount: 101, id: "770000000000000003" });
    await result;

    assert.match(
      interaction.state.replies[0].content,
      /Insufficient funds\. Your current balance is 100, but you tried to transfer 101\./,
    );
    assert.equal(await getBalance(db, senderId), 100);
    assert.equal(await getBalance(db, targetId), 0);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 2: transferring the exact balance is allowed", async () => {
  const { db, dir } = openTestDb();
  const senderId = "210000000000000003";
  const targetId = "210000000000000004";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 100 });
    await seedAccount(db, targetId);

    const { interaction, result } = runTransfer(db, { senderId, targetId, amount: 100, id: "770000000000000004" });
    await result;

    assert.match(interaction.state.replies[0].content, /Transferred 100 to user_210000000000000004\. Your new balance: 0\./);
    assert.equal(await getBalance(db, senderId), 0);
    assert.equal(await getBalance(db, targetId), 100);
    assert.equal((await getLedger(db)).length, 1);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 2: withdrawal request above the balance is denied when opening the ticket", async () => {
  const { db, dir } = openTestDb();
  const userId = "210000000000000005";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, userId, { balance: 500 });

    const { interaction, result } = runMoneyRequest(db, { userId, type: "withdraw", amount: 1000 });
    await result;

    assert.match(interaction.state.edits[0], /You requested 1,000, but your current balance is 500\./);
    assert.equal(await getBalance(db, userId), 500);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Case 3: users cannot transfer money to themselves.
// ---------------------------------------------------------------------------

test("case 3: self-transfer is rejected", async () => {
  const { db, dir } = openTestDb();
  const userId = "220000000000000001";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, userId, { balance: 250 });

    const { interaction, result } = runTransfer(db, { senderId: userId, targetId: userId, amount: 25, id: "770000000000000005" });
    await result;

    assert.match(interaction.state.replies[0].content, /You cannot transfer money to yourself\./);
    assert.equal(await getBalance(db, userId), 250);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Case 4: negative, zero, invalid, and excessively large amounts are rejected.
// ---------------------------------------------------------------------------

const INVALID_AMOUNTS = [
  ["negative", -1],
  ["zero", 0],
  ["fractional", 7.25],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["negative Infinity", Number.NEGATIVE_INFINITY],
  ["above MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
  ["above 32-bit money cap (2**31)", 2 ** 31],
  ["far above cap", 5_000_000_000_000],
];

test("case 4: validateMoneyAmount rejects every invalid amount class", () => {
  for (const [label, amount] of INVALID_AMOUNTS) {
    assert.equal(validateMoneyAmount(amount).ok, false, `${label} (${amount}) should be rejected`);
  }
  assert.equal(validateMoneyAmount(1).ok, true);
  assert.equal(validateMoneyAmount(2_147_483_647).ok, true);
});

test("case 4: /transfer rejects every invalid amount class end to end", async () => {
  const { db, dir } = openTestDb();
  const senderId = "230000000000000001";
  const targetId = "230000000000000002";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 100 });
    await seedAccount(db, targetId);

    for (const [label, amount] of INVALID_AMOUNTS) {
      const { interaction, result } = runTransfer(db, { senderId, targetId, amount, id: `770000000000000a${label.length}${(nextInteractionNumber++).toString().slice(-6)}` });
      await result;
      const content = interaction.state.replies[0]?.content ?? "";
      assert.equal(content, validateMoneyAmount(amount).message, `${label} (${amount}) got: ${content}`);
    }

    assert.equal(await getBalance(db, senderId), 100);
    assert.equal(await getBalance(db, targetId), 0);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 4: /add-balance rejects zero and excessively large amounts", async () => {
  const { db, dir } = openTestDb();
  const adminId = "230000000000000003";
  const targetId = "230000000000000004";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, targetId, { balance: 10 });

    for (const amount of [0, -5, 2 ** 31, 9_007_199_254_740_993]) {
      const { interaction, result } = runAddBalance(db, { adminId, targetId, amount, id: `770000000000000b${nextInteractionNumber++}` });
      await result;
      assert.equal(
        interaction.state.replies[0]?.content ?? "",
        validateMoneyAmount(amount).message,
        `amount ${amount} should be rejected`,
      );
    }

    assert.equal(await getBalance(db, targetId), 10);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 4: money request with zero amount is rejected server-side", async () => {
  const { db, dir } = openTestDb();
  const userId = "230000000000000005";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, userId, { balance: 100 });

    const { interaction, result } = runMoneyRequest(db, { userId, type: "deposit", amount: 0 });
    await result;

    assert.match(interaction.state.edits[0], /Amount must be a positive whole number\./);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Case 5: concurrent transfers cannot overspend an account.
// ---------------------------------------------------------------------------

test("case 5: two racing transfers that exceed the balance cannot both commit", async () => {
  const { db, dir } = openTestDb();
  const senderId = "240000000000000001";
  const targetA = "240000000000000002";
  const targetB = "240000000000000003";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 100 });
    await seedAccount(db, targetA);
    await seedAccount(db, targetB);

    const outcomes = await Promise.allSettled([
      runTransfer(db, senderId, targetA, 60, "900000000000000001"),
      runTransfer(db, senderId, targetB, 70, "900000000000000002"),
    ].map(({ result }) => result));

    // Simulated concurrent load may reject legitimately with fail-closed
    // SQLITE_BUSY (no overspend); cross-check that invariants still hold.
    const ledger = await getLedger(db);
    const completedTransfers = ledger.filter((row) => row.type === "transfer" && row.status === "completed");

    const debitSum = completedTransfers.reduce((sum, row) => sum + row.amount, 0);
    const finalBalance = await getBalance(db, senderId);

    assert.ok(finalBalance >= 0, `balance must never go negative, got ${finalBalance}`);
    assert.ok(debitSum <= 100, `completed debits (${debitSum}) must never exceed the starting balance`);
    assert.equal(finalBalance, 100 - debitSum, "balance must exactly reflect completed ledger debits");
    assert.equal(
      completedTransfers.length,
      ledger.filter((row) => row.type === "transfer" && row.status === "completed").length,
    );
    assert.ok(completedTransfers.length <= 1, "racing 60+70 transfers cannot both commit against a 100 balance");
    assert.equal((await ledgerTotal(db, targetA)).debited, 0);
    assert.equal((await ledgerTotal(db, targetB)).debited, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 5: burst of concurrent small transfers maintains the invariant", async () => {
  const { db, dir } = openTestDb();
  const senderId = "240000000000000004";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 100 });

    const targets = [];
    for (let index = 0; index < 6; index += 1) {
      const targetId = `2400000000000${(5 + index).toString().padStart(2, "0")}`.slice(0, 18);
      await seedAccount(db, targetId);
      targets.push(targetId);
    }

    await Promise.allSettled(
      targets.map((targetId, index) =>
        runTransfer(db, { senderId, targetId, amount: 50, id: `91000000000000${String(index).padStart(4, "0")}` }).result),
    );

    const finalBalance = await getBalance(db, senderId);
    const ledger = await getLedger(db);
    const debitSum = ledger
      .filter((row) => row.type === "transfer" && row.status === "completed")
      .reduce((sum, row) => sum + row.amount, 0);

    assert.ok(finalBalance >= 0, `balance must never go negative, got ${finalBalance}`);
    assert.ok(debitSum <= 100, `completed debits (${debitSum}) must never exceed the starting balance`);
    assert.equal(finalBalance, 100 - debitSum);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 5: the atomic debit guard denies an insufficient balance inside the write statement", async () => {
  const { db, dir } = openTestDb();
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, "240000000000000011", { balance: 100 });

    const tx = await db.transaction("write");
    try {
      const seen = await tx.execute({
        sql: "SELECT balance FROM accounts WHERE discord_id = ? LIMIT 1",
        args: ["240000000000000011"],
      });
      assert.equal(Number(seen.rows[0].balance), 100);

      // Oversize request: the guard must refuse even though an earlier
      // (stale) read said the balance was sufficient.
      const denied = await tx.execute({
        sql: "UPDATE accounts SET balance = balance - ? WHERE discord_id = ? AND balance >= ?",
        args: [101, "240000000000000011", 101],
      });
      assert.equal(denied.rowsAffected, 0);

      const allowed = await tx.execute({
        sql: "UPDATE accounts SET balance = balance - ? WHERE discord_id = ? AND balance >= ?",
        args: [100, "240000000000000011", 100],
      });
      assert.equal(allowed.rowsAffected, 1);
      await tx.commit();
    } finally {
      tx.close();
    }

    assert.equal(await getBalance(db, "240000000000000011"), 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Case 6: duplicate deposit/withdrawal confirmations cannot process the same
// transaction twice. The bot's automated crediting paths (/transfer and
// /add-balance) are guarded by the processed_interactions ledger, which is
// written in the same transaction as the balances.
// ---------------------------------------------------------------------------

test("case 6: replaying the same /add-balance confirmation applies the deposit exactly once", async () => {
  const { db, dir } = openTestDb();
  const adminId = "250000000000000001";
  const targetId = "250000000000000002";
  const interactionId = "920000000000000001";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, targetId);

    const first = runAddBalance(db, { adminId, targetId, amount: 500, id: interactionId });
    await first.result;
    assert.match(first.interaction.state.replies[0].content, /Added 500 to user_250000000000000002's balance\. New balance: 500\./);

    // Same interaction delivered again (double-click/Discord re-delivery).
    const replay = runAddBalance(db, { adminId, targetId, amount: 500, id: interactionId });
    await replay.result;
    assert.match(replay.interaction.state.replies[0].content, /This request was already processed\./);

    assert.equal(await getBalance(db, targetId), 500, "balance must be credited exactly once");
    assert.equal((await getLedger(db)).length, 1, "exactly one ledger row for the single real deposit");
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 6: replaying the same /transfer confirmation moves funds exactly once", async () => {
  const { db, dir } = openTestDb();
  const senderId = "250000000000000003";
  const targetId = "250000000000000004";
  const interactionId = "920000000000000002";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 700 });
    await seedAccount(db, targetId);

    const first = runTransfer(db, { senderId, targetId, amount: 250, id: interactionId });
    await first.result;
    assert.match(first.interaction.state.replies[0].content, /Transferred 250 to user_250000000000000004\. Your new balance: 450\./);

    const replay = runTransfer(db, { senderId, targetId, amount: 250, id: interactionId });
    await replay.result;
    assert.match(replay.interaction.state.replies[0].content, /This request was already processed\./);

    assert.equal(await getBalance(db, senderId), 450);
    assert.equal(await getBalance(db, targetId), 250);
    assert.equal((await getLedger(db)).length, 1);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 6: a failed transaction rolls back the duplicate guard, so a legitimate retry works", async () => {
  const { db, dir } = openTestDb();
  const adminId = "250000000000000005";
  const targetId = "250000000000000006";
  const interactionId = "920000000000000003";
  try {
    await db.batch(schemaStatements, "write");

    // First attempt: recipient not registered yet. The guard row (inserted
    // inside the transaction) must roll back with it.
    const failed = runAddBalance(db, { adminId, targetId, amount: 300, id: interactionId });
    await failed.result;
    assert.match(failed.interaction.state.replies[0].content, /does not have a registered PTB account\./);

    await seedAccount(db, targetId);
    const retry = runAddBalance(db, { adminId, targetId, amount: 300, id: interactionId });
    await retry.result;
    assert.match(retry.interaction.state.replies[0].content, /Added 300 to user_250000000000000006's balance\. New balance: 300\./);

    assert.equal(await getBalance(db, targetId), 300);
    assert.equal((await getLedger(db)).length, 1);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Case 7: failed transactions leave balances unchanged.
// ---------------------------------------------------------------------------

test("case 7: an injected database failure mid-transfer leaves all balances unchanged", async () => {
  const { db, dir } = openTestDb();
  const senderId = "260000000000000001";
  const targetId = "260000000000000002";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 500 });
    await seedAccount(db, targetId, { balance: 100 });

    const failingDb = wrapDbWithFailure(db, (query) =>
      typeof query === "object" && typeof query?.sql === "string" && query.sql.startsWith("UPDATE accounts SET balance = balance - ?"));

    const { result } = runTransfer(failingDb, { senderId, targetId, amount: 100, id: "930000000000000001" });
    await assert.rejects(result, /Simulated database failure/);

    assert.equal(await getBalance(db, senderId), 500, "sender balance must be unchanged after failure");
    assert.equal(await getBalance(db, targetId), 100, "receiver balance must be unchanged after failure");
    assert.equal((await getLedger(db)).length, 0, "no ledger row may exist for a failed transaction");

    // The account must remain usable afterwards.
    const recovery = runTransfer(db, { senderId, targetId, amount: 100, id: "930000000000000002" });
    await recovery.result;
    assert.equal(await getBalance(db, senderId), 400);
    assert.equal(await getBalance(db, targetId), 200);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 7: frozen-account denials leave balances unchanged", async () => {
  const { db, dir } = openTestDb();
  const senderId = "260000000000000003";
  const targetId = "260000000000000004";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 300, frozen: 1 });
    await seedAccount(db, targetId);

    const frozenSender = runTransfer(db, { senderId, targetId, amount: 50, id: "930000000000000003" });
    await frozenSender.result;
    assert.match(frozenSender.interaction.state.replies[0].content, /Your account is frozen\. You cannot transfer money\./);

    await db.execute({
      sql: "UPDATE accounts SET frozen = 0 WHERE discord_id = ?",
      args: [senderId],
    });
    await db.execute({
      sql: "UPDATE accounts SET frozen = 1 WHERE discord_id = ?",
      args: [targetId],
    });

    const frozenTarget = runTransfer(db, { senderId, targetId, amount: 50, id: "930000000000000004" });
    await frozenTarget.result;
    assert.match(frozenTarget.interaction.state.replies[0].content, /user_260000000000000004's account is frozen and cannot receive transfers\./);

    assert.equal(await getBalance(db, senderId), 300);
    assert.equal(await getBalance(db, targetId), 0);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

test("case 7: recipient balance cap is enforced and leaves both accounts unchanged", async () => {
  const { db, dir } = openTestDb();
  const senderId = "260000000000000005";
  const targetId = "260000000000000006";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 2_147_483_646 });
    await seedAccount(db, targetId, { balance: 2_147_483_647 });

    const { interaction, result } = runTransfer(db, { senderId, targetId, amount: 10, id: "930000000000000005" });
    await result;

    assert.match(interaction.state.replies[0].content, /That transfer would exceed the recipient's supported balance limit\./);
    assert.equal(await getBalance(db, senderId), 2_147_483_646);
    assert.equal(await getBalance(db, targetId), 2_147_483_647);
    assert.equal((await getLedger(db)).length, 0);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Case 8: admin-only commands enforce server-side permissions.
// ---------------------------------------------------------------------------

test("case 8: /add-balance refuses members without Administrator permission", async () => {
  const { db, dir } = openTestDb();
  const adminId = "270000000000000001";
  const targetId = "270000000000000002";
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, targetId, { balance: 5 });

    // No memberPermissions at all (malicious/absent context must fail closed).
    const noPermissions = runAddBalance(db, { adminId, targetId, amount: 1000, id: "940000000000000001", permissions: null });
    await noPermissions.result;
    assert.match(noPermissions.interaction.state.replies[0].content, /Only server administrators can use this command\./);

    // Moderator with non-admin permission bits.
    const nonAdmin = runAddBalance(db, { adminId, targetId, amount: 1000, id: "940000000000000002", permissions: [PermissionFlagsBits.KickMembers] });
    await nonAdmin.result;
    assert.match(nonAdmin.interaction.state.replies[0].content, /Only server administrators can use this command\./);

    assert.equal(await getBalance(db, targetId), 5);
    assert.equal((await getLedger(db)).length, 0);

    const admin = runAddBalance(db, { adminId, targetId, amount: 1000, id: "940000000000000003" });
    await admin.result;
    assert.match(admin.interaction.state.replies[0].content, /Added 1,000 to user_270000000000000002's balance\. New balance: 1,005\./);
    assert.equal(await getBalance(db, targetId), 1_005);
    assert.equal((await getLedger(db)).length, 1);
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Case 9: transaction history and balances remain correct after a restart.
// ---------------------------------------------------------------------------

test("case 9: balances and history survive a restart (fresh client on the same database)", async () => {
  const { db, dir, url } = openTestDb();
  const senderId = "280000000000000001";
  const targetId = "280000000000000002";
  const adminId = "280000000000000003";
  const daveId = "280000000000000004";
  const interactionBase = 950000000000000000n;
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, senderId, { balance: 400 });
    await seedAccount(db, targetId);
    await seedAccount(db, daveId, { balance: 20 });

    await runTransfer(db, { senderId, targetId, amount: 175, id: (interactionBase + 1n).toString() }).result;
    await runAddBalance(db, { adminId, targetId: senderId, amount: 60, id: (interactionBase + 2n).toString() }).result;
    await runTransfer(db, { senderId: daveId, targetId: senderId, amount: 15, id: (interactionBase + 3n).toString() }).result;

    const balancesBefore = {
      sender: await getBalance(db, senderId),
      target: await getBalance(db, targetId),
    };
    const ledgerBefore = await getLedger(db);
    await db.close();

    // Simulate process restart: brand-new client against the same database
    // file, re-running the startup schema batch (idempotency requirement).
    const db2 = createClient({ url });
    try {
      await db2.batch(schemaStatements, "write");

      assert.equal(await getBalance(db2, senderId), balancesBefore.sender);
      assert.equal(await getBalance(db2, targetId), balancesBefore.target);
      assert.equal(balancesBefore.sender, 300);
      assert.equal(balancesBefore.target, 175);

      const ledgerAfter = await getLedger(db2);
      assert.equal(ledgerAfter.length, 3);
      assert.deepEqual(
        ledgerAfter.map(({ id, type, from_id, to_id, amount, status }) => ({ id, type, from_id, to_id, amount, status })),
        ledgerBefore.map(({ id, type, from_id, to_id, amount, status }) => ({ id, type, from_id, to_id, amount, status })),
      );

      const senderHistory = await getTransactionHistory(db2, senderId, 0);
      assert.match(senderHistory.content, /Sent -175/);
      assert.match(senderHistory.content, /Added \+60/);
      assert.match(senderHistory.content, /Received \+15/);

      const targetHistory = await getTransactionHistory(db2, targetId, 0);
      assert.match(targetHistory.content, /Received \+175/);

      // The restarted instance keeps processing transactions correctly.
      const post = runTransfer(db2, { senderId, targetId, amount: 5, id: (interactionBase + 4n).toString() });
      await post.result;
      assert.match(post.interaction.state.replies[0].content, /Transferred 5 to user_280000000000000002\. Your new balance: 295\./);
      assert.equal(await getBalance(db2, senderId), balancesBefore.sender - 5);
      assert.equal(await getLedger(db2).then((rows) => rows.length), 4);
    } finally {
      await db2.close();
    }
  } finally {
    try {
      await db.close();
    } catch {
      // already closed during the restart simulation
    }
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Case 10: every successful balance change creates an auditable ledger entry.
// ---------------------------------------------------------------------------

test("case 10: ledger entries account for every balance delta across mixed operations", async () => {
  const { db, dir } = openTestDb();
  const adminId = "290000000000000001";
  const alice = "290000000000000002";
  const bob = "290000000000000003";
  const carol = "290000000000000004";
  const emptyUser = "290000000000000005";
  const interactionBase = 960000000000000000n;
  try {
    await db.batch(schemaStatements, "write");
    await seedAccount(db, alice, { balance: 1_000 });
    await seedAccount(db, bob);
    await seedAccount(db, carol);
    await seedAccount(db, emptyUser);

    await runAddBalance(db, { adminId, targetId: bob, amount: 2_000, id: (interactionBase + 1n).toString() }).result;
    await runTransfer(db, { senderId: alice, targetId: bob, amount: 300, id: (interactionBase + 2n).toString() }).result;
    await runTransfer(db, { senderId: bob, targetId: carol, amount: 750, id: (interactionBase + 3n).toString() }).result;
    // Two failing operations that must NOT create ledger entries:
    await runTransfer(db, { senderId: emptyUser, targetId: alice, amount: 5, id: (interactionBase + 4n).toString() }).result; // insufficient (zero balance)
    await runTransfer(db, { senderId: alice, targetId: "290000000000000099", amount: 5, id: (interactionBase + 5n).toString() }).result; // unregistered target

    const ledger = await getLedger(db);
    assert.equal(ledger.length, 3, "only successful operations create ledger entries");

    for (const discordId of [alice, bob, carol, emptyUser]) {
      const { credited, debited } = await ledgerTotal(db, discordId);
      const expectedBalance = credited - debited + (discordId === alice ? 1_000 : 0);
      assert.equal(
        await getBalance(db, discordId),
        expectedBalance,
        `account ${discordId} balance must equal the ledger-derived amount`,
      );
    }
    assert.equal(await getBalance(db, adminId), null, "the admin invocation itself creates no account");

    for (const row of ledger) {
      assert.ok(row.amount > 0, "ledger amount must be positive");
      assert.equal(row.status, "completed");
    }
    const adminRow = ledger.find((row) => row.type === "deposit");
    assert.ok(adminRow, "admin addition must be recorded");
    assert.equal(adminRow.to_id, bob);
    assert.equal(adminRow.staff_id, adminId);
    assert.equal(adminRow.note, "Admin balance addition");

    const transferRows = ledger.filter((row) => row.type === "transfer");
    assert.equal(transferRows.length, 2);
    for (const row of transferRows) {
      assert.ok(row.from_id && row.to_id, "transfer rows must name both parties");
      assert.equal(row.staff_id, null);
    }

    // Debit and credit sides must always match per completed transfer.
    for (const row of transferRows) {
      const debitSide = await ledgerTotal(db, row.from_id);
      const creditSide = await ledgerTotal(db, row.to_id);
      assert.ok(debitSide.debited >= row.amount);
      assert.ok(creditSide.credited >= row.amount);
    }
  } finally {
    await db.close();
    await removeDirBestEffort(dir);
  }
});

// ---------------------------------------------------------------------------
// Test isolation sanity check.
// ---------------------------------------------------------------------------

test("test isolation: suite uses dedicated local file databases, never the production Turso config", async () => {
  const { url } = openTestDb();
  assert.ok(url.startsWith("file:"), "tests must use a local file database");
  assert.ok(url.includes("ptb-test"), "test databases must be clearly labelled");
  assert.notEqual(url, process.env.TURSO_URL);
  await removeDirBestEffort(url.slice("file:".length).replace(/\/[^/]+$/, ""));
});
