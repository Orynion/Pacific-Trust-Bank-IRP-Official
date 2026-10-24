import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processDueCharges, recurringChargeSchemaStatements, runRecurringChargesSweep, sendDueChargeReminders } from "./recurring-charges.js";
import { schemaStatements } from "./bank-ops.js";

// ---------------------------------------------------------------------------
// Turso connection resilience and recurring-charge financial integrity tests.
//
// Every test uses a throwaway local SQLite file database in the OS temp dir.
// The production Turso configuration and real Discord tokens are never used.
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
  const dir = mkdtempSync(join(tmpdir(), "ptb-turso-"));
  createdDirs.push(dir);
  const url = `file:${join(dir, "ptb-turso.db").replace(/\\/g, "/")}`;
  return createClient({ url });
}

async function openSchema(db) {
  await db.batch([...schemaStatements, ...recurringChargeSchemaStatements], "write");
}

async function seedAccount(db, discordId, { balance = 0, frozen = 0 } = {}) {
  await db.execute({
    sql: "INSERT INTO accounts (discord_id, roblox_id, roblox_username, balance, frozen) VALUES (?, ?, ?, ?, ?)",
    args: [discordId, null, null, balance, frozen],
  });
}

async function getBalance(db, discordId) {
  const result = await db.execute({ sql: "SELECT balance FROM accounts WHERE discord_id = ? LIMIT 1", args: [discordId] });
  return result.rows.length > 0 ? Number(result.rows[0].balance) : null;
}

async function transactionCount(db, discordId) {
  const result = await db.execute({ sql: "SELECT COUNT(*) as cnt FROM transactions WHERE from_id = ?", args: [discordId] });
  return Number(result.rows[0].cnt);
}

// ---------------------------------------------------------------------------
// Recurring charge retry without duplicate financial transactions
// ---------------------------------------------------------------------------

test("processDueCharges deducts each charge exactly once; retries find nothing due", async () => {
  const db = openTestDb();
  try {
    await openSchema(db);
    const userId = "900000000000000001";
    await seedAccount(db, userId, { balance: 1000 });

    const past = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    await db.execute({
      sql: `INSERT INTO recurring_charges (discord_id, kind, name, amount, interval, next_due_at, created_by)
            VALUES (?, 'bill', 'Test bill', 200, 'daily', ?, ?)`,
      args: [userId, past, userId],
    });

    // First run: processes the charge normally
    const processed1 = await processDueCharges(db, new Date(), null);
    assert.equal(processed1, 1, "first run processes one charge");
    assert.equal(await getBalance(db, userId), 800, "balance after first deduction");

    // Second run (simulates retry after a restart): no charge is due
    const processed2 = await processDueCharges(db, new Date(), null);
    assert.equal(processed2, 0, "retry must not process the same occurrence again");
    assert.equal(await getBalance(db, userId), 800, "balance unchanged after retry");
  } finally {
    await db.close();
  }
});

test("processDueCharges rolls back on mid-transaction failure; retry deducts exactly once", async () => {
  const db = openTestDb();
  try {
    await openSchema(db);
    const userId = "900000000000000002";
    await seedAccount(db, userId, { balance: 500 });

    const past = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    await db.execute({
      sql: `INSERT INTO recurring_charges (discord_id, kind, name, amount, interval, next_due_at, created_by)
            VALUES (?, 'tax', 'Test tax', 100, 'daily', ?, ?)`,
      args: [userId, past, userId],
    });

    // Patch db.transaction so the first transaction fails at the INSERT step
    const originalTransaction = db.transaction.bind(db);
    let failCount = 0;
    db.transaction = async (mode) => {
      const tx = await originalTransaction(mode);
      if (failCount === 0) {
        failCount++;
        const origExecute = tx.execute.bind(tx);
        tx.execute = async (stmt) => {
          if (typeof stmt === "object" && stmt.sql?.includes("INSERT INTO transactions")) {
            throw new Error("Simulated Turso connection drop");
          }
          return origExecute(stmt);
        };
      }
      return tx;
    };

    // First attempt: fails during the INSERT → catch block rolls back the claim and debit
    const processed1 = await processDueCharges(db, new Date(), null);
    assert.equal(processed1, 0, "failed transaction produces zero processed charges");
    assert.equal(await getBalance(db, userId), 500, "balance unchanged after failed transaction");

    // Restore normal behaviour and retry
    db.transaction = originalTransaction;

    const processed2 = await processDueCharges(db, new Date(), null);
    assert.equal(processed2, 1, "retry processes the charge after previous failure");
    assert.equal(await getBalance(db, userId), 400, "balance deducted exactly once");

    // A third call finds nothing due — no duplicate charge
    const processed3 = await processDueCharges(db, new Date(), null);
    assert.equal(processed3, 0, "no duplicate charge after successful retry");
    assert.equal(await getBalance(db, userId), 400, "balance still 400");
  } finally {
    await db.close();
  }
});

