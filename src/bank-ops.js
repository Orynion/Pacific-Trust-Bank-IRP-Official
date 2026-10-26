import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  attachTicketChannel,
  createPendingTicket,
  rejectTicketWithNote,
  ticketCode as formatTicketCode,
  ticketPanelPayload,
  ticketTopic,
  ticketTopicPrefix,
} from "./ticket-ops.js";
import { resolveStaffRoles, resolveTicketCategory, ticketConfig } from "./ticket-config.js";
import { logTicketEvent } from "./ticket-log.js";

export const MAX_BALANCE = 2_147_483_647;

export const ephemeralReply = { flags: MessageFlags.Ephemeral };

/** Single source of truth for the "you are not registered" guidance, so every command
 *  prints exactly one identical /register instruction instead of drifting variants. */
export const REGISTER_FIRST_MESSAGE =
  "You do not have a registered PTB account yet. Run /register to link your Roblox account first.";

export const schemaStatements = [
  // Retire abandoned, short-lived state from the removed Roblox OAuth flow.
  `DROP TABLE IF EXISTS oauth_sessions`,
  `DROP TABLE IF EXISTS pending_links`,
  `CREATE TABLE IF NOT EXISTS accounts (
    discord_id TEXT PRIMARY KEY,
    roblox_id TEXT,
    roblox_username TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1)),
    frozen_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('deposit', 'withdraw', 'transfer', 'reversal')),
    from_id TEXT,
    to_id TEXT,
    amount INTEGER NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'denied')),
    staff_id TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS processed_interactions (
    interaction_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_roblox_id
    ON accounts (roblox_id) WHERE roblox_id IS NOT NULL`,
];

export function validateMoneyAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, message: "Amount must be a positive whole number." };
  }
  if (amount > MAX_BALANCE) {
    return { ok: false, message: `Amount exceeds the supported limit of ${MAX_BALANCE.toLocaleString()}.` };
  }
  return { ok: true };
}

export function isAccountFrozen(account, now = new Date()) {
  if (!account || Number(account.frozen) !== 1) return false;
  if (!account.frozen_until) return true;
  const until = new Date(account.frozen_until);
  if (Number.isNaN(until.getTime())) return true;
  return now < until;
}

export async function ensureFrozenUntilColumn(db) {
  try {
    await db.execute("ALTER TABLE accounts ADD COLUMN frozen_until TEXT");
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/duplicate column|already exists/i.test(message)) {
      console.warn("PTB frozen_until column migration note:", message);
    }
  }
}

