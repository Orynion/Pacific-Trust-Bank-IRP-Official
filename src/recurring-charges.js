import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { validateMoneyAmount } from "./bank-ops.js";

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
];

const ephemeral = { flags: MessageFlags.Ephemeral };
const addInterval = (date, interval) => {
  const next = new Date(date);
  if (interval === "daily") next.setUTCDate(next.getUTCDate() + 1);
  else if (interval === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
};

export async function handleBillCommand(db, interaction) {
  const action = interaction.options.getSubcommand();
  if (action === "set") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "Only server administrators can set recurring charges.", ...ephemeral });
      return;
    }
    const target = interaction.options.getUser("user", true);
    const kind = interaction.options.getString("type", true);
    const name = interaction.options.getString("name", true).trim();
    const amount = interaction.options.getInteger("amount", true);
    const interval = interaction.options.getString("interval", true);
    const validation = validateMoneyAmount(amount);
    if (!validation.ok || !name || name.length > 60) {
      await interaction.reply({ content: validation.message ?? "Name must be 1 to 60 characters.", ...ephemeral });
      return;
    }
    const account = await db.execute({ sql: "SELECT 1 FROM accounts WHERE discord_id = ?", args: [target.id] });
    if (!account.rows.length) {
      await interaction.reply({ content: `${target.username} does not have a registered PTB account.`, ...ephemeral });
      return;
    }
    const due = addInterval(new Date(), interval);
    await db.execute({
      sql: "INSERT INTO recurring_charges (discord_id, kind, name, amount, interval, next_due_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [target.id, kind, name, amount, interval, due, interaction.user.id],
    });
    await interaction.reply({ content: `Recurring ${kind} **${name}** for ${target.username} is set to ${amount.toLocaleString()} ${interval}, starting <t:${Math.floor(new Date(due).getTime() / 1000)}:R>.`, ...ephemeral });
    return;
  }
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
        await interaction.reply({ content: "This settlement was already processed.", ...ephemeral });
        return;
      }
      const chargeResult = await tx.execute({
        sql: "SELECT * FROM recurring_charges WHERE discord_id = ? AND active = 1 AND next_due_at <= ? ORDER BY id LIMIT 1000",
        args: [accountId, settledAt],
      });
      const charges = chargeResult.rows;
      if (!charges.length) {
        await tx.rollback();
        await interaction.reply({ content: "There are no active recurring bills or taxes to settle.", ...ephemeral });
        return;
      }
      const total = charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      const account = await tx.execute({ sql: "SELECT balance, frozen FROM accounts WHERE discord_id = ?", args: [accountId] });
      const balance = Number(account.rows[0]?.balance ?? 0);
      if (!Number.isSafeInteger(total) || Number(account.rows[0]?.frozen) === 1 || balance < total) {
        await tx.rollback();
        await interaction.reply({ content: `Insufficient funds. Nothing was deducted. Available balance: ${balance.toLocaleString()}; total for all active bills and taxes: ${total.toLocaleString()}. Your recurring schedules were not changed.`, ...ephemeral });
        return;
      }
      const debit = await tx.execute({
        sql: "UPDATE accounts SET balance = balance - ? WHERE discord_id = ? AND frozen = 0 AND balance >= ?",
        args: [total, accountId, total],
      });
      if (debit.rowsAffected !== 1) {
        await tx.rollback();
        await interaction.reply({ content: "This charge could not be settled because the account balance changed. Please try again.", ...ephemeral });
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
      const who = accountId === interaction.user.id ? "your" : `<@${accountId}>'s`;
      await interaction.reply({ content: `Settled all ${charges.length} active bill(s) and tax(es) for ${who}, totaling ${total.toLocaleString()}. Their next scheduled deductions are one interval from now.`, allowedMentions: { users: accountId === interaction.user.id ? [] : [accountId] }, ...ephemeral });
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
    return;
  }
  const result = await db.execute({
    sql: "SELECT id, kind, name, amount, interval, next_due_at FROM recurring_charges WHERE discord_id = ? AND active = 1 ORDER BY next_due_at",
    args: [interaction.user.id],
  });
  const lines = result.rows.map((row) => `#${row.id} **${row.kind} · ${row.name}** — ${Number(row.amount).toLocaleString()} / ${row.interval}, next <t:${Math.floor(new Date(row.next_due_at).getTime() / 1000)}:R>`);
  await interaction.reply({ content: lines.length ? `**Your recurring charges**\n${lines.join("\n")}` : "You have no active recurring charges.", ...ephemeral });
}

// Run at startup and every minute. The charge row's due timestamp is a claim
// token, so overlapping workers cannot debit the same occurrence twice.
export async function processDueCharges(db, now = new Date()) {
  const due = await db.execute({
    sql: "SELECT id, discord_id, kind, name, amount, interval, next_due_at FROM recurring_charges WHERE active = 1 AND next_due_at <= ? ORDER BY next_due_at LIMIT 100",
    args: [now.toISOString()],
  });
  let processed = 0;
  for (const charge of due.rows) {
    const tx = await db.transaction("write");
    try {
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
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
  }
  return processed;
}