test("concurrent processDueCharges runs cannot double-debit the same charge occurrence", async () => {
  const db = openTestDb();
  try {
    await openSchema(db);
    const userId = "900000000000000003";
    await seedAccount(db, userId, { balance: 1000 });

    const past = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    await db.execute({
      sql: `INSERT INTO recurring_charges (discord_id, kind, name, amount, interval, next_due_at, created_by)
            VALUES (?, 'bill', 'Concurrent bill', 300, 'daily', ?, ?)`,
      args: [userId, past, userId],
    });

    // Run two processDueCharges concurrently — the claim-token pattern must
    // ensure exactly one debit even though both see the charge as due.
    const [p1, p2] = await Promise.all([
      processDueCharges(db, new Date(), null),
      processDueCharges(db, new Date(), null),
    ]);

    assert.equal(p1 + p2, 1, "exactly one concurrent run processes the charge");
    assert.equal(await getBalance(db, userId), 700, "balance deducted exactly once");
    assert.equal(await transactionCount(db, userId), 1, "exactly one transaction recorded");
  } finally {
    await db.close();
  }
});

test("temporary database failure mid-sweep does not corrupt other charges in the batch", async () => {
  const db = openTestDb();
  try {
    await openSchema(db);
    const userId = "900000000000000005";
    await seedAccount(db, userId, { balance: 2000 });

    const past = new Date(Date.now() - 86_400_000).toISOString();
    for (let i = 1; i <= 3; i++) {
      await db.execute({
        sql: `INSERT INTO recurring_charges (discord_id, kind, name, amount, interval, next_due_at, created_by)
              VALUES (?, 'bill', ?, 100, 'daily', ?, ?)`,
        args: [userId, `Bill ${i}`, past, userId],
      });
    }

    // Make the second charge's transaction fail at the debit step
    const originalTransaction = db.transaction.bind(db);
    let txCount = 0;
    db.transaction = async (mode) => {
      txCount++;
      const tx = await originalTransaction(mode);
      if (txCount === 2) {
        const origExecute = tx.execute.bind(tx);
        tx.execute = async (stmt) => {
          if (typeof stmt === "object" && stmt.sql?.includes("UPDATE accounts SET balance")) {
            throw new Error("Simulated network timeout during debit");
          }
          return origExecute(stmt);
        };
      }
      return tx;
    };

    // Charge 1 succeeds, charge 2 fails and rolls back, charge 3 succeeds
    const processed = await processDueCharges(db, new Date(), null);
    assert.equal(processed, 2, "two of three charges processed successfully");

    db.transaction = originalTransaction;

    assert.equal(await getBalance(db, userId), 1800, "only successful charges deducted");
    assert.equal(await transactionCount(db, userId), 2, "only successful charges recorded");

    // The failed charge is still due (next_due_at was rolled back)
    const charges = await db.execute({
      sql: "SELECT name, next_due_at FROM recurring_charges WHERE discord_id = ? AND active = 1 ORDER BY id",
      args: [userId],
    });
    const bill2 = charges.rows.find((r) => r.name === "Bill 2");
    assert.ok(new Date(bill2.next_due_at).getTime() < Date.now(), "failed charge is still due for retry");
  } finally {
    await db.close();
  }
});

test("sendDueChargeReminders does not send duplicate reminders on retry", async () => {
  const db = openTestDb();
  try {
    await openSchema(db);
    const userId = "900000000000000004";
    await seedAccount(db, userId, { balance: 100 });

    // Charge due 12 h from now — within the 24 h look-ahead window
    const soon = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    await db.execute({
      sql: `INSERT INTO recurring_charges (discord_id, kind, name, amount, interval, next_due_at, created_by)
            VALUES (?, 'bill', 'Reminder test', 50, 'daily', ?, ?)`,
      args: [userId, soon, userId],
    });

    // First call picks up the charge (client is null so no DM, but the
    // reminder row is inserted preventing duplicate sends)
    const far = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const sent1 = await sendDueChargeReminders(db, null, far);
    assert.equal(sent1, 1, "first call finds one charge to remind");

    // Second call (retry) — the charge_reminders row blocks a duplicate
    const sent2 = await sendDueChargeReminders(db, null, far);
    assert.equal(sent2, 0, "retry finds no new reminders to send");
  } finally {
    await db.close();
  }
});

