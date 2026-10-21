const BLOXLINK_API_BASE = "https://api.blox.link/v4/public";
export const BLOXLINK_VERIFY_URL = "https://blox.link/verify";

export function validateRegistrationConfig(env = process.env) {
  const required = ["GUILD_ID", "BLOXLINK_VERIFIED_ROLE_ID", "REGISTERED_ROLE_ID", "BLOXLINK_API_KEY"];
  const missing = required.filter((name) => !env[name]?.trim());
  for (const name of ["GUILD_ID", "BLOXLINK_VERIFIED_ROLE_ID", "REGISTERED_ROLE_ID"]) {
    if (env[name] && !/^\d{17,20}$/.test(env[name].trim())) missing.push(`${name} (invalid Discord ID)`);
  }
  if (env.BLOXLINK_VERIFIED_ROLE_ID && env.BLOXLINK_VERIFIED_ROLE_ID === env.REGISTERED_ROLE_ID) {
    missing.push("BLOXLINK_VERIFIED_ROLE_ID and REGISTERED_ROLE_ID must be different");
  }
  return { ok: missing.length === 0, missing: [...new Set(missing)] };
}

export function validateRoleAssignmentAccess({ hasManageRoles, botHighestPosition, verifiedRole, registeredRole }) {
  const problems = [];
  if (!hasManageRoles) problems.push("PTB bot member lacks Manage Roles permission");
  for (const [label, role] of [["Bloxlink verification", verifiedRole], ["PTB Registered", registeredRole]]) {
    if (!role) {
      problems.push(`${label} role ID was not found in the guild`);
      continue;
    }
    if (role.managed) problems.push(`${label} role is managed and cannot be assigned by PTB`);
    if (role.position >= botHighestPosition) problems.push(`${label} role is not below PTB's highest role`);
  }
  return { ok: problems.length === 0, problems };
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", ...options.headers },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Resolve identity through Bloxlink's supported, guild-scoped API. Nicknames are never treated as proof. */
export async function getBloxlinkVerifiedIdentity(discordId, { guildId, apiKey, fetchJson = getJson }) {
  if (!/^\d{17,20}$/.test(String(discordId)) || !/^\d{17,20}$/.test(String(guildId)) || !apiKey) {
    throw new Error("Bloxlink identity configuration is invalid");
  }
  const url = `${BLOXLINK_API_BASE}/guilds/${guildId}/discord-to-roblox/${discordId}`;
  const mapping = await fetchJson(url, { headers: { authorization: apiKey } });
  const robloxId = String(mapping?.robloxID ?? "");
  if (Array.isArray(mapping?.robloxIDs) && (mapping.robloxIDs.length !== 1 || String(mapping.robloxIDs[0]) !== robloxId)) {
    throw new Error("Bloxlink returned an ambiguous Roblox identity");
  }
  if (!/^\d+$/.test(robloxId)) throw new Error("Bloxlink did not return a verified Roblox ID");

  const reverse = await fetchJson(`${BLOXLINK_API_BASE}/guilds/${guildId}/roblox-to-discord/${robloxId}`, {
    headers: { authorization: apiKey },
  });
  if (!Array.isArray(reverse?.discordIDs) || !reverse.discordIDs.some((id) => String(id) === String(discordId))) {
    throw new Error("Bloxlink reverse lookup did not confirm this Discord link");
  }

  const profile = await fetchJson(`https://users.roblox.com/v1/users/${robloxId}`);
  if (String(profile?.id) !== robloxId || typeof profile?.name !== "string" || !profile.name.trim()) {
    throw new Error("Roblox profile response was invalid");
  }
  return { robloxId, robloxUsername: profile.name.trim() };
}

/** Atomic, immutable, idempotent account linking. Does not touch balances or ledger rows. */
export async function registerVerifiedIdentity(db, discordId, identity) {
  const transaction = await db.transaction("write");
  try {
    const byDiscord = await transaction.execute({
      sql: "SELECT discord_id, roblox_id, roblox_username FROM accounts WHERE discord_id = ? LIMIT 1",
      args: [discordId],
    });
    if (byDiscord.rows.length) {
      const account = byDiscord.rows[0];
      await transaction.commit();
      return account.roblox_id === identity.robloxId
        ? { status: "existing_same", account }
        : { status: "discord_conflict", account };
    }

    const byRoblox = await transaction.execute({
      sql: "SELECT discord_id, roblox_id, roblox_username FROM accounts WHERE roblox_id = ? LIMIT 1",
      args: [identity.robloxId],
    });
    if (byRoblox.rows.length) {
      await transaction.commit();
      return { status: "roblox_conflict", account: byRoblox.rows[0] };
    }

    await transaction.execute({
      sql: `INSERT INTO accounts (discord_id, roblox_id, roblox_username, balance, frozen)
        VALUES (?, ?, ?, 0, 0)`,
      args: [discordId, identity.robloxId, identity.robloxUsername],
    });
    await transaction.commit();
    return { status: "registered", account: { discord_id: discordId, ...identity, balance: 0 } };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    // Unique constraints arbitrate concurrent events across processes and DB clients.
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return { status: "conflict" };
    }
    throw error;
  } finally {
    transaction.close();
  }
}