export async function handleMoneyRequest(db, interaction, type) {
  const amount = interaction.options.getInteger("amount", true);
  await interaction.deferReply(ephemeralReply);

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.editReply("Deposit and withdrawal tickets can only be opened in a server.");
    return;
  }

  const amountValidation = validateMoneyAmount(amount);
  if (!amountValidation.ok) {
    await interaction.editReply(amountValidation.message);
    return;
  }

  let accountResult = await db.execute({
    sql: "SELECT balance, frozen, frozen_until FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [interaction.user.id],
  });
  if (accountResult.rows.length === 0) {
    if (!process.env.BLOXLINK_API_KEY) {
      await db.execute({
        sql: "INSERT OR IGNORE INTO accounts (discord_id, roblox_username, balance, frozen) VALUES (?, ?, 0, 0)",
        args: [interaction.user.id, interaction.user.username],
      });
      accountResult = await db.execute({
        sql: "SELECT balance, frozen, frozen_until FROM accounts WHERE discord_id = ? LIMIT 1",
        args: [interaction.user.id],
      });
    } else {
      await interaction.editReply(REGISTER_FIRST_MESSAGE);
      return;
    }
  }

  const account = accountResult.rows[0];
  const balance = Number(account.balance);
  if (isAccountFrozen(account)) {
    await interaction.editReply("Your PTB account is frozen, so you cannot open a deposit or withdrawal request right now.");
    return;
  }
  if (type === "withdraw" && amount > balance) {
    await interaction.editReply(`You requested ${amount.toLocaleString()}, but your current balance is ${balance.toLocaleString()}.`);
    return;
  }

  // Server-side duplicate-request guard:
  // If an existing pending ticket exists, check if its channel is still alive.
  // If the channel was deleted, auto-close the orphaned ticket row so the user isn't permanently locked out.
  const existingRequestResult = await db.execute({
    sql: "SELECT id, channel_id FROM tickets WHERE requester_id = ? AND kind = ? AND status = 'pending' LIMIT 1",
    args: [interaction.user.id, type],
  });
  if (existingRequestResult.rows.length > 0) {
    const existingRow = existingRequestResult.rows[0];
    let channelIsAlive = false;
    if (existingRow.channel_id && interaction.guild) {
      try {
        const found = await interaction.guild.channels.fetch(existingRow.channel_id).catch((err) => {
          if (err?.code === 10003 || err?.status === 404 || /unknown channel/i.test(String(err?.message))) {
            return null;
          }
          return { id: existingRow.channel_id };
        });
        if (found) {
          channelIsAlive = true;
          await interaction.editReply(`You already have an open ${type} ticket. Close it before opening another.`);
          return;
        }
      } catch {
        channelIsAlive = true;
        await interaction.editReply(`You already have an open ${type} ticket. Close it before opening another.`);
        return;
      }
    } else if (existingRow.channel_id) {
      channelIsAlive = true;
      await interaction.editReply(`You already have an open ${type} ticket. Close it before opening another.`);
      return;
    }
    if (!channelIsAlive) {
      await db.execute({
        sql: "UPDATE tickets SET status = 'rejected', note = 'Auto-closed orphaned ticket (channel missing)' WHERE id = ?",
        args: [existingRow.id],
      });
    }
  }

  const ticketPrefix = ticketTopicPrefix(type, interaction.user.id);
  try {
    const channels = await interaction.guild.channels.fetch().catch(() => null);
    const existingTicket = channels?.find?.((channel) =>
      channel?.type === ChannelType.GuildText && channel.topic?.startsWith(ticketPrefix));
    if (existingTicket) {
      await interaction.editReply(`You already have an open ${type} ticket: ${existingTicket}. Close it before opening another.`);
      return;
    }
  } catch (channelCheckError) {
    console.warn("Could not check existing ticket channels by topic:", channelCheckError?.message ?? channelCheckError);
  }

  // Every deposit/withdrawal request gets a unique, persistent transaction ID
  // before the Discord channel exists, so the ticket can always be tracked.
  let ticketId;
  try {
    ticketId = await createPendingTicket(db, { kind: type, requesterId: interaction.user.id, amount });
  } catch (error) {
    if (/idx_tickets_open_per_user|UNIQUE constraint failed/i.test(String(error?.message ?? ""))) {
      await interaction.editReply(`You already have an open ${type} ticket. Close it before opening another.`);
      return;
    }
    console.error("Could not create the PTB ticket record:", error);
    await interaction.editReply("I could not open the ticket right now because the database rejected it. Please try again shortly.");
    return;
  }
  const ticketCode = formatTicketCode({ kind: type, id: ticketId });
  const config = ticketConfig();
  const [category, staffRoles] = await Promise.all([
    resolveTicketCategory(interaction.guild, config.categoryId),
    resolveStaffRoles(interaction.guild, config.staffRoleIds),
  ]);
  if (!staffRoles.length) {
    console.warn("[PTB Ticket] No usable TICKET_STAFF_ROLE_IDS configured; only administrators will have staff access to new tickets.");
  }
  const staffOverwrites = staffRoles.map((role) => ({
    id: role.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ManageMessages,
    ],
  }));

  const safeUsername = interaction.user.username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || interaction.user.id;
  const channelName = `${type}-${ticketId}-${safeUsername}`.slice(0, 100);

  const buildChannelCreateOptions = (parentCategory) => ({
    name: channelName,
    type: ChannelType.GuildText,
    topic: ticketTopic(type, interaction.user.id, amount, ticketId),
    ...(parentCategory ? { parent: parentCategory.id } : {}),
    permissionOverwrites: [
      {
        id: interaction.guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: interaction.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
        ],
      },
      ...staffOverwrites,
    ],
  });

  let channel;
  try {
    channel = await interaction.guild.channels.create(buildChannelCreateOptions(category));
  } catch (primaryError) {
    console.warn("[PTB Ticket] Channel creation with category failed, retrying without category:", primaryError?.message ?? primaryError);
    if (category) {
      try {
        channel = await interaction.guild.channels.create(buildChannelCreateOptions(null));
      } catch (fallbackError) {
        console.warn("[PTB Ticket] Fallback channel creation without category failed:", fallbackError?.message ?? fallbackError);
      }
    }
  }

  if (!channel) {
    await rejectTicketWithNote(db, ticketId, "Ticket channel could not be created").catch(() => {});
    void logTicketEvent(interaction.client, {
      action: "TICKET_ACTION_DENIED",
      ticket: { id: ticketId, kind: type, requester_id: interaction.user.id, amount },
      actorId: interaction.user.id,
      details: "Ticket channel creation failed (bot missing Manage Channels permission or category limit reached)",
    }, { config });
    await interaction.editReply("I could not open your ticket because the bot lacks permissions to create channels in this server (requires 'Manage Channels' permission), or the category is full. Please contact a server administrator.");
    return;
  }

  try {
    await attachTicketChannel(db, ticketId, channel.id);
  } catch (error) {
    console.error("Could not attach the PTB ticket channel:", error);
    await rejectTicketWithNote(db, ticketId, "Ticket channel could not be linked to the ticket record").catch(() => {});
    await channel.delete("PTB ticket could not be linked to its record").catch(() => {});
    await interaction.editReply("I could not open the ticket right now because the database rejected it. Please try again shortly.");
    return;
  }

  try {
    await channel.send(ticketPanelPayload({
      ticket: { id: ticketId, kind: type },
      type,
      amount,
      balance,
      requester: interaction.user,
      channelId: channel.id,
    }));
    void logTicketEvent(interaction.client, {
      action: "TICKET_OPENED",
      ticket: { id: ticketId, kind: type, requester_id: interaction.user.id, amount, channel_id: channel.id },
      actorId: interaction.user.id,
      details: `Channel <#${channel.id}>${channel.parentId ? ` in category <#${channel.parentId}>` : ""}.`,
    }, { config });
  } catch (error) {
    console.error("Could not send ticket panel message:", error);
    await rejectTicketWithNote(db, ticketId, "Ticket message could not be posted").catch(() => {});
    await channel.delete("Could not initialize the PTB money request ticket").catch(() => {});
    await interaction.editReply("The ticket channel was created but the bot was unable to post the ticket panel. Please ensure the bot has 'Send Messages' and 'Embed Links' permissions.");
    return;
  }

  await interaction.editReply(`Your private ${type} ticket is open: ${channel} (ticket ${ticketCode})`);
}

