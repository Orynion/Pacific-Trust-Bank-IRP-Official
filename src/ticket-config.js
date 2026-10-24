import { ChannelType, PermissionFlagsBits } from "discord.js";

/** Parse a comma-separated list of Discord snowflakes. */
export function parseIdList(value) {
  return [...new Set(String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9_-]{1,32}$/.test(item)))];
}

/** Read ticket configuration from the environment at call time. */
export function ticketConfig(env = process.env) {
  const categoryId = String(env.TICKET_CATEGORY_ID ?? "").trim();
  const logChannelId = String(env.TICKET_LOG_CHANNEL_ID ?? "").trim();
  return {
    categoryId: /^[A-Za-z0-9_-]{1,32}$/.test(categoryId) ? categoryId : null,
    staffRoleIds: parseIdList(env.TICKET_STAFF_ROLE_IDS),
    logChannelId: /^[A-Za-z0-9_-]{1,32}$/.test(logChannelId) ? logChannelId : null,
  };
}

function memberHasRole(interaction, roleIds) {
  if (!roleIds.length) return false;
  const cache = interaction.member?.roles?.cache;
  if (!cache) return false;
  return roleIds.some((id) => (typeof cache.has === "function" ? cache.has(id) : false));
}

/**
 * Ticket staff are server administrators plus members holding a configured
 * ticket staff role. This is deliberately separate from "can see the ticket":
 * the requester and added helpers can see the channel but cannot close it.
 */
export function isTicketStaff(interaction, roleIds = ticketConfig().staffRoleIds) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  return memberHasRole(interaction, roleIds);
}

/** Resolve configured staff roles, ignoring deleted/everyone/@managed roles. */
export async function resolveStaffRoles(guild, roleIds = ticketConfig().staffRoleIds) {
  if (!guild || !roleIds.length || !guild.roles) return [];
  try {
    if (guild.roles.cache?.size === 0 && typeof guild.roles.fetch === "function") {
      await guild.roles.fetch();
    }
  } catch (error) {
    console.warn("[PTB Ticket] Could not refresh server roles while resolving ticket staff:", error?.message ?? error);
  }
  const everyoneId = guild.roles.everyone?.id;
  return roleIds
    .map((id) => guild.roles.cache?.get?.(id))
    .filter((role) => role && role.id !== everyoneId && !role.managed);
}

/** Resolve the configured ticket category; invalid/missing configuration falls back to no parent. */
export async function resolveTicketCategory(guild, categoryId = ticketConfig().categoryId) {
  if (!guild || !categoryId || typeof guild.channels?.fetch !== "function") return null;
  try {
    const channel = await guild.channels.fetch(categoryId);
    if (channel?.type === ChannelType.GuildCategory) return channel;
    console.warn(`[PTB Ticket] TICKET_CATEGORY_ID ${categoryId} is not a server category; tickets will be created without a parent.`);
  } catch (error) {
    console.warn(`[PTB Ticket] Could not load TICKET_CATEGORY_ID ${categoryId}; tickets will be created without a parent:`, error?.message ?? error);
  }
  return null;
}

/** Startup diagnostics for category, staff role, and log channel configuration. */
export async function validateTicketConfiguration(guild, env = process.env) {
  const config = ticketConfig(env);
  const problems = [];
  const category = await resolveTicketCategory(guild, config.categoryId);
  if (config.categoryId && !category) problems.push(`TICKET_CATEGORY_ID (${config.categoryId}) is missing or not a category`);
  const staffRoles = await resolveStaffRoles(guild, config.staffRoleIds);
  if (config.staffRoleIds.length && staffRoles.length !== config.staffRoleIds.length) {
    problems.push("one or more TICKET_STAFF_ROLE_IDS are missing, @everyone, or bot-managed");
  }
  let logChannel = null;
  if (config.logChannelId) {
    try {
      logChannel = await guild?.client?.channels?.fetch?.(config.logChannelId);
      if (!logChannel || typeof logChannel.send !== "function") problems.push(`TICKET_LOG_CHANNEL_ID (${config.logChannelId}) is not a usable text channel`);
    } catch (error) {
      problems.push(`TICKET_LOG_CHANNEL_ID (${config.logChannelId}) could not be loaded: ${error?.message ?? error}`);
    }
  }
  return { config, category, staffRoles, logChannel, problems };
}
