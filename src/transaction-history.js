import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";

export const TRANSACTIONS_PER_PAGE = 5;

function formatTransaction(row, userId) {
  const amount = Number(row.amount).toLocaleString();
  let description;
  if (row.type === "deposit") {
    description = row.to_id === userId ? `Added +${amount}` : `Deposit ${amount}`;
  } else if (row.type === "transfer" && row.from_id === userId) {
    description = `Sent -${amount} to <@${row.to_id}>`;
  } else if (row.type === "transfer" && row.to_id === userId) {
    description = `Received +${amount} from <@${row.from_id}>`;
  } else if (row.type === "withdraw") {
    description = `Withdrawn -${amount}`;
  } else if (row.type === "reversal") {
    description = `Reversal ${amount}`;
  } else {
    description = `${row.type} ${amount}`;
  }

  const note = row.note ? ` | ${row.note}` : "";
  const createdAt = new Date(`${String(row.created_at).replace(" ", "T")}Z`);
  const timestamp = Number.isNaN(createdAt.getTime())
    ? String(row.created_at)
    : `<t:${Math.floor(createdAt.getTime() / 1000)}:f>`;
  return `**#${row.id} ${description}**${note}\n${timestamp} | ${row.status}`;
}

export function transactionHistoryPayload(userId, page, rows, totalCount) {
  const totalPages = Math.max(1, Math.ceil(totalCount / TRANSACTIONS_PER_PAGE));
  const content = rows.length
    ? `**Your transaction history** | Page ${page + 1} of ${totalPages}\n\n${rows.map((row) => formatTransaction(row, userId)).join("\n\n")}`
    : totalCount > 0
      ? "There are no transactions on this page. Use Previous to view available history."
      : "You have no transaction history yet.";
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`history:${userId}:${page - 1}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`history:${userId}:${page + 1}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
  return { content, components: [buttons], flags: MessageFlags.Ephemeral };
}

export async function getTransactionHistory(db, userId, requestedPage) {
  const countResult = await db.execute({
    sql: "SELECT COUNT(*) AS total FROM transactions WHERE from_id = ? OR to_id = ?",
    args: [userId, userId],
  });
  const totalCount = Number(countResult.rows[0].total);
  const totalPages = Math.max(1, Math.ceil(totalCount / TRANSACTIONS_PER_PAGE));
  const page = Math.max(0, Math.min(Math.trunc(requestedPage) || 0, totalPages - 1));
  const rowsResult = await db.execute({
    sql: `SELECT id, type, from_id, to_id, amount, status, note, created_at
      FROM transactions WHERE from_id = ? OR to_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    args: [userId, userId, TRANSACTIONS_PER_PAGE, page * TRANSACTIONS_PER_PAGE],
  });

  return transactionHistoryPayload(userId, page, rowsResult.rows, totalCount);
}

/**
 * Handler for the Previous/Next pagination buttons on a transaction-history
 * message. Enforces ownership server-side: only the member for whom the
 * history was opened may operate these buttons, regardless of who can
 * otherwise interact with the message.
 */
export async function handleHistoryButton(db, interaction, ownerId, requestedPage) {
  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      content: "Only the person who opened this transaction history can use these buttons.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  try {
    const payload = await getTransactionHistory(db, ownerId, Number(requestedPage));
    await interaction.update({ content: payload.content, components: payload.components });
  } catch (error) {
    console.error("Transaction history pagination failed:", error);
    await interaction.reply({
      content: "I could not load that page right now. Please try again shortly.",
      flags: MessageFlags.Ephemeral,
    }).catch((replyError) => console.error("Could not send history error reply:", replyError));
  }
}