export async function handleBalance(db, interaction) {
  const accountResult = await db.execute({
    sql: "SELECT balance FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [interaction.user.id],
  });

  if (accountResult.rows.length === 0) {
    await interaction.reply({
      content: REGISTER_FIRST_MESSAGE,
      ...ephemeralReply,
    });
    return;
  }

  const balance = Number(accountResult.rows[0].balance);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x0B3D2E)
      .setTitle("Pacific Trust Bank | Account Balance")
      .setDescription(`**${balance.toLocaleString()}**`)
      .setFooter({ text: "Account balance" })],
    ...ephemeralReply,
  });
}

export async function handleTransfer(db, interaction) {
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const confirm = interaction.options.getBoolean("confirm", true);

  if (!confirm) {
    await interaction.reply({
      content: "Transfer cancelled. You must set confirm to True to complete the transfer.",
      ...ephemeralReply,
    });
    return;
  }

  if (target.id === interaction.user.id) {
    await interaction.reply({
      content: "You cannot transfer money to yourself.",
      ...ephemeralReply,
    });
    return;
  }

  if (target.bot) {
    await interaction.reply({
      content: "You cannot transfer money to a bot.",
      ...ephemeralReply,
    });
    return;
  }

  const amountValidation = validateMoneyAmount(amount);
  if (!amountValidation.ok) {
    await interaction.reply({
      content: amountValidation.message,
      ...ephemeralReply,
    });
    return;
  }

  const transaction = await db.transaction("write");
  try {
    // Duplicate-interaction guard: this row is inserted inside the same
    // transaction as the balance changes, so a replayed confirmation cannot
    // process the same request twice (and a failed transaction rolls the
    // guard back, so a legitimate retry still works).
    const replayResult = await transaction.execute({
      sql: "SELECT 1 FROM processed_interactions WHERE interaction_id = ? LIMIT 1",
      args: [interaction.id],
    });
    if (replayResult.rows.length > 0) {
      await transaction.rollback();
      await interaction.reply({
        content: "This request was already processed.",
        ...ephemeralReply,
      });
      return;
    }
    await transaction.execute({
      sql: "DELETE FROM processed_interactions WHERE created_at <= datetime('now', '-7 days')",
      args: [],
    });
    await transaction.execute({
      sql: "INSERT INTO processed_interactions (interaction_id) VALUES (?)",
      args: [interaction.id],
    });

    const senderResult = await transaction.execute({
      sql: "SELECT balance, frozen, frozen_until FROM accounts WHERE discord_id = ? LIMIT 1",
      args: [interaction.user.id],
    });
    if (senderResult.rows.length === 0) {
      await transaction.rollback();
      await interaction.reply({
        content: REGISTER_FIRST_MESSAGE,
        ...ephemeralReply,
      });
      return;
    }

    const senderRow = senderResult.rows[0];
    if (isAccountFrozen(senderRow)) {
      await transaction.rollback();
      await interaction.reply({
        content: "Your account is frozen. You cannot transfer money.",
        ...ephemeralReply,
      });
      return;
    }

    const senderBalance = Number(senderRow.balance);
    if (!Number.isSafeInteger(senderBalance) || senderBalance < amount) {
      await transaction.rollback();
      await interaction.reply({
        content: `Insufficient funds. Your current balance is ${senderBalance.toLocaleString()}, but you tried to transfer ${amount.toLocaleString()}.`,
        ...ephemeralReply,
      });
      return;
    }

    const targetResult = await transaction.execute({
      sql: "SELECT balance, frozen, frozen_until FROM accounts WHERE discord_id = ? LIMIT 1",
      args: [target.id],
    });
    if (targetResult.rows.length === 0) {
      await transaction.rollback();
      await interaction.reply({
        content: `${target.username} does not have a registered PTB account.`,
        ...ephemeralReply,
      });
      return;
    }

    const targetRow = targetResult.rows[0];
    if (isAccountFrozen(targetRow)) {
      await transaction.rollback();
      await interaction.reply({
        content: `${target.username}'s account is frozen and cannot receive transfers.`,
        ...ephemeralReply,
      });
      return;
    }

    const targetBalance = Number(targetRow.balance);
    if (!Number.isSafeInteger(targetBalance) || targetBalance + amount > MAX_BALANCE) {
      await transaction.rollback();
      await interaction.reply({
        content: "That transfer would exceed the recipient's supported balance limit.",
        ...ephemeralReply,
      });
      return;
    }

    // The guard in the WHERE clause makes the debit atomic: `balance >= amount`
    // is re-evaluated inside the same statement that decrements, so a
    // concurrent write interleaving between the earlier SELECT and this
    // UPDATE cannot overdraw the account.
    const debitResult = await transaction.execute({
      sql: "UPDATE accounts SET balance = balance - ? WHERE discord_id = ? AND balance >= ?",
      args: [amount, interaction.user.id, amount],
    });
    if (debitResult.rowsAffected !== 1) {
      await transaction.rollback();
      const refreshedSender = await db.execute({
        sql: "SELECT balance FROM accounts WHERE discord_id = ? LIMIT 1",
        args: [interaction.user.id],
      });
      const refreshedBalance = refreshedSender.rows.length > 0 ? Number(refreshedSender.rows[0].balance) : senderBalance;
      await interaction.reply({
        content: `Insufficient funds. Your current balance is ${refreshedBalance.toLocaleString()}, but you tried to transfer ${amount.toLocaleString()}.`,
        ...ephemeralReply,
      });
      return;
    }
    const creditResult = await transaction.execute({
      sql: "UPDATE accounts SET balance = balance + ? WHERE discord_id = ? AND balance <= ?",
      args: [amount, target.id, MAX_BALANCE - amount],
    });
    if (creditResult.rowsAffected !== 1) {
      await transaction.rollback();
      await interaction.reply({
        content: "That transfer would exceed the recipient's supported balance limit.",
        ...ephemeralReply,
      });
      return;
    }
    await transaction.execute({
      sql: `INSERT INTO transactions (type, from_id, to_id, amount, status, staff_id, note)
        VALUES ('transfer', ?, ?, ?, 'completed', NULL, ?)`,
      args: [interaction.user.id, target.id, amount, `Transfer to ${target.username}`],
    });

    const updatedSenderResult = await transaction.execute({
      sql: "SELECT balance FROM accounts WHERE discord_id = ?",
      args: [interaction.user.id],
    });
    const newSenderBalance = Number(updatedSenderResult.rows[0].balance);
    await transaction.commit();

    await interaction.reply({
      content: `Transferred ${amount.toLocaleString()} to ${target.username}. Your new balance: ${newSenderBalance.toLocaleString()}.`,
      ...ephemeralReply,
    });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
}

export async function handleAddBalance(db, interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Only server administrators can use this command.", ...ephemeralReply });
    return;
  }

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);

  const amountValidation = validateMoneyAmount(amount);
  if (!amountValidation.ok) {
    await interaction.reply({
      content: amountValidation.message,
      ...ephemeralReply,
    });
    return;
  }

  const transaction = await db.transaction("write");
  try {
    // Duplicate-interaction guard, same mechanism as transfers.
    const replayResult = await transaction.execute({
      sql: "SELECT 1 FROM processed_interactions WHERE interaction_id = ? LIMIT 1",
      args: [interaction.id],
    });
    if (replayResult.rows.length > 0) {
      await transaction.rollback();
      await interaction.reply({
        content: "This request was already processed.",
        ...ephemeralReply,
      });
      return;
    }
    await transaction.execute({
      sql: "DELETE FROM processed_interactions WHERE created_at <= datetime('now', '-7 days')",
      args: [],
    });
    await transaction.execute({
      sql: "INSERT INTO processed_interactions (interaction_id) VALUES (?)",
      args: [interaction.id],
    });

    const accountResult = await transaction.execute({
      sql: "SELECT balance FROM accounts WHERE discord_id = ? LIMIT 1",
      args: [target.id],
    });
    if (accountResult.rows.length === 0) {
      await transaction.rollback();
      await interaction.reply({
        content: `${target.username} does not have a registered PTB account.`,
        ...ephemeralReply,
      });
      return;
    }

    const currentBalance = Number(accountResult.rows[0].balance);
    if (!Number.isSafeInteger(currentBalance) || currentBalance + amount > MAX_BALANCE) {
      await transaction.rollback();
      await interaction.reply({ content: "That addition would exceed the supported balance limit.", ...ephemeralReply });
      return;
    }

    const creditResult = await transaction.execute({
      sql: "UPDATE accounts SET balance = balance + ? WHERE discord_id = ? AND balance <= ?",
      args: [amount, target.id, MAX_BALANCE - amount],
    });
    if (creditResult.rowsAffected !== 1) {
      await transaction.rollback();
      await interaction.reply({ content: "That addition would exceed the supported balance limit.", ...ephemeralReply });
      return;
    }
    await transaction.execute({
      sql: `INSERT INTO transactions (type, from_id, to_id, amount, status, staff_id, note)
        VALUES ('deposit', NULL, ?, ?, 'completed', ?, 'Admin balance addition')`,
      args: [target.id, amount, interaction.user.id],
    });
    const updatedResult = await transaction.execute({
      sql: "SELECT balance FROM accounts WHERE discord_id = ?",
      args: [target.id],
    });
    const newBalance = Number(updatedResult.rows[0].balance);
    await transaction.commit();

    await interaction.reply({
      content: `Added ${amount.toLocaleString()} to ${target.username}'s balance. New balance: ${newBalance.toLocaleString()}.`,
      ...ephemeralReply,
    });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
}

