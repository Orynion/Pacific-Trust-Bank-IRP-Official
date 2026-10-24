import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";

export const recurringChargeSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS recurring_charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL REFERENCES accounts(discord_id),
    kind TEXT NOT NULL CHECK (kind IN ('bill', 'tax')),
    name TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    interval TEXT NOT NULL CHECK (interval IN ('daily', 'weekly', 'monthly')),
    next_due_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS idx_recurring_charges_due ON recurring_charges(active, next_due_at)",
  `CREATE TABLE IF NOT EXISTS charge_reminders (
    charge_id INTEGER NOT NULL REFERENCES recurring_charges(id),
    due_at TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (charge_id, due_at)
  )`,
];

const ephemeral = { flags: MessageFlags.Ephemeral };
const chargeColor = 0x0B3D2E;
function chargeEmbed(title, description, color = chargeColor) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setFooter({ text: "Pacific Trust Bank · Roleplay ledger only" });
}
const addInterval = (date, interval) => {
  const next = new Date(date);
  if (interval === "daily") next.setUTCDate(next.getUTCDate() + 1);
  else if (interval === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
};

async function sendUserNotice(client, userId, payload) {
  if (!client) return;
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
  } catch (error) {
    console.warn(`Could not send PTB bill notification to ${userId}:`, error?.message ?? error);
  }
}

export async function sendDueChargeReminders(db, client, now = new Date()) {
  const cutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const due = await db.execute({
    sql: `SELECT c.id, c.discord_id, c.kind, c.name, c.amount, c.next_due_at
      FROM recurring_charges c LEFT JOIN charge_reminders r
        ON r.charge_id = c.id AND r.due_at = c.next_due_at
      WHERE c.active = 1 AND c.next_due_at <= ? AND r.charge_id IS NULL
      ORDER BY c.next_due_at LIMIT 100`,
    args: [cutoff],
  });
  for (const charge of due.rows) {
    const claimed = await db.execute({
      sql: "INSERT OR IGNORE INTO charge_reminders (charge_id, due_at) VALUES (?, ?)",
      args: [charge.id, charge.next_due_at],
    });
    if (claimed.rowsAffected !== 1) continue;
    const timestamp = Math.floor(new Date(charge.next_due_at).getTime() / 1000);
    await sendUserNotice(client, charge.discord_id, {
      embeds: [chargeEmbed(`${charge.kind === "tax" ? "Tax" : "Bill"} due soon`, `**${charge.name}**\nAmount: **${Number(charge.amount).toLocaleString()}**\nDue <t:${timestamp}:R>. It will be deducted automatically from your PTB ledger balance.`)],
    });
  }
  return due.rows.length;
}

