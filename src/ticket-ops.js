import { MessageFlags, PermissionFlagsBits } from "discord.js";

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
export const TICKET_TOPIC_REGEX = /^ptb-ticket:(deposit|withdraw):(\d+):\d+(?::\d+)?$/;

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
        const nextStepHint = ticket.kind === "deposit"
          ? " Next step: use **Credit & finalise** to credit the requester."
          : " Next step: use **Mark paid & deduct balance** once the in-game payout has been delivered.";
        await interaction.reply({
          content: `${code} approved by the admin. The ticket is now **approved**, funds have **not** moved yet.${nextStepHint}`,
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
        await interaction.reply({
          content: `${code} rejected by the admin. No balance changes were made.`,
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
          content: `${code} was already completed by ${ticket.completion_by ? `<@${ticket.completion_by}>` : "an administrator"}${ticket.completion_at ? ` (at ${ticket.completion_at} UTC)` : ""}. Funds moved exactly once (ledger entry ${ticket.ledger_id ? `#${ticket.ledger_id}` : "released"}).`,
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

      const happened = ticket.kind === "deposit"
        ? `credited ${ticket.amount.toLocaleString()} to <@${ticket.requester_id}>`
        : `paid out ${ticket.amount.toLocaleString()} from <@${ticket.requester_id}>`;
      await interaction.reply({
        content: `${code} completed: ${happened}. New balance: ${newBalance.toLocaleString()}. Ledger entry ${ledgerNote} (#${ledgerId}).`,
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

/**
 * Closes a deposit/withdrawal ticket channel from its Close ticket button.
 * Verifies the interaction targets the real PTB ticket channel (channel ID +
 * channel topic) so the button cannot be abused against unrelated channels,
 * then requires the opener or a server administrator. Pending tickets are
 * marked rejected when their channel closes; approved/completed keep state.
 */
export async function handleTicketClose(db, interaction, channelId, ownerId) {
  const channel = interaction.channel;
  if (
    !channel || channel.id !== channelId ||
    !channel.topic?.match(TICKET_TOPIC_REGEX) ||
    channel.topic.split(":")[2] !== ownerId
  ) {
    await interaction.reply({ content: "This ticket could not be verified.", ...ephemeralReply });
    return;
  }

  if (
    interaction.user.id !== ownerId &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({ content: "Only the ticket opener or a server administrator can close this ticket.", ...ephemeralReply });
    return;
  }

  await interaction.deferReply(ephemeralReply);
  try {
    // A pending ticket whose channel is closed can no longer be reviewed, so
    // record it as rejected (approved/completed tickets keep their state).
    // A database hiccup here must not block the Discord cleanup.
    await rejectPendingTicketByChannel(db, channelId, "Ticket channel closed").catch((error) => {
      console.error("Could not reject pending PTB ticket on close:", error);
    });
    await channel.delete(`PTB ticket closed by ${interaction.user.tag}`);
    await interaction.editReply("Ticket closed.");
  } catch (error) {
    console.error("Could not close PTB ticket:", error);
    await interaction.editReply("I could not close this ticket. Please ask a server administrator to check my Manage Channels permission.");
  }
}
