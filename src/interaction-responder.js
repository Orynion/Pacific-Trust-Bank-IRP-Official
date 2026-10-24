import { MessageFlags } from "discord.js";

/**
 * Consistent interaction-response strategy for PTB.
 *
 * Discord requires the INITIAL response to an interaction within ~3 seconds;
 * after that the token expires and every reply attempt fails with
 * `DiscordAPIError[10062]: Unknown interaction`. PTB commands talk to Turso
 * (a remote database) before replying, so a slow network hop can blow that
 * deadline.
 *
 * The rules used everywhere:
 *   - Not acknowledged yet        -> interaction.reply()      (immediate reply)
 *   - Deadline expires mid-work    -> deferReply() once        (acknowledge in time)
 *   - Deferred, not yet replied    -> editReply()              (edit the deferred response)
 *   - Already replied              -> followUp()               (additional message)
 *   - Error handlers               -> same rules, so we never double-respond
 *
 * Three details matter for correctness with discord.js v14:
 *   1. reply()/deferReply() throw InteractionAlreadyReplied once acknowledged,
 *      and editReply()/followUp() throw InteractionNotReplied before it — so
 *      every send must pick the method that matches the current state
 *      (see respond()).
 *   2. Ephemeral is locked in when the response is first created (reply or
 *      deferReply) and cannot be changed by an edit, so the deferral is
 *      ephemeral and stripUnsettableFlags() drops the Ephemeral flag when a
 *      payload is downgraded to editReply().
 *   3. A reply landing while a deferral POST is still in flight would hit
 *      "already acknowledged" — the deferral-safe wrapper makes senders wait
 *      for the in-flight deferral first.
 */

/** Defer a little before Discord's ~3s limit to absorb network jitter. */
export const ACK_DEADLINE_MS = 2_500;

/** Message flags that cannot be (re)applied by editing a message. */
const UNSETTABLE_EDIT_FLAGS = MessageFlags.Ephemeral;

/** True once the interaction has been acknowledged (deferred or replied). */
export function hasAcknowledged(interaction) {
  return Boolean(interaction.deferred || interaction.replied);
}

/**
 * Remove flags that Discord ignores when editing an existing message.
 * Ephemerality was already decided when the response was first created,
 * so dropping the flag here changes nothing about who can see the message.
 */
export function stripUnsettableFlags(payload) {
  if (!payload || typeof payload !== "object" || payload.flags == null) return payload;
  const rawFlags = Number(payload.flags);
  if (!Number.isFinite(rawFlags)) return payload;
  const remainingFlags = rawFlags & ~UNSETTABLE_EDIT_FLAGS;
  const rest = { ...payload };
  delete rest.flags;
  if (remainingFlags > 0) rest.flags = remainingFlags;
  return rest;
}

/**
 * Send a response using whichever method matches the interaction's current
 * state: reply when untouched, editReply when deferred, followUp once the
 * first response has been sent. Safe from any code path, including error
 * handlers, without double-responding.
 */
export async function respond(interaction, payload) {
  if (!hasAcknowledged(interaction)) return interaction.reply(payload);
  if (!interaction.replied) return interaction.editReply(stripUnsettableFlags(payload));
  return interaction.followUp(payload);
}

/**
 * Defer at most once. Returns true when this call performed the deferral and
 * false when the interaction was already acknowledged (so a handler that
 * defers again never throws InteractionAlreadyReplied).
 */
export async function safeDeferReply(interaction, options) {
  if (hasAcknowledged(interaction)) return false;
  await interaction.deferReply(options);
  return true;
}

const DEFERRAL_SAFE = Symbol.for("ptb.interactionDeferralSafe");

/**
 * Make an interaction that was deferred out-of-band safe for handlers that
 * still call interaction.reply() / deferReply() / editReply() directly:
 *   - reply() becomes editReply() while the first response is pending, and
 *     followUp() once it has been sent;
 *   - deferReply() becomes a no-op when already acknowledged;
 *   - editReply()/followUp() wait for an in-flight deferral instead of
 *     racing it.
 * Original methods are captured before overriding and the adaptation is
 * idempotent, so wrapping can never recurse.
 */
