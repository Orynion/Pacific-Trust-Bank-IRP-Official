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

  const accountResult = await db.execute({
    sql: "SELECT balance, frozen FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [interaction.user.id],
  });
  if (accountResult.rows.length === 0) {
    await interaction.editReply(REGISTER_FIRST_MESSAGE);
    return;
  }

  const account = accountResult.rows[0];
  const balance = Number(account.balance);
  if (Number(account.frozen) === 1) {
    await interaction.editReply("Your PTB account is frozen, so you cannot open a deposit or withdrawal request right now.");
    return;
  }
  if (type === "withdraw" && amount > balance) {
    await interaction.editReply(`You requested ${amount.toLocaleString()}, but your current balance is ${balance.toLocaleString()}.`);
    return;
  }

  // Server-side duplicate-request guard (backed by a unique partial index on
  // open tickets), so two racing /deposit or /withdraw invocations cannot both
  // open tickets for the same account.
  const existingRequestResult = await db.execute({
    sql: "SELECT 1 FROM tickets WHERE requester_id = ? AND kind = ? AND status = 'pending' LIMIT 1",
    args: [interaction.user.id, type],
  });
  if (existingRequestResult.rows.length > 0) {
    await interaction.editReply(`You already have an open ${type} ticket. Close it before opening another.`);
    return;
  }

  const ticketPrefix = ticketTopicPrefix(type, interaction.user.id);
  const channels = await interaction.guild.channels.fetch();
  const existingTicket = channels.find((channel) =>
    channel?.type === ChannelType.GuildText && channel.topic?.startsWith(ticketPrefix));
  if (existingTicket) {
    await interaction.editReply(`You already have an open ${type} ticket: ${existingTicket}. Close it before opening another.`);
    return;
  }

  // Every deposit/withdrawal request gets a unique, persistent transaction ID
  // before the Discord channel exists, so the ticket can always be tracked.
  let ticketId;
  try {
    ticketId = await createPendingTicket(db, { kind: type, requesterId: interaction.user.id, amount });
  } catch (error) {
    // The unique partial index makes the duplicate guard atomic: another
    // racing request may have claimed the only pending slot between the
    // pre-check and this insert.
    if (/idx_tickets_open_per_user|UNIQUE constraint failed/i.test(String(error?.message ?? ""))) {
      await interaction.editReply(`You already have an open ${type} ticket. Close it before opening another.`);
      return;
    }
    console.error("Could not create the PTB ticket record:", error);
    await interaction.editReply("I could not open the ticket right now because the ledger database rejected it. Please try again shortly.");
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
  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: ticketTopic(type, interaction.user.id, amount, ticketId),
      ...(category ? { parent: category.id } : {}),
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
  } catch (error) {
    await rejectTicketWithNote(db, ticketId, "Ticket channel could not be created").catch(() => {});
    void logTicketEvent(interaction.client, {
      action: "TICKET_ACTION_DENIED",
      ticket: { id: ticketId, kind: type, requester_id: interaction.user.id, amount },
      actorId: interaction.user.id,
      details: `Ticket channel creation failed: ${error?.message ?? "unknown error"}`,
    }, { config });
    throw error;
  }
  try {
    await attachTicketChannel(db, ticketId, channel.id);
  } catch (error) {
    // A pending ticket with no attached channel would bypass the channel
    // binding check in ticket-ops, so fail closed: reject the ticket and
    // remove the Discord channel so nothing can be decided from it.
    console.error("Could not attach the PTB ticket channel:", error);
    await rejectTicketWithNote(db, ticketId, "Ticket channel could not be linked to the ticket record").catch(() => {});
    await channel.delete("PTB ticket could not be linked to its record").catch(() => {});
    await interaction.editReply("I could not open the ticket right now because the ledger database rejected it. Please try again shortly.");
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
      details: `Channel <#${channel.id}>${category ? ` in category <#${category.id}>` : ""}.`,
    }, { config });
  } catch (error) {
    await rejectTicketWithNote(db, ticketId, "Ticket message could not be posted").catch(() => {});
    await channel.delete("Could not initialize the PTB money request ticket").catch(() => {});
    throw error;
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
      .setFooter({ text: "Private ledger balance · Roleplay only" })],
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
      sql: "SELECT balance, frozen FROM accounts WHERE discord_id = ? LIMIT 1",
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
    if (Number(senderRow.frozen) === 1) {
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
      sql: "SELECT balance, frozen FROM accounts WHERE discord_id = ? LIMIT 1",
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
    if (Number(targetRow.frozen) === 1) {
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
