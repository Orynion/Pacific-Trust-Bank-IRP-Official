import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { isTicketStaff, parseIdList, ticketConfig } from "./ticket-config.js";
import { buildTicketWelcomeEmbed } from "./ptb-embeds.js";
import { buildTicketTranscript, logTicketEvent } from "./ticket-log.js";

export const ephemeralReply = { flags: MessageFlags.Ephemeral };

export const ticketSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdraw')),
    requester_id TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
    channel_id TEXT,
    ledger_id INTEGER,
    decision_by TEXT,
    decision_at TEXT,
    completion_by TEXT,
    completion_at TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_channel
    ON tickets (channel_id)`,
  // Repair migration: if legacy data contains several simultaneous pending
  // requests of the same user and kind (possible before the guard below
  // existed), keep the oldest pending row and auto-close the duplicates so
  // the unique index creation can never fail at startup.
  `UPDATE tickets SET status = 'rejected',
      note = CASE WHEN note IS NULL OR note = '' THEN 'Duplicate open request auto-closed (one open request per user and kind)'
             ELSE note || ' | Duplicate open request auto-closed (one open request per user and kind)' END
    WHERE status = 'pending'
      AND id <> (SELECT MIN(id) FROM tickets AS t2
        WHERE t2.requester_id = tickets.requester_id AND t2.kind = tickets.kind AND t2.status = 'pending')`,
  // Enforces exactly one open (pending) request per user and kind, even for
  // two racing /deposit or /withdraw invocations.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_open_per_user
    ON tickets (requester_id, kind) WHERE status = 'pending'`,
];

export function ticketCode(ticket) {
  return `PTB-${ticket.kind === "deposit" ? "D" : "W"}-${ticket.id}`;
}

/**
 * The single ticket panel/welcome payload used by both /deposit and /withdraw.
 * Formatting comes from the shared PTB embed builder so ticket types cannot drift.
 */
export function ticketPanelPayload({ ticket, type, amount, balance, requester, channelId }) {
  const isDeposit = type === "deposit";

  return {
    content: `${requester}, your ${type} ticket is ready!`,
    embeds: [buildTicketWelcomeEmbed({ ticket, type, amount, balance, requester })],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`tkt-approve:${ticket.id}`)
          .setLabel(isDeposit ? "Approve: receipts verified" : "Approve payout")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`tkt-reject:${ticket.id}`)
          .setLabel("Reject")
          .setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`tkt-complete:${ticket.id}`)
          .setLabel(isDeposit ? "Credit & finalise" : "Mark paid & deduct balance")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`ticket-close:${channelId}:${ticket.id}`)
          .setLabel("Close ticket")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { users: [requester.id] },
  };
}