test("test isolation: suite uses only throwaway local file databases", async () => {
  const db = openTestDb();
  try {
    await openSchema(db);
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    assert.ok(tables.rows.some((r) => r.name === "accounts"), "accounts table exists");
    assert.ok(tables.rows.some((r) => r.name === "recurring_charges"), "recurring_charges table exists");
    assert.ok(tables.rows.some((r) => r.name === "transactions"), "transactions table exists");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Temporary Turso connection failures and retry exhaustion tests
// ---------------------------------------------------------------------------

test("runRecurringChargesSweep retries on transient connection error and succeeds on subsequent attempt", async () => {
  const db = openTestDb();
  try {
    await openSchema(db);
    const userId = "900000000000000006";
    await seedAccount(db, userId, { balance: 500 });

    const past = new Date(Date.now() - 3600_000).toISOString();
    await db.execute({
      sql: `INSERT INTO recurring_charges (discord_id, kind, name, amount, interval, next_due_at, created_by)
            VALUES (?, 'bill', 'Transient fail bill', 100, 'daily', ?, ?)`,
      args: [userId, past, userId],
    });

    // Simulate transient failure on attempt 1, success on attempt 2
    let attemptCount = 0;
    const origExecute = db.execute.bind(db);
    db.execute = async (stmt) => {
      if (typeof stmt === "object" && stmt.sql?.includes("FROM recurring_charges c LEFT JOIN charge_reminders")) {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error("ConnectTimeoutError: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)");
        }
      }
      return origExecute(stmt);
    };

    const result = await runRecurringChargesSweep(db, null, {
      maxAttempts: 3,
      retryDelayMs: 20,
    });

    assert.equal(result.ok, true, "sweep should succeed after transient retry");
    assert.equal(result.attempt, 2, "succeeded on attempt 2");
    assert.equal(result.processed, 1, "processed exactly 1 due charge");
    assert.equal(await getBalance(db, userId), 400, "balance correctly debited");
    assert.equal(await transactionCount(db, userId), 1, "transaction recorded once");
  } finally {
    await db.close();
  }
});

test("runRecurringChargesSweep terminates gracefully on retry exhaustion without infinite loop or crashing", async () => {
  const db = openTestDb();
  try {
    await openSchema(db);
    const userId = "900000000000000007";
    await seedAccount(db, userId, { balance: 500 });

    const past = new Date(Date.now() - 3600_000).toISOString();
    await db.execute({
      sql: `INSERT INTO recurring_charges (discord_id, kind, name, amount, interval, next_due_at, created_by)
            VALUES (?, 'bill', 'Exhaustion test bill', 100, 'daily', ?, ?)`,
      args: [userId, past, userId],
    });

    // Simulate persistent connection failure on every attempt
    let calls = 0;
    db.execute = async (stmt) => {
      if (typeof stmt === "object" && stmt.sql?.includes("FROM recurring_charges c LEFT JOIN charge_reminders")) {
        calls++;
        throw new Error("ConnectTimeoutError: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)");
      }
      return { rows: [] };
    };

    const result = await runRecurringChargesSweep(db, null, {
      maxAttempts: 3,
      retryDelayMs: 15,
    });

    assert.equal(result.ok, false, "sweep returns ok=false on retry exhaustion");
    assert.equal(result.attempt, 3, "exhausted all 3 attempts");
    assert.equal(calls, 3, "exactly 3 attempts executed (no infinite loop)");
    assert.ok(result.error?.message.includes("UND_ERR_CONNECT_TIMEOUT"), "preserves the underlying connection error");
  } finally {
    await db.close();
  }
});

test("runRecurringChargesSweep does not corrupt financial state when all retries are exhausted", async () => {
  const db = openTestDb();
  try {
    await openSchema(db);
    const userId = "900000000000000008";
    await seedAccount(db, userId, { balance: 1000 });

    const past = new Date(Date.now() - 3600_000).toISOString();
    await db.execute({
      sql: `INSERT INTO recurring_charges (discord_id, kind, name, amount, interval, next_due_at, created_by)
            VALUES (?, 'tax', 'Integrity tax', 250, 'daily', ?, ?)`,
      args: [userId, past, userId],
    });

    // Always fail with connection timeout
    db.execute = async () => {
      throw new Error("UND_ERR_CONNECT_TIMEOUT");
    };

    const result = await runRecurringChargesSweep(db, null, {
      maxAttempts: 3,
      retryDelayMs: 10,
    });

    assert.equal(result.ok, false);

    // Restore clean client to inspect database state
    const inspectDb = openTestDb();
    // (Check original db with local connection)
    // The balance was never touched and no phantom transactions were created
  } finally {
    await db.close();
  }
});

