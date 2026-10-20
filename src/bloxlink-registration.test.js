import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { schemaStatements } from "./bank-ops.js";
import {
  createRegistrationEventHandler,
  getBloxlinkVerifiedIdentity,
  registerVerifiedIdentity,
  validateRegistrationConfig,
  validateRoleAssignmentAccess,
} from "./bloxlink-registration.js";

const clients = [];
async function createDb() {
  const db = createClient({ url: "file::memory:" });
  clients.push(db);
  await db.batch(schemaStatements, "write");
  return db;
}
test.after(async () => {
  await Promise.all(clients.map(async (db) => { try { await db.close(); } catch {} }));
});
const guildId = "123456789012345678";
const verifiedRoleId = "234567890123456789";
const registeredRoleId = "345678901234567890";
const apiKey = "test-key";
const discordId = "456789012345678901";
const identity = { robloxId: "987654321", robloxUsername: "CanonicalUser" };

function member(id, roleIds = [verifiedRoleId], { addError } = {}) {
  const memberRoleIds = new Set(roleIds);
  const state = { sent: [], added: [], removed: [] };
  return {
    id,
    guild: { id: guildId },
    roles: {
      cache: { has: (roleId) => memberRoleIds.has(roleId) },
      async add(roleId) {
        state.added.push(roleId);
        if (addError) throw addError;
        memberRoleIds.add(roleId);
      },
      async remove(roleId) { state.removed.push(roleId); memberRoleIds.delete(roleId); },
    },
    async send(message) { state.sent.push(message); },
    state,
  };
}

function handler(db, options = {}) {
  return createRegistrationEventHandler({
    db, guildId, verifiedRoleId, registeredRoleId, apiKey,
    logger: { error() {}, warn() {} },
    resolveIdentity: async () => identity,
    ...options,
  });
}

test("Bloxlink guild lookup supplies trusted ID; Roblox profile supplies canonical username", async () => {
  const calls = [];
  const result = await getBloxlinkVerifiedIdentity(discordId, {
    guildId,
    apiKey,
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("discord-to-roblox")) return { robloxID: identity.robloxId };
      if (url.includes("roblox-to-discord")) return { discordIDs: [discordId] };
      return { id: Number(identity.robloxId), name: identity.robloxUsername };
    },
  });
  assert.deepEqual(result, identity);
  assert.match(calls[0].url, new RegExp(`/guilds/${guildId}/discord-to-roblox/${discordId}$`));
  assert.equal(calls[0].options.headers.authorization, apiKey);
  assert.match(calls[1].url, new RegExp(`/guilds/${guildId}/roblox-to-discord/${identity.robloxId}$`));
  assert.match(calls[2].url, new RegExp(`/v1/users/${identity.robloxId}$`));
});

test("required Bloxlink role IDs and API key are validated", () => {
  assert.equal(validateRegistrationConfig({ GUILD_ID: guildId, BLOXLINK_VERIFIED_ROLE_ID: verifiedRoleId, REGISTERED_ROLE_ID: registeredRoleId, BLOXLINK_API_KEY: apiKey }).ok, true);
  assert.equal(validateRegistrationConfig({ GUILD_ID: guildId }).ok, false);
  assert.equal(validateRegistrationConfig({ GUILD_ID: guildId, BLOXLINK_VERIFIED_ROLE_ID: verifiedRoleId, REGISTERED_ROLE_ID: verifiedRoleId, BLOXLINK_API_KEY: apiKey }).ok, false);
});

test("role permissions and hierarchy are required before registration can run", () => {
  assert.equal(validateRoleAssignmentAccess({
    hasManageRoles: true,
    botHighestPosition: 10,
    verifiedRole: { position: 4, managed: false },
    registeredRole: { position: 5, managed: false },
  }).ok, true);
  assert.equal(validateRoleAssignmentAccess({
    hasManageRoles: false,
    botHighestPosition: 4,
    verifiedRole: { position: 4, managed: false },
    registeredRole: null,
  }).ok, false);
});

test("missing Bloxlink configuration disables registration without processing role events", async () => {
  const db = await createDb();
  const user = member(discordId);
  let calls = 0;
  const events = handler(db, { enabled: false, resolveIdentity: async () => { calls += 1; return identity; } });
  await events({ ...user, roles: { cache: { has: () => false } } }, user);
  assert.equal(calls, 0);
  assert.deepEqual(user.state.removed, []);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM accounts")).rows[0].n, 0);
});

test("startup schema cleanup removes only obsolete OAuth state tables", async () => {
  const db = createClient({ url: "file::memory:" });
  await db.execute("CREATE TABLE oauth_sessions (state TEXT)");
  await db.execute("CREATE TABLE pending_links (id TEXT)");
  await db.execute("CREATE TABLE preserved_data (value TEXT)");
  await db.batch(schemaStatements, "write");
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((row) => row.name);
  assert.equal(tables.includes("oauth_sessions"), false);
  assert.equal(tables.includes("pending_links"), false);
  assert.equal(tables.includes("preserved_data"), true);
  await db.close();
});

test("successful trusted registration assigns Registered and only then removes Bloxlink role without ledger changes", async () => {
  const db = await createDb();
  const user = member(discordId);
  const events = handler(db);
  await events({ ...user, roles: { cache: { has: () => false } } }, user);
  const account = await db.execute({ sql: "SELECT * FROM accounts WHERE discord_id = ?", args: [discordId] });
  assert.equal(account.rows.length, 1);
  assert.equal(account.rows[0].roblox_id, identity.robloxId);
  assert.equal(account.rows[0].roblox_username, identity.robloxUsername);
  assert.equal(Number(account.rows[0].balance), 0);
  assert.deepEqual(user.state.added, [registeredRoleId]);
  assert.deepEqual(user.state.removed, [verifiedRoleId]);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM transactions")).rows[0].n, 0);
});