export async function createPendingTicket(db, { kind, requesterId, amount }) {
  const transaction = await db.transaction("write");
  try {
    const result = await transaction.execute({
      sql: `INSERT INTO tickets (kind, requester_id, amount, status) VALUES (?, ?, ?, 'pending')`,
      args: [kind, requesterId, amount],
    });
    let ticketId = result.lastInsertRowid;
    if (ticketId === undefined || ticketId === null) {
      const idResult = await transaction.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
      ticketId = idResult.rows[0].id;
    }
    await transaction.commit();
    return Number(ticketId);
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
}

export async function attachTicketChannel(db, ticketId, channelId) {
  await db.execute({
    sql: "UPDATE tickets SET channel_id = ? WHERE id = ? AND status = 'pending'",
    args: [channelId, ticketId],
  });
}

export async function rejectTicketWithNote(db, ticketId, note) {
  await db.execute({
    sql: `UPDATE tickets SET status = 'rejected',
      note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note || ' | ' || ? END
      WHERE id = ? AND status = 'pending'`,
    args: [note, note, ticketId],
  });
}

/**
 * Called when a ticket channel is closed while its ticket is still pending:
 * the ticket becomes rejected so it can never be paid out from a phantom
 * channel. Approved/completed tickets keep their state.
 */
export async function rejectPendingTicketByChannel(db, channelId, note) {
  await db.execute({
    sql: `UPDATE tickets SET status = 'rejected',
      note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note || ' | ' || ? END
      WHERE channel_id = ? AND status = 'pending'`,
    args: [note, note, channelId],
  });
}

// Single source of truth for ticket channel topics:
//   ptb-ticket:<kind>:<requesterId>:<amount>:<ticketId>
// bank-ops.js builds topics with this pattern and handleTicketClose below
// validates against it, so the two sides cannot drift.
export const TICKET_TOPIC_REGEX = /^ptb-ticket:(deposit|withdraw):(\d+):(\d+):(\d+)$/;

export function ticketTopic(kind, requesterId, amount, ticketId) {
  return `ptb-ticket:${kind}:${requesterId}:${amount}:${ticketId}`;
}

export function ticketTopicPrefix(kind, requesterId) {
  return `ptb-ticket:${kind}:${requesterId}:`;
}

export async function getTicket(db, transaction, ticketId) {
  const result = await transaction.execute({
    sql: `SELECT id, kind, requester_id, amount, status, channel_id, ledger_id,
        decision_by, decision_at, completion_by, completion_at, note
      FROM tickets WHERE id = ? LIMIT 1`,
    args: [ticketId],
  });
  return result.rows.length > 0
    ? {
        ...result.rows[0],
        id: Number(result.rows[0].id),
        amount: Number(result.rows[0].amount),
      }
    : null;
}

export async function getTicketByChannel(db, channelId) {
  const result = await db.execute({
    sql: `SELECT id, kind, requester_id, amount, status, channel_id, ledger_id,
        decision_by, decision_at, completion_by, completion_at, note
      FROM tickets WHERE channel_id = ? ORDER BY id DESC LIMIT 1`,
    args: [channelId],
  });
  return result.rows.length > 0
    ? {
        ...result.rows[0],
        id: Number(result.rows[0].id),
        amount: Number(result.rows[0].amount),
      }
    : null;
}

/**
 * Verify that the interaction happens inside the exact private channel that
 * owns the ticket. Both the channel id and the topic fields must agree with the
 * database, so a copied button, a recreated channel, or an edited topic cannot
 * target another ticket.
 */
export async function verifiedTicketFromInteraction(db, interaction, expectedChannelId = interaction.channelId) {
  const channel = interaction.channel;
  if (!channel || !expectedChannelId || String(channel.id) !== String(expectedChannelId)) return null;
  const match = channel.topic?.match(TICKET_TOPIC_REGEX);
  if (!match) return null;
  const [, topicKind, topicRequester, topicAmount, topicTicketId] = match;
  const ticket = await getTicketByChannel(db, channel.id);
  if (!ticket) return null;
  if (ticket.id !== Number(topicTicketId)) return null;
  if (ticket.kind !== topicKind) return null;
  if (String(ticket.requester_id) !== topicRequester) return null;
  if (Number(ticket.amount) !== Number(topicAmount)) return null;
  return ticket;
}

async function checkCanProcess(db, transaction, ticket, kind) {
  // The requester's account must still be registered and unfrozen when funds
  // actually move. Failed checks leave the ticket approved so it can be
  // retried later (never silently lost).
  const accountResult = await transaction.execute({
    sql: "SELECT balance, frozen FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [ticket.requester_id],
  });
  if (accountResult.rows.length === 0) {
    return {
      ok: false,
      reply: {
        content: `The requester <@${ticket.requester_id}> does not have a registered PTB account. Ticket ${ticketCode(ticket)} remains approved for a later retry.`,
        ...ephemeralReply,
      },
    };
  }
  if (Number(accountResult.rows[0].frozen) === 1) {
    return {
      ok: false,
      reply: {
        content: `The requester's PTB account is frozen. Ticket ${ticketCode(ticket)} remains approved for a later retry.`,
        ...ephemeralReply,
      },
    };
  }
  return { ok: true, account: accountResult.rows[0] };
}

export async function handleTicketDecision(db, interaction, action, ticketIdRaw) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Only server administrators can process PTB tickets.",
      ...ephemeralReply,
    });
    return;
  }

  const ticketId = Number(ticketIdRaw);
  if (!Number.isSafeInteger(ticketId) || ticketId < 1 || String(ticketId) !== String(ticketIdRaw)) {
    await interaction.reply({ content: "That ticket reference is invalid.", ...ephemeralReply });
    return;
  }

  const adminId = interaction.user.id;
  const transaction = await db.transaction("write");
  try {
    const ticket = await getTicket(db, transaction, ticketId);
    if (!ticket) {
      await transaction.rollback();
      await interaction.reply({ content: `Ticket #${ticketIdRaw} was not found.`, ...ephemeralReply });
      return;
    }
    const code = ticketCode(ticket);

    // Channel binding: a decision button is only valid inside the private
    // ticket channel that owns this ticket. A button interaction replayed in
    // any other channel (or a moved/copied message) must never be able to flip
    // ticket state — this keeps decisions auditable in the right place.
    if (ticket.channel_id && String(interaction.channelId ?? "") !== String(ticket.channel_id)) {
      await transaction.rollback();
      await interaction.reply({
        content: `${code} can only be processed inside its private ticket channel.`,
        ...ephemeralReply,
      });
      return;
    }

    if (action === "approve") {
      if (ticket.status === "pending") {
        if (ticket.kind === "withdraw") {
          // Approving a payout is only sensible while the requester still has
          // the funds: re-check before transitioning (the payout performs the
          // authoritative atomic check again at completion time).
          const accountResult = await transaction.execute({
            sql: "SELECT balance, frozen FROM accounts WHERE discord_id = ? LIMIT 1",
            args: [ticket.requester_id],
          });
          const requesterBalance = accountResult.rows.length > 0 ? Number(accountResult.rows[0].balance) : null;
          if (requesterBalance === null) {
            await transaction.rollback();
            await interaction.reply({
              content: `Cannot approve ${code}: the requester <@${ticket.requester_id}> no longer has a registered PTB account. The ticket stays pending.`,
              ...ephemeralReply,
            });
            return;
          }
          if (Number(accountResult.rows[0].frozen) === 1) {
            await transaction.rollback();
            await interaction.reply({
              content: `Cannot approve ${code}: the requester's PTB account is frozen. The ticket stays pending.`,
              ...ephemeralReply,
            });
            return;
          }
          if (requesterBalance < ticket.amount) {
            await transaction.rollback();
            await interaction.reply({
              content: `Cannot approve ${code}: <@${ticket.requester_id}>'s current balance is ${requesterBalance.toLocaleString()}, which is less than the requested payout of ${ticket.amount.toLocaleString()}. The ticket stays pending; reject it or wait for funds.`,
              ...ephemeralReply,
            });
            return;
          }
        }
        const decisionResult = await transaction.execute({
          sql: `UPDATE tickets SET status = 'approved', decision_by = ?, decision_at = datetime('now')
            WHERE id = ? AND status = 'pending'`,
          args: [adminId, ticketId],
        });
        if (decisionResult.rowsAffected !== 1) {
          await transaction.rollback();
          await interaction.reply({
            content: `${code} changed state just now, please retry.`,
            ...ephemeralReply,
          });
          return;
        }
        await transaction.commit();
        void logTicketEvent(interaction.client, {
          action: "TICKET_APPROVED",
          ticket,
          actorId: adminId,
          statusBefore: "pending",
          statusAfter: "approved",
        }, { config: ticketConfig() });
        const nextStepHint = ticket.kind === "deposit"
          ? " Next step: use **Credit & finalise** to credit the requester."
          : " Next step: use **Mark paid & deduct balance** once the in-game payout has been delivered.";
        await interaction.reply({
          content: `${code}: The ticket is verified by an admin, although no changes to your balance were made.${nextStepHint}`,
        });
        return;
      }

      await transaction.rollback();
      if (ticket.status === "approved") {
        await interaction.reply({
          content: `${code} was already approved by <@${ticket.decision_by}>${ticket.decision_at ? ` (at ${ticket.decision_at} UTC)` : ""}.`,
          ...ephemeralReply,
        });
        return;
      }
      if (ticket.status === "completed") {
        await interaction.reply({
          content: `${code} is already completed (processed by <@${ticket.completion_by}>); approval is no longer possible.`,
          ...ephemeralReply,
        });
        return;
      }
      await interaction.reply({
        content: `${code} was already rejected by ${ticket.decision_by ? `<@${ticket.decision_by}>` : "the system"}${ticket.decision_at ? ` (at ${ticket.decision_at} UTC)` : ""}.`,
        ...ephemeralReply,
      });
      return;
    }

    if (action === "reject") {
      if (ticket.status === "pending") {
        const rejectResult = await transaction.execute({
          sql: `UPDATE tickets SET status = 'rejected', decision_by = ?, decision_at = datetime('now')
            WHERE id = ? AND status = 'pending'`,
          args: [adminId, ticketId],
        });
        if (rejectResult.rowsAffected !== 1) {
          await transaction.rollback();
          await interaction.reply({ content: `${code} changed state just now, please retry.`, ...ephemeralReply });
          return;
        }
        await transaction.commit();
        void logTicketEvent(interaction.client, {
          action: "TICKET_REJECTED",
          ticket,
          actorId: adminId,
          statusBefore: "pending",
          statusAfter: "rejected",
        }, { config: ticketConfig() });
        await interaction.reply({
          content: `${code} rejected by admin. Your balance was not updated.`,
        });
        return;
      }

      await transaction.rollback();
      if (ticket.status === "rejected") {
        await interaction.reply({
          content: `${code} was already rejected by ${ticket.decision_by ? `<@${ticket.decision_by}>` : "the system"}.`,
          ...ephemeralReply,
        });
        return;
      }
      if (ticket.status === "approved") {
        await interaction.reply({
          content: `${code} is already approved by <@${ticket.decision_by}> and can no longer be rejected; complete it or contact a PTB developer.`,
          ...ephemeralReply,
        });
        return;
      }
      await interaction.reply({
        content: `${code} is already completed (processed by <@${ticket.completion_by}>).`,
        ...ephemeralReply,
      });
      return;
    }

    if (action === "complete") {
      if (ticket.status === "pending") {
        await transaction.rollback();
        await interaction.reply({
          content: `${code} has not been approved yet. An administrator must approve it first.`,
          ...ephemeralReply,
        });
        return;
      }
      if (ticket.status === "rejected") {
        await transaction.rollback();
        await interaction.reply({
          content: `${code} was rejected by ${ticket.decision_by ? `<@${ticket.decision_by}>` : "the system"} and cannot be processed.`,
          ...ephemeralReply,
        });
        return;
      }
      if (ticket.status === "completed") {
        await transaction.rollback();
        await interaction.reply({
          content: `${code} was already completed by ${ticket.completion_by ? `<@${ticket.completion_by}>` : "an administrator"}${ticket.completion_at ? ` (at ${ticket.completion_at} UTC)` : ""}. Funds moved exactly once (transaction #${ticket.ledger_id ? ticket.ledger_id : "completed"}).`,
          ...ephemeralReply,
        });
        return;
      }

      // status === "approved": the only path that moves money. The status flip,
      // the balance change, and the ledger entry commit together, so a crash or
      // retry can never apply the effect twice and never applies it without
      // the status transition. RETURNS below all roll back and leave the
      // ticket approved for a later retry.
      const guard = await checkCanProcess(db, transaction, ticket, ticket.kind);
      if (!guard.ok) {
        await transaction.rollback();
        await interaction.reply(guard.reply);
        return;
      }

      const requesterBalance = Number(guard.account.balance);
      if (ticket.kind === "withdraw" && requesterBalance < ticket.amount) {
        await transaction.rollback();
        await interaction.reply({
          content: `Cannot pay out ${ticket.amount.toLocaleString()} for ${code}: <@${ticket.requester_id}>'s current balance is ${requesterBalance.toLocaleString()}. ${code} remains approved for a later retry.`,
          ...ephemeralReply,
        });
        return;
      }
      if (ticket.kind === "deposit" && requesterBalance + ticket.amount > 2_147_483_647) {
        await transaction.rollback();
        await interaction.reply({
          content: `Cannot credit ${code}: that would exceed the supported balance limit. ${code} remains approved for a later retry.`,
          ...ephemeralReply,
        });
        return;
      }

      // Same atomic conditional money guard as /transfer: concurrent writes cannot
      // overdraw (withdrawals) or overflow (credits) the account.
      const moneyResult = ticket.kind === "withdraw"
        ? await transaction.execute({
            sql: "UPDATE accounts SET balance = balance - ? WHERE discord_id = ? AND balance >= ?",
            args: [ticket.amount, ticket.requester_id, ticket.amount],
          })
        : await transaction.execute({
            sql: "UPDATE accounts SET balance = balance + ? WHERE discord_id = ? AND balance <= ?",
            args: [ticket.amount, ticket.requester_id, 2_147_483_647 - ticket.amount],
          });
      if (moneyResult.rowsAffected !== 1) {
        await transaction.rollback();
        const fallbackMessage = ticket.kind === "withdraw"
          ? `Cannot pay out ${ticket.amount.toLocaleString()} for ${code}: <@${ticket.requester_id}>'s balance changed concurrently. ${code} remains approved for a later retry.`
          : `Cannot credit ${code}: the balance changed concurrently. ${code} remains approved for a later retry.`;
        await interaction.reply({ content: fallbackMessage, ...ephemeralReply });
        return;
      }

      const ledgerNote = ticket.kind === "deposit"
        ? `Ticket ${code} deposit credited`
        : `Ticket ${code} payout processed`;

      const ledgerResult = await transaction.execute({
        sql: `INSERT INTO transactions (type, from_id, to_id, amount, status, staff_id, note)
          VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
        args: [
          ticket.kind, // 'deposit' or 'withdraw' matches the ledger types
          ticket.kind === "withdraw" ? ticket.requester_id : null,
          ticket.kind === "withdraw" ? null : ticket.requester_id,
          ticket.amount,
          adminId,
          ledgerNote,
        ],
      });
      let ledgerId = ledgerResult.lastInsertRowid;
      if (ledgerId === undefined || ledgerId === null) {
        const idResult = await transaction.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
        ledgerId = idResult.rows[0].id;
      }
      ledgerId = Number(ledgerId);

      const ticketResult = await transaction.execute({
        sql: `UPDATE tickets SET status = 'completed', completion_by = ?, completion_at = datetime('now'), ledger_id = ?
          WHERE id = ? AND status = 'approved'`,
        args: [adminId, ledgerId, ticketId],
      });
      if (ticketResult.rowsAffected !== 1) {
        await transaction.rollback();
        await interaction.reply({
          content: `${code} changed state just now (another administrator processed it), please check its status and retry.`,
          ...ephemeralReply,
        });
        return;
      }

      const updatedBalanceResult = await transaction.execute({
        sql: "SELECT balance FROM accounts WHERE discord_id = ? LIMIT 1",
        args: [ticket.requester_id],
      });
      const newBalance = Number(updatedBalanceResult.rows[0].balance);
      await transaction.commit();
      void logTicketEvent(interaction.client, {
        action: "TICKET_COMPLETED",
        ticket,
        actorId: adminId,
        statusBefore: "approved",
        statusAfter: "completed",
        details: `New balance: ${newBalance.toLocaleString()}; ledger #${ledgerId}.`,
      }, { config: ticketConfig() });

      const happened = ticket.kind === "deposit"
        ? `credited ${ticket.amount.toLocaleString()} to <@${ticket.requester_id}>`
        : `paid out ${ticket.amount.toLocaleString()} from <@${ticket.requester_id}>`;
      await interaction.reply({
        content: `${code} completed: ${happened}. New balance: ${newBalance.toLocaleString()}. Ticket ${code} ${ticket.kind === "deposit" ? "deposit credited" : "payout processed"} (#${ledgerId}).`,
      });
      return;
    }

    await transaction.rollback();
    await interaction.reply({ content: "That ticket action is not supported.", ...ephemeralReply });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
}