export async function handleBillCommand(db, interaction, kind) {
  const action = interaction.options.getSubcommand();
  if (action === "settle") {
    const requestedUser = interaction.options.getUser("user");
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    const accountId = isAdmin && requestedUser ? requestedUser.id : interaction.user.id;
    const settledAt = new Date().toISOString();
    const tx = await db.transaction("write");
    try {
      const replay = await tx.execute({
        sql: "SELECT 1 FROM processed_interactions WHERE interaction_id = ? LIMIT 1",
        args: [interaction.id],
      });
      if (replay.rows.length) {
        await tx.rollback();
      await interaction.reply({ embeds: [chargeEmbed("Already processed", "This settlement was already processed.", 0xD97706)], ...ephemeral });
        return;
      }
      const chargeResult = await tx.execute({
        sql: "SELECT * FROM recurring_charges WHERE discord_id = ? AND kind = ? AND active = 1 AND next_due_at <= ? ORDER BY id LIMIT 1000",
        args: [accountId, kind, settledAt],
      });
      const charges = chargeResult.rows;
      if (!charges.length) {
        await tx.rollback();
        await interaction.reply({ embeds: [chargeEmbed(`No ${kind === "tax" ? "taxes" : "bills"} due`, `There are no ${kind === "tax" ? "taxes" : "bills"} currently due to settle.`)], ...ephemeral });
        return;
      }
      const total = charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      const account = await tx.execute({ sql: "SELECT balance, frozen FROM accounts WHERE discord_id = ?", args: [accountId] });
      const balance = Number(account.rows[0]?.balance ?? 0);
      if (!Number.isSafeInteger(total) || Number(account.rows[0]?.frozen) === 1 || balance < total) {
        await tx.rollback();
        await interaction.reply({ embeds: [chargeEmbed("Settlement not completed", `Insufficient funds. Nothing was deducted.\nAvailable balance: **${balance.toLocaleString()}**\nTotal due: **${total.toLocaleString()}**\nYour recurring schedules were not changed.`, 0xD97706)], ...ephemeral });
        return;
      }
      const debit = await tx.execute({
        sql: "UPDATE accounts SET balance = balance - ? WHERE discord_id = ? AND frozen = 0 AND balance >= ?",
        args: [total, accountId, total],
      });
      if (debit.rowsAffected !== 1) {
        await tx.rollback();
        await interaction.reply({ embeds: [chargeEmbed("Settlement not completed", "The account balance changed before settlement. Please try again.", 0xD97706)], ...ephemeral });
        return;
      }
      for (const charge of charges) {
        const schedule = addInterval(new Date(charge.next_due_at), charge.interval);
        const claim = await tx.execute({
          sql: "UPDATE recurring_charges SET next_due_at = ? WHERE id = ? AND active = 1 AND next_due_at = ?",
          args: [schedule, charge.id, charge.next_due_at],
        });
        if (claim.rowsAffected !== 1) throw new Error(`Recurring charge ${charge.id} changed during settlement`);
        await tx.execute({
          sql: "INSERT INTO transactions (type, from_id, to_id, amount, status, note) VALUES ('withdraw', ?, NULL, ?, 'completed', ?)",
          args: [accountId, charge.amount, `Settled ${charge.kind}: ${charge.name} (recurring #${charge.id})`],
        });
      }
      await tx.execute({
        sql: "DELETE FROM processed_interactions WHERE created_at <= datetime('now', '-7 days')",
        args: [],
      });
      await tx.execute({
        sql: "INSERT INTO processed_interactions (interaction_id) VALUES (?)",
        args: [interaction.id],
      });
      await tx.commit();
      const who = accountId === interaction.user.id ? "you" : `<@${accountId}>`;
      await interaction.reply({ embeds: [chargeEmbed(`${kind === "tax" ? "Taxes" : "Bills"} settled`, `Settled **${charges.length}** ${kind === "tax" ? "tax(es)" : "bill(s)"} for ${who}, totaling **${total.toLocaleString()}**.\nNext scheduled deductions are one interval from now.`)], allowedMentions: { users: accountId === interaction.user.id ? [] : [accountId] }, ...ephemeral });
      for (const charge of charges) {
        await sendUserNotice(interaction.client, accountId, {
          embeds: [chargeEmbed(`${charge.kind === "tax" ? "Tax" : "Bill"} settled`, `**${charge.name}**\nAmount: **${Number(charge.amount).toLocaleString()}**\nRecorded in your transaction history.`)],
        });
      }
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
    return;
  }
  const result = await db.execute({
    sql: "SELECT id, kind, name, amount, interval, next_due_at FROM recurring_charges WHERE discord_id = ? AND kind = ? AND active = 1 ORDER BY next_due_at",
    args: [interaction.user.id, kind],
  });
  const visibleCharges = result.rows.slice(0, 20);
  const lines = visibleCharges.map((row) => `**${row.name}** · ${Number(row.amount).toLocaleString()} / ${row.interval} · next <t:${Math.floor(new Date(row.next_due_at).getTime() / 1000)}:R>`);
  const extra = result.rows.length > visibleCharges.length ? `\n…and ${result.rows.length - visibleCharges.length} more.` : "";
  const description = lines.length ? `${lines.join("\n")}\n\nUse /${kind} settle to settle charges that are due.${extra}` : `You have no active recurring ${kind === "tax" ? "taxes" : "bills"}.`;
  await interaction.reply({ embeds: [chargeEmbed(`Your recurring ${kind === "tax" ? "taxes" : "bills"}`, description)], ...ephemeral });
}

// Run at startup and every minute. The charge row's due timestamp is a claim
// token, so overlapping workers cannot debit the same occurrence twice.
export async function processDueCharges(db, now = new Date(), client = null) {
  const due = await db.execute({
    sql: "SELECT id, discord_id, kind, name, amount, interval, next_due_at FROM recurring_charges WHERE active = 1 AND next_due_at <= ? ORDER BY next_due_at LIMIT 100",
    args: [now.toISOString()],
  });
  let processed = 0;
  for (const charge of due.rows) {
    let tx;
    try {
      tx = await db.transaction("write");
      const claimed = await tx.execute({
        sql: "UPDATE recurring_charges SET next_due_at = ? WHERE id = ? AND active = 1 AND next_due_at = ?",
        args: [addInterval(new Date(charge.next_due_at), charge.interval), charge.id, charge.next_due_at],
      });
      if (claimed.rowsAffected !== 1) { await tx.rollback(); continue; }
      const debit = await tx.execute({
        sql: "UPDATE accounts SET balance = balance - ? WHERE discord_id = ? AND frozen = 0 AND balance >= ?",
        args: [charge.amount, charge.discord_id, charge.amount],
      });
      await tx.execute({
        sql: "INSERT INTO transactions (type, from_id, to_id, amount, status, note) VALUES ('withdraw', ?, NULL, ?, ?, ?)",
        args: [charge.discord_id, charge.amount, debit.rowsAffected === 1 ? "completed" : "denied", `${charge.kind === "tax" ? "Tax" : "Bill"}: ${charge.name} (recurring #${charge.id})`],
      });
      await tx.commit();
      processed += 1;
      const succeeded = debit.rowsAffected === 1;
      const outcome = succeeded ? "was deducted" : "could not be deducted because the account is frozen or funds were insufficient";
      await sendUserNotice(client, charge.discord_id, {
        embeds: [chargeEmbed(`${charge.kind === "tax" ? "Tax" : "Bill"} ${succeeded ? "deducted" : "not deducted"}`, `**${charge.name}**\nAmount: **${Number(charge.amount).toLocaleString()}** ${outcome}.\nCheck your transaction history for the recorded result.`, succeeded ? chargeColor : 0xD97706)],
      });
    } catch (error) {
      // Fail closed for this occurrence (it is retried on the next run) and
      // keep processing the remaining due charges instead of aborting the
      // whole sweep, which would starve every charge queued behind it.
      await tx?.rollback().catch(() => {});
      console.error(`PTB recurring charge #${charge.id} processing failed:`, error);
    } finally {
      tx?.close();
    }
  }
  return processed;
}

/**
 * Run a full recurring-charge sweep (reminders + due deductions) with bounded
 * retries and backoff to handle transient database connection dropouts.
 *
 * Guarantees:
 * - Bounded retries: stops after maxAttempts (no infinite loop).
 * - Linear backoff: avoids hammering a recovering Turso instance.
 * - Non-fatal: returns { ok: false, error } on retry exhaustion without throwing
 *   so the scheduler process remains stable.
 */
export async function runRecurringChargesSweep(db, client, {
  now = new Date(),
  maxAttempts = 3,
  retryDelayMs = 2_000,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await sendDueChargeReminders(db, client, now);
      const processed = await processDueCharges(db, now, client);
      return { ok: true, attempt, processed };
    } catch (error) {
      if (attempt >= maxAttempts) {
        console.error(`Recurring bill/tax processing failed after ${maxAttempts} attempts:`, error?.message ?? error);
        return { ok: false, attempt, error };
      }
      const delay = attempt * retryDelayMs;
      console.warn(`Recurring bill/tax processing attempt ${attempt} failed; retrying in ${delay / 1000}s:`, error?.message ?? error);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return { ok: false, attempt: maxAttempts };
}