/** Coalesces repeated role events in this process. DB uniqueness remains the cross-process guard. */
export function createRegistrationEventHandler({ db, guildId, verifiedRoleId, registeredRoleId, apiKey, enabled = true, logger = console, resolveIdentity = getBloxlinkVerifiedIdentity }) {
  const inFlight = new Map();
  async function processVerifiedMember(newMember, { notify = true } = {}) {
    if (!(typeof enabled === "function" ? enabled() : enabled)) return;
    if (newMember.guild.id !== guildId) return;
    const userId = newMember.id;
    if (inFlight.has(userId)) return inFlight.get(userId);

    const job = (async () => {
      try {
        const identity = await resolveIdentity(userId, { guildId, apiKey });
        const result = await registerVerifiedIdentity(db, userId, identity);

        if (result.status === "discord_conflict") {
          if (notify) await newMember.send("Your Discord account already has a PTB account linked to a different Roblox identity. PTB has not changed that link. Contact a PTB administrator if you need help.").catch(() => {});
          return result;
        }
        if (result.status === "conflict") {
          if (notify) await newMember.send("PTB could not safely confirm your account link because another registration completed at the same time. Please contact a PTB administrator.").catch(() => {});
          return result;
        }

        if (result.status === "roblox_conflict") {
          if (notify) await newMember.send(`Your Roblox account **${identity.robloxUsername}** is already linked to PTB. No duplicate account was created. Continue using PTB banking from the Discord account that is already linked.`).catch((error) => logger.warn("PTB could not send existing-link notice", { discordId: userId, reason: error?.message ?? "unknown error" }));
        } else if (result.status === "registered") {
          if (notify) await newMember.send(`Your Roblox account **${identity.robloxUsername}** is now registered with PTB.`).catch((error) => logger.warn("PTB could not send registration notice", { discordId: userId, reason: error?.message ?? "unknown error" }));
        }

        if (result.status !== "roblox_conflict" && !newMember.roles.cache.has(registeredRoleId)) {
          await newMember.roles.add(registeredRoleId, "PTB account registered through Bloxlink verification");
        }
        if (newMember.roles.cache.has(verifiedRoleId)) {
          await newMember.roles.remove(verifiedRoleId, "PTB processed Bloxlink verification");
        }
        return result;
      } catch (error) {
        logger.error("PTB Bloxlink registration failed", { discordId: userId, reason: error?.message ?? "unknown error" });
        if (notify) {
          try {
            await newMember.send("PTB could not finish registration right now. Your verification role is unchanged; please try again later or contact a PTB administrator.");
          } catch (dmError) {
            logger.warn("PTB could not send registration notice", { discordId: userId, reason: dmError?.message ?? "unknown error" });
          }
        }
        return { status: "error", error };
      }
    })();
    inFlight.set(userId, job);
    try { return await job; } finally { inFlight.delete(userId); }
  }

  async function onGuildMemberUpdate(oldMember, newMember) {
    if (oldMember.roles.cache.has(verifiedRoleId) || !newMember.roles.cache.has(verifiedRoleId)) return;
    return processVerifiedMember(newMember);
  }

  onGuildMemberUpdate.processVerifiedMember = processVerifiedMember;
  return onGuildMemberUpdate;
}
