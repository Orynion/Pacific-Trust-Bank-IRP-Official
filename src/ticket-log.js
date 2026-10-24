import { EmbedBuilder } from "discord.js";
import { ticketConfig } from "./ticket-config.js";

const actionTitles = {
  TICKET_OPENED: "Ticket opened",
  TICKET_APPROVED: "Ticket approved",
  TICKET_REJECTED: "Ticket rejected",
  TICKET_COMPLETED: "Ticket completed",
  TICKET_CLOSED: "Ticket closed",
  TICKET_USER_ADDED: "Ticket helper added",
  TICKET_ACTION_DENIED: "Ticket action denied",
  RECEIPT_ANALYSIS_FAILED: "Receipt analysis failed",
  RECEIPT_ANALYSIS_POSTED: "Receipt analysis posted",
};

const actionColors = {
  TICKET_OPENED: 0x2563EB,
  TICKET_APPROVED: 0x16A34A,
  TICKET_REJECTED: 0xDC2626,
  TICKET_COMPLETED: 0x0B3D2E,
  TICKET_CLOSED: 0x475569,
  TICKET_USER_ADDED: 0x7C3AED,
  TICKET_ACTION_DENIED: 0xD97706,
  RECEIPT_ANALYSIS_FAILED: 0xD97706,
  RECEIPT_ANALYSIS_POSTED: 0x0891B2,
};

function ticketReference(ticket) {
  if (!ticket) return "unknown ticket";
  if (ticket.code) return ticket.code;
  const kind = ticket.kind === "withdraw" ? "W" : "D";
  return `PTB-${kind}-${ticket.id ?? "?"}`;
}

function safeText(value, maxLength = 1024) {
  return String(value ?? "").slice(0, maxLength);
}

/**
 * Operational ticket log: always writes one concise console line and, when
 * TICKET_LOG_CHANNEL_ID is configured, mirrors the event as an embed. Logging
 * failures are swallowed so they can never block or crash a ticket action.
 */
export async function logTicketEvent(client, event, { config = ticketConfig(), channel = null } = {}) {
  const reference = ticketReference(event.ticket);
  const actor = event.actorId ? `<@${event.actorId}>` : "system";
  const reason = event.reason ? ` | reason: ${safeText(event.reason, 300)}` : "";
  console.log(`[PTB Ticket] ${event.action} ${reference} actor=${event.actorId ?? "system"}${reason}`);

  if (!config.logChannelId || event.ticket?.channel_id === config.logChannelId) return;
  if (!channel && typeof client?.channels?.fetch !== "function") return;

  try {
    const target = channel ?? await client.channels.fetch(config.logChannelId);
    if (!target || typeof target.send !== "function") return;
    const embed = new EmbedBuilder()
      .setColor(actionColors[event.action] ?? 0x475569)
      .setTitle(actionTitles[event.action] ?? event.action)
      .setDescription(`**Ticket:** \`${reference}\`\n**Actor:** ${actor}${event.ticket?.requester_id ? `\n**Requester:** <@${event.ticket.requester_id}>` : ""}${event.ticket?.kind ? `\n**Type:** ${event.ticket.kind}` : ""}${event.ticket?.amount ? `\n**Amount:** ${Number(event.ticket.amount).toLocaleString()}` : ""}${event.statusBefore ? `\n**Previous status:** ${event.statusBefore}` : ""}${event.statusAfter ? `\n**New status:** ${event.statusAfter}` : ""}${event.reason ? `\n**Reason:** ${safeText(event.reason, 500)}` : ""}${event.details ? `\n${safeText(event.details, 500)}` : ""}`)
      .setTimestamp();

    const payload = { embeds: [embed], allowedMentions: { parse: [] } };
    if (event.transcript?.buffer) {
      payload.files = [{ attachment: event.transcript.buffer, name: event.transcript.name }];
    } else if (event.transcriptUnavailableReason) {
      embed.addFields({ name: "Transcript", value: safeText(event.transcriptUnavailableReason, 1024) });
    }
    await target.send(payload);
  } catch (error) {
    console.warn(`[PTB Ticket] Could not write ${event.action} to the ticket log channel:`, error?.message ?? error);
  }
}

/** Build a compact text transcript before the ticket channel is deleted. */
export async function buildTicketTranscript(channel, ticket) {
  if (!channel?.messages || typeof channel.messages.fetch !== "function") {
    return { error: "Message history was not available for this channel." };
  }
  const collection = await channel.messages.fetch({ limit: 100 });
  const messages = [...(collection?.values?.() ?? [])]
    .sort((left, right) => (left.createdTimestamp ?? 0) - (right.createdTimestamp ?? 0));
  const header = [
    "Pacific Trust Bank | Ticket transcript",
    `Ticket: ${ticketReference(ticket)}`,
    `Type: ${ticket?.kind ?? "unknown"}`,
    `Requester: ${ticket?.requester_id ?? "unknown"}`,
    `Amount: ${ticket?.amount ?? "unknown"}`,
    `Channel: ${channel.id}`,
    `Messages: ${messages.length}`,
    "",
  ];
  const lines = messages.map((message) => {
    const createdAt = message.createdAt instanceof Date ? message.createdAt.toISOString() : new Date(message.createdTimestamp ?? Date.now()).toISOString();
    const author = message.author?.tag ?? message.author?.username ?? `user ${message.author?.id ?? "?"}`;
    const attachments = message.attachments?.size
      ? `\n  attachments: ${[...message.attachments.values()].map((item) => `${item.name ?? "file"} (${item.url ?? "no url"})`).join(", ")}`
      : "";
    const embeds = message.embeds?.length ? `\n  embeds: ${message.embeds.map((embed) => embed.title ?? "untitled").join(", ")}` : "";
    return `[${createdAt}] ${author}: ${message.content || "(no text)"}${attachments}${embeds}`;
  });
  let text = [...header, ...lines].join("\n");
  if (text.length > 400_000) text = `${text.slice(0, 400_000)}\n\n[Transcript truncated at 400,000 characters]`;
  return {
    name: `transcript-${ticketReference(ticket).replace(/[^A-Za-z0-9-]/g, "-")}.txt`,
    buffer: Buffer.from(text, "utf8"),
    count: messages.length,
  };
}
