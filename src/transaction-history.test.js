import assert from "node:assert/strict";
import test from "node:test";
import { getTransactionHistory } from "./transaction-history.js";

const userId = "123456789012345678";

function fakeDb({ total, rows }) {
  const calls = [];
  return {
    calls,
    async execute(query) {
      calls.push(query);
      if (query.sql.startsWith("SELECT COUNT(*)")) {
        return { rows: [{ total }] };
      }
      return { rows };
    },
  };
}

test("empty history returns visible text and disabled pagination", async () => {
  const db = fakeDb({ total: 0, rows: [] });
  const payload = await getTransactionHistory(db, userId, 0);
  const buttons = payload.components[0].toJSON().components;

  assert.ok(payload.content.trim().length > 0);
  assert.match(payload.content, /no transaction history yet/i);
  assert.equal(payload.flags, 64);
  assert.deepEqual(buttons.map((button) => button.disabled), [true, true]);
  assert.deepEqual(db.calls[0].args, [userId, userId]);
});

test("history entries include amount, status, and Discord timestamp", async () => {
  const db = fakeDb({
    total: 1,
    rows: [{
      id: 42,
      type: "deposit",
      from_id: null,
      to_id: userId,
      amount: 1250,
      status: "completed",
      note: "Admin balance addition",
      created_at: "2026-10-18 10:30:00",
    }],
  });
  const payload = await getTransactionHistory(db, userId, 0);

  assert.ok(payload.content.trim().length > 0);
  assert.match(payload.content, /#42 Added \+1,250/);
  assert.match(payload.content, /<t:\d+:f>/);
  assert.match(payload.content, /completed/);
  assert.deepEqual(db.calls[1].args, [userId, userId, 5, 0]);
});

test("out-of-range page is clamped to the last page with content", async () => {
  const db = fakeDb({
    total: 6,
    rows: [{
      id: 1,
      type: "transfer",
      from_id: userId,
      to_id: "987654321098765432",
      amount: 25,
      status: "completed",
      note: null,
      created_at: "2026-10-18 10:30:00",
    }],
  });
  const payload = await getTransactionHistory(db, userId, 100);
  const buttons = payload.components[0].toJSON().components;

  assert.ok(payload.content.trim().length > 0);
  assert.match(payload.content, /Page 2 of 2/);
  assert.match(payload.content, /Sent -25/);
  assert.equal(db.calls[1].args[3], 5);
  assert.deepEqual(buttons.map((button) => button.disabled), [false, true]);
});