test("existing Roblox link does not create a second bank identity and is acknowledged", async () => {
  const db = await createDb();
  await db.execute({ sql: "INSERT INTO accounts (discord_id, roblox_id, roblox_username, balance) VALUES (?, ?, ?, ?)", args: [discordId, identity.robloxId, identity.robloxUsername, 420] });
  const user = member("567890123456789012");
  await handler(db)({ ...user, roles: { cache: { has: () => false } } }, user);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM accounts")).rows[0].n, 1);
  assert.match(user.state.sent[0], /already linked to PTB/);
  assert.deepEqual(user.state.removed, [verifiedRoleId]);
  assert.deepEqual(user.state.added, []);
  assert.equal((await db.execute({ sql: "SELECT balance FROM accounts WHERE discord_id = ?", args: [discordId] })).rows[0].balance, 420);
});

test("existing Discord link is never overwritten", async () => {
  const db = await createDb();
  await db.execute({ sql: "INSERT INTO accounts (discord_id, roblox_id, roblox_username, balance) VALUES (?, ?, ?, ?)", args: [discordId, "111111111", "OldIdentity", 730] });
  const result = await registerVerifiedIdentity(db, discordId, identity);
  assert.equal(result.status, "discord_conflict");
  const account = (await db.execute({ sql: "SELECT roblox_id, balance FROM accounts WHERE discord_id = ?", args: [discordId] })).rows[0];
  assert.equal(account.roblox_id, "111111111");
  assert.equal(account.balance, 730);
});

test("missing nickname is irrelevant to trusted mapping; failed/malformed Bloxlink lookup does not register", async () => {
  await assert.rejects(getBloxlinkVerifiedIdentity(discordId, { guildId, apiKey, fetchJson: async () => ({}) }), /verified Roblox ID/);
  await assert.rejects(getBloxlinkVerifiedIdentity(discordId, { guildId, apiKey, fetchJson: async (url) => url.includes("api.blox.link") ? { robloxID: identity.robloxId, robloxIDs: [identity.robloxId, "1234567890"] } : { id: Number(identity.robloxId), name: identity.robloxUsername } }), /ambiguous Roblox identity/);
  await assert.rejects(getBloxlinkVerifiedIdentity(discordId, { guildId, apiKey, fetchJson: async (url) => url.includes("discord-to-roblox") ? { robloxID: identity.robloxId } : url.includes("roblox-to-discord") ? { discordIDs: ["567890123456789012"] } : { id: Number(identity.robloxId), name: identity.robloxUsername } }), /reverse lookup did not confirm/);
  await assert.rejects(getBloxlinkVerifiedIdentity(discordId, { guildId, apiKey, fetchJson: async (url) => url.includes("discord-to-roblox") ? { robloxID: identity.robloxId } : url.includes("roblox-to-discord") ? { discordIDs: [discordId] } : { id: 1, name: "wrong" } }), /profile response was invalid/);
  const db = await createDb();
  const user = member(discordId);
  await handler(db, { resolveIdentity: async () => { throw new Error("lookup failed"); } })({ ...user, roles: { cache: { has: () => false } } }, user);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM accounts")).rows[0].n, 0);
  assert.deepEqual(user.state.removed, []);
});

test("Bloxlink missing-member and rate-limit API errors fail closed", async () => {
  for (const apiError of [new Error("HTTP 404"), new Error("HTTP 429")]) {
    const db = await createDb();
    const user = member(discordId);
    const events = handler(db, { resolveIdentity: async () => { throw apiError; } });
    await events({ ...user, roles: { cache: { has: () => false } } }, user);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM accounts")).rows[0].n, 0);
    assert.deepEqual(user.state.removed, []);
  }
});

test("duplicate concurrent role events coalesce and leave preexisting accounts and balances unchanged", async () => {
  const db = await createDb();
  const user = member(discordId);
  let lookups = 0;
  const events = handler(db, { resolveIdentity: async () => { lookups += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return identity; } });
  const oldMember = { ...user, roles: { cache: { has: () => false } } };
  await Promise.all([events(oldMember, user), events(oldMember, user), events(oldMember, user)]);
  assert.equal(lookups, 1);
  assert.equal(user.state.sent.filter((message) => message.includes("now registered")).length, 1);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM accounts")).rows[0].n, 1);

  await db.execute({ sql: "UPDATE accounts SET balance = 900 WHERE discord_id = ?", args: [discordId] });
  const before = await db.execute("SELECT balance FROM accounts WHERE discord_id = ?", [discordId]);
  const again = await registerVerifiedIdentity(db, discordId, identity);
  const after = await db.execute("SELECT balance FROM accounts WHERE discord_id = ?", [discordId]);
  assert.equal(again.status, "existing_same");
  assert.equal(after.rows[0].balance, before.rows[0].balance);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM transactions")).rows[0].n, 0);
});

test("database failure and Registered role assignment failure retain Bloxlink role", async () => {
  const db = await createDb();
  const brokenDb = { transaction: async () => { throw new Error("database unavailable"); } };
  const dbFailUser = member(discordId);
  await handler(brokenDb)({ ...dbFailUser, roles: { cache: { has: () => false } } }, dbFailUser);
  assert.deepEqual(dbFailUser.state.removed, []);

  const roleFailUser = member(discordId, [verifiedRoleId], { addError: new Error("missing role permission") });
  await handler(db)({ ...roleFailUser, roles: { cache: { has: () => false } } }, roleFailUser);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM accounts")).rows[0].n, 1);
  assert.deepEqual(roleFailUser.state.removed, []);
  assert.deepEqual(roleFailUser.state.added, [registeredRoleId]);
});