export async function handleAccountFreeze(db, interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Only server administrators can use this command.", ...ephemeralReply });
    return;
  }

  const target = interaction.options.getUser("user", true);
  const duration = interaction.options.getInteger("duration", true);
  const confirm = interaction.options.getBoolean("confirm", true);

  if (!confirm) {
    await interaction.reply({
      content: "Freeze cancelled. You must set confirm to True to freeze an account.",
      ...ephemeralReply,
    });
    return;
  }

  if (target.bot) {
    await interaction.reply({
      content: "Bots cannot have accounts.",
      ...ephemeralReply,
    });
    return;
  }

  if (duration < 1 || duration > 7) {
    await interaction.reply({
      content: "Duration must be between 1 and 7 days.",
      ...ephemeralReply,
    });
    return;
  }

  await ensureFrozenUntilColumn(db);

  const accountResult = await db.execute({
    sql: "SELECT discord_id, balance, frozen, frozen_until FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [target.id],
  });

  if (accountResult.rows.length === 0) {
    await interaction.reply({
      content: `${target.username} does not have a registered PTB account.`,
      ...ephemeralReply,
    });
    return;
  }

  const freezeExpiry = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);
  const freezeUntilIso = freezeExpiry.toISOString();
  const unixTimestamp = Math.floor(freezeExpiry.getTime() / 1000);

  await db.execute({
    sql: "UPDATE accounts SET frozen = 1, frozen_until = ? WHERE discord_id = ?",
    args: [freezeUntilIso, target.id],
  });

  const notifyMessage = `Your account has been froze by the administration of PTB for ${duration} ${duration === 1 ? "day" : "days"}, if you believe there has been any issues please contact us via tickets`;

  let dmDelivered = false;
  try {
    if (target && typeof target.send === "function") {
      await target.send(notifyMessage);
      dmDelivered = true;
    }
  } catch (_dmError) {
    // If the target user has closed DMs or blocked the bot, do not fail the freeze command
    dmDelivered = false;
  }

  await interaction.reply({
    content: `❄️ **${target.username}'s** account has been frozen for **${duration} ${duration === 1 ? "day" : "days"}** (until <t:${unixTimestamp}:f>). They cannot transfer funds or open transaction tickets during this time.${dmDelivered ? " The user has been notified via DM." : ""}`,
    ...ephemeralReply,
  });
}

export async function handleAccountUnfreeze(db, interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Only server administrators can use this command.", ...ephemeralReply });
    return;
  }

  const target = interaction.options.getUser("user", true);
  const confirm = interaction.options.getBoolean("confirm", true);

  if (!confirm) {
    await interaction.reply({
      content: "Unfreeze cancelled. You must set confirm to True to unfreeze an account.",
      ...ephemeralReply,
    });
    return;
  }

  await ensureFrozenUntilColumn(db);

  const accountResult = await db.execute({
    sql: "SELECT discord_id, balance, frozen FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [target.id],
  });

  if (accountResult.rows.length === 0) {
    await interaction.reply({
      content: `${target.username} does not have a registered PTB account.`,
      ...ephemeralReply,
    });
    return;
  }

  await db.execute({
    sql: "UPDATE accounts SET frozen = 0, frozen_until = NULL WHERE discord_id = ?",
    args: [target.id],
  });

  await interaction.reply({
    content: `☀️ **${target.username}'s** account has been unfrozen. Their account access has been fully restored.`,
    ...ephemeralReply,
  });
}