function closureNote(actorId, reason) {
  const suffix = reason ? `: ${reason}` : "";
  return `Closed by ticket staff <@${actorId}>${suffix}`;
}

async function recordTicketClosure(db, ticket, { actorId, reason }) {
  const note = closureNote(actorId, reason).slice(0, 1000);
  await db.execute({
    sql: `UPDATE tickets SET
        status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END,
        decision_by = CASE WHEN status = 'pending' THEN ? ELSE decision_by END,
        decision_at = CASE WHEN status = 'pending' THEN datetime('now') ELSE decision_at END,
        note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note || ' | ' || ? END
      WHERE id = ? AND channel_id = ?`,
    args: [actorId, note, note, ticket.id, ticket.channel_id],
  });
}

export async function runTicketCloseCountdown(channel, {
  seconds = 5,
  intervalMs = (process.env.NODE_ENV === "test" || process.env.npm_lifecycle_event === "test" || process.argv.includes("--test")) ? 0 : 1000,
} = {}) {
  if (!channel || typeof channel.send !== "function" || seconds <= 0) return;

  let message = null;
  try {
    message = await channel.send(`This ticket will be deleted in ${seconds}...`);
  } catch (error) {
    console.warn("[PTB Ticket] Could not post ticket deletion countdown:", error?.message ?? error);
    return;
  }

  for (let count = seconds - 1; count >= 1; count--) {
    if (intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const text = `This ticket will be deleted in ${count}...`;
    try {
      if (message && typeof message.edit === "function") {
        await message.edit(text);
      } else {
        await channel.send(text);
      }
    } catch (editError) {
      console.warn(`[PTB Ticket] Could not update deletion countdown to ${count}:`, editError?.message ?? editError);
    }
  }

  if (intervalMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function performTicketClose(db, interaction, ticket, { reason = "", config = ticketConfig(), countdownSeconds = 5, countdownIntervalMs } = {}) {
  const statusBefore = ticket.status;
  await interaction.deferReply(ephemeralReply);

  // Collect the transcript before the channel disappears. Transcript failures
  // are non-fatal: closing must still work when history is unavailable.
  let transcript = null;
  let transcriptUnavailableReason = null;
  try {
    const result = await buildTicketTranscript(interaction.channel, ticket);
    if (result?.buffer) transcript = result;
    else transcriptUnavailableReason = result?.error ?? "Message history was not available.";
  } catch (error) {
    console.warn(`[PTB Ticket] Could not build transcript for ${ticketCode(ticket)}:`, error?.message ?? error);
    transcriptUnavailableReason = "Transcript creation failed; see the bot console for details.";
  }

  try {
    await recordTicketClosure(db, ticket, { actorId: interaction.user.id, reason });
  } catch (error) {
    console.error(`Could not record closure of ${ticketCode(ticket)}:`, error);
  }

  try {
    await runTicketCloseCountdown(interaction.channel, {
      seconds: countdownSeconds,
      ...(countdownIntervalMs !== undefined ? { intervalMs: countdownIntervalMs } : {}),
    });
  } catch (countdownError) {
    console.warn(`[PTB Ticket] Countdown error before closing ${ticketCode(ticket)}:`, countdownError?.message ?? countdownError);
  }

  let deleted = false;
  try {
    await interaction.channel.delete(`PTB ticket ${ticketCode(ticket)} closed by ${interaction.user.tag ?? interaction.user.id}${reason ? `: ${reason}` : ""}`);
    deleted = true;
  } catch (error) {
    console.error(`Could not delete PTB ticket channel for ${ticketCode(ticket)}:`, error);
  }

  await logTicketEvent(interaction.client, {
    action: "TICKET_CLOSED",
    ticket,
    actorId: interaction.user.id,
    reason,
    statusBefore,
    statusAfter: statusBefore === "pending" ? "rejected" : statusBefore,
    transcript,
    transcriptUnavailableReason,
  }, { config });

  await interaction.editReply(deleted
    ? `Ticket ${ticketCode(ticket)} is closed${reason ? " and the closure reason was recorded" : ""}.`
    : "The ticket was marked closed, but I could not delete the channel. Please ask an administrator to check my Manage Channels permission.")
    .catch((error) => console.warn("Could not confirm ticket closure to the staff member:", error?.message ?? error));
}

/**
 * Core close handler (also used by tests/direct calls). It verifies the exact
 * private ticket channel, then requires an administrator or configured ticket
 * staff role. The requester and added helpers cannot close the ticket.
 */
export async function handleTicketClose(db, interaction, channelId, _legacyOwnerOrTicketId, options = {}) {
  const config = options.config ?? ticketConfig();
  let ticket;
  try {
    ticket = await verifiedTicketFromInteraction(db, interaction, channelId);
  } catch (error) {
    console.error("Could not verify PTB ticket before closing:", error);
    await interaction.reply({ content: "I could not verify this ticket right now. Please try again.", ...ephemeralReply });
    return;
  }
  if (!ticket) {
    await interaction.reply({ content: "This ticket could not be verified.", ...ephemeralReply });
    return;
  }

  if (!isTicketStaff(interaction, config.staffRoleIds)) {
    await logTicketEvent(interaction.client, {
      action: "TICKET_ACTION_DENIED",
      ticket,
      actorId: interaction.user.id,
      details: "Attempted to close a ticket without a ticket staff role.",
    }, { config });
    await interaction.reply({
      content: "Only ticket staff can close this ticket. Ask a staff member to close it for you.",
      ...ephemeralReply,
    });
    return;
  }

  const reason = String(options.reason ?? "").trim().slice(0, 500);
  await performTicketClose(db, interaction, ticket, { reason, config });
}

/**
 * Close-button entry point. Staff get an optional-reason modal; the actual
 * close happens on submit through handleTicketCloseModal. If a client cannot
 * show modals, the verified staff close still works directly.
 */
export async function handleTicketCloseRequest(db, interaction, channelId, _ticketRef = null, options = {}) {
  const config = options.config ?? ticketConfig();
  let ticket;
  try {
    ticket = await verifiedTicketFromInteraction(db, interaction, channelId);
  } catch (error) {
    console.error("Could not verify PTB ticket before opening the close dialog:", error);
    await interaction.reply({ content: "I could not verify this ticket right now. Please try again.", ...ephemeralReply });
    return;
  }
  if (!ticket) {
    await interaction.reply({ content: "This ticket could not be verified.", ...ephemeralReply });
    return;
  }
  if (!isTicketStaff(interaction, config.staffRoleIds)) {
    await logTicketEvent(interaction.client, {
      action: "TICKET_ACTION_DENIED",
      ticket,
      actorId: interaction.user.id,
      details: "Attempted to close a ticket without a ticket staff role.",
    }, { config });
    await interaction.reply({
      content: "Only ticket staff can close this ticket. Ask a staff member to close it for you.",
      ...ephemeralReply,
    });
    return;
  }
  if (typeof interaction.showModal !== "function") {
    return handleTicketClose(db, interaction, channelId, null, { config });
  }

  const modal = new ModalBuilder()
    .setCustomId(`tcm-close:${ticket.id}`)
    .setTitle(`Close ${ticketCode(ticket)}`.slice(0, 45));
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId("reason")
      .setLabel("Closure reason (optional)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(500)
      .setPlaceholder("Example: request handled, receipt verified and credited"),
  ));
  try {
    await interaction.showModal(modal);
  } catch (error) {
    console.error(`Could not show the close dialog for ${ticketCode(ticket)}:`, error);
    await interaction.reply({ content: "I could not open the closure dialog. Please try again or ask an administrator.", ...ephemeralReply }).catch(() => {});
  }
}

/** Modal submit handler for the optional closure reason. */
export async function handleTicketCloseModal(db, interaction) {
  const match = interaction.customId?.match(/^tcm-close:(\d+)$/);
  if (!match) return false;
  const config = ticketConfig();
  const ticket = await getTicket(db, db, Number(match[1]));
  if (!ticket || !ticket.channel_id || String(interaction.channelId) !== String(ticket.channel_id)) {
    await interaction.reply({ content: "This ticket could not be verified.", ...ephemeralReply });
    return true;
  }
  const verified = await verifiedTicketFromInteraction(db, interaction, ticket.channel_id);
  if (!verified) {
    await interaction.reply({ content: "This ticket could not be verified.", ...ephemeralReply });
    return true;
  }
  if (!isTicketStaff(interaction, config.staffRoleIds)) {
    await logTicketEvent(interaction.client, {
      action: "TICKET_ACTION_DENIED",
      ticket: verified,
      actorId: interaction.user.id,
      details: "Attempted to submit a ticket closure without a ticket staff role.",
    }, { config });
    await interaction.reply({ content: "Only ticket staff can close this ticket.", ...ephemeralReply });
    return true;
  }
  let reason = "";
  try {
    reason = String(interaction.fields?.getTextInputValue("reason") ?? "").trim().slice(0, 500);
  } catch {
    reason = "";
  }
  await performTicketClose(db, interaction, verified, { reason, config });
  return true;
}

function staffRolesFrom(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return parseIdList(value);
  return ticketConfig().staffRoleIds;
}

/**
 * Secure /add-user: only ticket staff, only inside the exact ticket channel,
 * never bots, and only explicit per-user view/send/history permissions.
 */
export async function handleAddUser(db, interaction, roleIds = ticketConfig().staffRoleIds) {
  const config = { ...ticketConfig(), staffRoleIds: staffRolesFrom(roleIds) };
  if (!interaction.inGuild?.() || !interaction.guild || !interaction.channel) {
    await interaction.reply({ content: "Use /add-user inside the private ticket channel you want to share.", ...ephemeralReply });
    return;
  }
  if (!isTicketStaff(interaction, config.staffRoleIds)) {
    await interaction.reply({ content: "Only ticket staff can add a user to a ticket.", ...ephemeralReply });
    return;
  }

  let ticket;
  try {
    ticket = await verifiedTicketFromInteraction(db, interaction, interaction.channelId);
  } catch (error) {
    console.error("Could not verify PTB ticket before /add-user:", error);
    await interaction.reply({ content: "I could not verify this ticket right now. Please try again.", ...ephemeralReply });
    return;
  }
  if (!ticket) {
    await interaction.reply({ content: "This command only works inside a verified PTB ticket channel.", ...ephemeralReply });
    return;
  }

  const user = interaction.options.getUser("user", true);
  if (!user || user.bot) {
    await interaction.reply({ content: "Bots cannot be added to a private ticket.", ...ephemeralReply });
    return;
  }
  if (String(user.id) === String(ticket.requester_id)) {
    await interaction.reply({ content: "The ticket requester already has access to this channel.", ...ephemeralReply });
    return;
  }
  if (!interaction.channel.permissionOverwrites || typeof interaction.channel.permissionOverwrites.edit !== "function") {
    await interaction.reply({ content: "I cannot update this channel's permissions right now. Please ask an administrator to check my Manage Channels permission.", ...ephemeralReply });
    return;
  }

  await interaction.deferReply(ephemeralReply);
  try {
    await interaction.channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
    }, { reason: `${ticketCode(ticket)} helper added by ${interaction.user.id}` });
    await interaction.editReply(`${user} can now view and reply in ${ticketCode(ticket)}.`);
    await logTicketEvent(interaction.client, {
      action: "TICKET_USER_ADDED",
      ticket,
      actorId: interaction.user.id,
      details: `Added <@${user.id}> as a ticket helper.`,
    }, { config });
  } catch (error) {
    console.error(`Could not add a helper to ${ticketCode(ticket)}:`, error);
    await interaction.editReply("I could not add that user to the ticket. Please ask an administrator to check my Manage Channels permission.");
  }
}