export function makeDeferralSafe(interaction) {
  if (interaction[DEFERRAL_SAFE]) return interaction;

  const originalReply = interaction.reply.bind(interaction);
  const originalDeferReply = interaction.deferReply.bind(interaction);
  const originalEditReply = interaction.editReply.bind(interaction);
  const originalFollowUp = interaction.followUp.bind(interaction);

  let deferralPromise = null;
  let replyPromise = null;
  const beginDeferral = (options) => {
    if (hasAcknowledged(interaction)) return Promise.resolve();
    if (!deferralPromise) {
      deferralPromise = originalDeferReply(options).catch((error) => {
        // Allow a later retry after a failed deferral.
        deferralPromise = null;
        throw error;
      });
    }
    return deferralPromise;
  };
  const trackReply = (payload) => {
    const pending = originalReply(payload);
    replyPromise = pending.catch((error) => {
      if (replyPromise === pending) replyPromise = null;
      throw error;
    });
    return replyPromise;
  };
  // Wait for an in-flight POST without inheriting its failure, so each sender
  // falls through to its own state check afterwards.
  const settle = (promise) => promise.then(() => undefined, () => undefined);

  interaction.reply = async (payload) => {
    if (deferralPromise) await settle(deferralPromise);
    if (!hasAcknowledged(interaction)) return trackReply(payload);
    if (!interaction.replied) return originalEditReply(stripUnsettableFlags(payload));
    return originalFollowUp(payload);
  };
  interaction.deferReply = async (options) => {
    // Never race a reply POST that is already on the wire: once it lands the
    // interaction is acknowledged and no deferral is needed.
    if (replyPromise) await settle(replyPromise);
    if (hasAcknowledged(interaction)) return undefined;
    await beginDeferral(options);
    return undefined;
  };
  interaction.editReply = async (payload) => {
    if (deferralPromise) await settle(deferralPromise);
    return originalEditReply(stripUnsettableFlags(payload));
  };
  interaction.followUp = async (payload) => {
    if (deferralPromise) await settle(deferralPromise);
    return originalFollowUp(payload);
  };

  Object.defineProperty(interaction, DEFERRAL_SAFE, { value: true, enumerable: false });
  return interaction;
}

/**
 * Run a command's work while guaranteeing the interaction is acknowledged
 * within Discord's initial-response deadline:
 *   - If the work finishes first, nothing extra happens (fast path unchanged).
 *   - If the deadline expires first, the interaction is deferred (idempotently)
 *     and made deferral-safe, so every later reply()/editReply() inside the
 *     command keeps working.
 * The deferral is ephemeral because ephemerality cannot be changed by a later
 * edit and every PTB command except /ping responds ephemerally — in the rare
 * slow-database path /ping simply shows "pong" only to its caller.
 * The task's outcome (fulfilment or rejection) is always surfaced to the
 * caller so error handling behaves exactly as if there were no deadline.
 */
export async function acknowledgeWithinDeadline(interaction, startTask, { timeoutMs = ACK_DEADLINE_MS, deferOptions } = {}) {
  // Install the deferral-safe wrapper before the command starts, so every
  // reply the handler puts on the wire is visible to the deferral and we
  // never race two interaction callbacks against each other.
  makeDeferralSafe(interaction);

  const task = startTask();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  const settled = Promise.race([task.then(() => "settled", () => "settled"), timeout]);
  try {
    const outcome = await settled;
    if (outcome === "timeout") {
      try {
        await interaction.deferReply(deferOptions);
      } catch (error) {
        // A failed deferral must not mask the command's own result; the
        // command's eventual reply will either land or fail on its own.
        console.warn("PTB could not defer an interaction before the Discord deadline:", error?.message ?? error);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return task;
}
