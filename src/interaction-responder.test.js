import assert from "node:assert/strict";
import test from "node:test";
import { MessageFlags } from "discord.js";
import {
  acknowledgeWithinDeadline,
  hasAcknowledged,
  makeDeferralSafe,
  respond,
  safeDeferReply,
  stripUnsettableFlags,
} from "./interaction-responder.js";

/**
 * Minimal stand-in for a discord.js interaction that reproduces the state
 * machine of InteractionResponses: reply/deferReply throw once acknowledged,
 * editReply/followUp throw before acknowledgment.
 */
function fakeInteraction() {
  const calls = { reply: [], defer: [], edit: [], followUp: [] };
  const interaction = {
    deferred: false,
    replied: false,
    ephemeral: false,
    calls,
    async reply(payload) {
      if (this.deferred || this.replied) throw new Error("InteractionAlreadyReplied");
      calls.reply.push(payload);
      this.replied = true;
      this.ephemeral = Boolean(payload && typeof payload === "object" && payload.flags & MessageFlags.Ephemeral);
      return payload;
    },
    async deferReply(payload = {}) {
      if (this.deferred || this.replied) throw new Error("InteractionAlreadyReplied");
      calls.defer.push(payload);
      this.deferred = true;
      this.ephemeral = Boolean(payload.flags & MessageFlags.Ephemeral);
      return undefined;
    },
    async editReply(payload) {
      if (!this.deferred && !this.replied) throw new Error("InteractionNotReplied");
      calls.edit.push(payload);
      this.replied = true;
      return payload;
    },
    async followUp(payload) {
      if (!this.deferred && !this.replied) throw new Error("InteractionNotReplied");
      calls.followUp.push(payload);
      this.replied = true;
      return payload;
    },
  };
  return interaction;
}

test("hasAcknowledged reflects deferred and replied state", () => {
  const interaction = fakeInteraction();
  assert.equal(hasAcknowledged(interaction), false);
  interaction.deferred = true;
  assert.equal(hasAcknowledged(interaction), true);
});

test("stripUnsettableFlags removes the ephemeral bit but keeps other flags", () => {
  const payload = { content: "hi", flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds };
  const stripped = stripUnsettableFlags(payload);
  assert.equal(stripped.flags, MessageFlags.SuppressEmbeds);
  assert.equal(stripped.content, "hi");
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds, "input is not mutated");

  assert.deepEqual(stripUnsettableFlags({ content: "plain", flags: MessageFlags.Ephemeral }), { content: "plain" });
  assert.equal(stripUnsettableFlags("a string"), "a string");
  assert.equal(stripUnsettableFlags(undefined), undefined);
  assert.deepEqual(stripUnsettableFlags({ content: "x" }), { content: "x" });
});

test("respond replies when the interaction is untouched", async () => {
  const interaction = fakeInteraction();
  await respond(interaction, { content: "pong" });
  assert.equal(interaction.calls.reply.length, 1);
  assert.equal(interaction.calls.edit.length, 0);
  assert.equal(interaction.calls.followUp.length, 0);
});

test("respond edits a deferred interaction and strips the ephemeral flag", async () => {
  const interaction = fakeInteraction();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await respond(interaction, { content: "result", flags: MessageFlags.Ephemeral });
  assert.equal(interaction.calls.reply.length, 0);
  assert.equal(interaction.calls.edit.length, 1);
  assert.equal(interaction.calls.edit[0].flags, undefined);
  assert.equal(interaction.calls.edit[0].content, "result");
});

test("respond follows up once the first response was sent", async () => {
  const interaction = fakeInteraction();
  await respond(interaction, { content: "first" });
  await respond(interaction, { content: "second" });
  assert.equal(interaction.calls.reply.length, 1);
  assert.equal(interaction.calls.followUp.length, 1);
  assert.equal(interaction.calls.followUp[0].content, "second");
});

test("safeDeferReply defers only once and reports which call deferred", async () => {
  const interaction = fakeInteraction();
  assert.equal(await safeDeferReply(interaction, { flags: MessageFlags.Ephemeral }), true);
  assert.equal(await safeDeferReply(interaction, { flags: MessageFlags.Ephemeral }), false, "second call must not throw or defer again");
  assert.equal(interaction.calls.defer.length, 1);

  const replied = fakeInteraction();
  await replied.reply({ content: "done" });
  assert.equal(await safeDeferReply(replied, {}), false, "no deferral after a reply was sent");
  assert.equal(replied.calls.defer.length, 0);
});

test("makeDeferralSafe routes direct reply() calls to editReply after a deferral", async () => {
  const interaction = fakeInteraction();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  makeDeferralSafe(interaction);

  // A downstream handler still calling interaction.reply() must keep working.
  await interaction.reply({ content: "handler output", flags: MessageFlags.Ephemeral });
  assert.equal(interaction.calls.reply.length, 0, "original reply must not run after deferral");
  assert.equal(interaction.calls.edit.length, 1);
  assert.equal(interaction.calls.edit[0].flags, undefined);
  assert.equal(interaction.calls.edit[0].content, "handler output");
});

test("makeDeferralSafe makes a second deferReply a no-op instead of an error", async () => {
  const interaction = fakeInteraction();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  makeDeferralSafe(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  assert.equal(interaction.calls.defer.length, 1);
});

test("makeDeferralSafe keeps untouched interactions on the immediate reply path", async () => {
  const interaction = fakeInteraction();
  makeDeferralSafe(interaction);
  await interaction.reply({ content: "pong" });
  assert.equal(interaction.calls.reply.length, 1);
  assert.equal(interaction.calls.edit.length, 0);
});

test("makeDeferralSafe is idempotent and does not recurse", async () => {
  const interaction = fakeInteraction();
  makeDeferralSafe(interaction);
  makeDeferralSafe(interaction);
  await interaction.deferReply({});
  await interaction.reply({ content: "ok" });
  assert.equal(interaction.calls.defer.length, 1);
  assert.equal(interaction.calls.edit.length, 1);
});

test("makeDeferralSafe routes a post-reply second send to followUp", async () => {
  const interaction = fakeInteraction();
  await interaction.reply({ content: "first" });
  makeDeferralSafe(interaction);
  await interaction.reply({ content: "second" });
  assert.equal(interaction.calls.reply.length, 1);
  assert.equal(interaction.calls.followUp.length, 1);
});

test("makeDeferralSafe waits for an in-flight deferral before replying", async () => {
  const interaction = fakeInteraction();
  let releaseDeferral;
  const originalDefer = interaction.deferReply.bind(interaction);
  interaction.deferReply = (payload) => new Promise((resolve) => {
    releaseDeferral = () => originalDefer(payload).then(resolve);
  });

  makeDeferralSafe(interaction);
  const deferral = interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const send = interaction.reply({ content: "raced" });
  releaseDeferral();
  await Promise.all([deferral, send]);

  assert.equal(interaction.deferred, true);
  assert.equal(interaction.calls.reply.length, 0, "reply must not race the deferral");
  assert.equal(interaction.calls.edit.length, 1, "reply lands as an edit of the deferred response");
});

test("acknowledgeWithinDeadline leaves a fast command untouched", async () => {
  const interaction = fakeInteraction();
  await acknowledgeWithinDeadline(interaction, async () => {
    await interaction.reply({ content: "fast" });
  }, { timeoutMs: 50, deferOptions: { flags: MessageFlags.Ephemeral } });

  assert.equal(interaction.calls.defer.length, 0, "fast path must not defer");
  assert.equal(interaction.calls.reply.length, 1);
  assert.equal(interaction.calls.edit.length, 0);
});

test("acknowledgeWithinDeadline defers a slow command so replies still land", async () => {
  const interaction = fakeInteraction();

  await acknowledgeWithinDeadline(interaction, async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Handler still uses interaction.reply() directly, as every PTB command does.
    await interaction.reply({ content: "slow result", flags: MessageFlags.Ephemeral });
  }, { timeoutMs: 20, deferOptions: { flags: MessageFlags.Ephemeral } });

  assert.equal(interaction.calls.defer.length, 1, "slow path defers once");
  assert.equal(interaction.deferred, true);
  assert.equal(interaction.calls.reply.length, 0, "deferred reply must not hit the raw reply");
  assert.equal(interaction.calls.edit.length, 1, "handler reply becomes editReply");
  assert.equal(interaction.calls.edit[0].content, "slow result");
  assert.equal(interaction.calls.edit[0].flags, undefined, "ephemeral flag stripped on edit");
  assert.equal(interaction.ephemeral, true, "deferral keeps the response ephemeral");
});

test("acknowledgeWithinDeadline surfaces command failures", async () => {
  const interaction = fakeInteraction();

  await assert.rejects(
    () => acknowledgeWithinDeadline(interaction, () => Promise.reject(new Error("boom")), { timeoutMs: 50 }),
    /boom/,
  );
  assert.equal(interaction.calls.defer.length, 0, "settled tasks are never deferred");
});

test("acknowledgeWithinDeadline keeps the error path working after a slow deferral", async () => {
  const interaction = fakeInteraction();

  const run = acknowledgeWithinDeadline(interaction, () => new Promise((resolve) => setTimeout(resolve, 60)).then(() => { throw new Error("slow boom"); }), { timeoutMs: 20, deferOptions: { flags: MessageFlags.Ephemeral } });
  await assert.rejects(() => run, /slow boom/);
  assert.equal(interaction.calls.defer.length, 1, "deadline deferral happened while the command was still working");

  // The caller's catch block then uses respond() for its error message.
  await respond(interaction, { content: "failed", flags: MessageFlags.Ephemeral });
  assert.equal(interaction.calls.edit.length, 1, "error message edits the deferred response");
  assert.equal(interaction.calls.reply.length, 0);
  assert.equal(interaction.calls.followUp.length, 0);
});

test("acknowledgeWithinDeadline never double-defers when the handler deferred itself", async () => {
  const interaction = fakeInteraction();

  await acknowledgeWithinDeadline(interaction, async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply("own edit");
  }, { timeoutMs: 20, deferOptions: { flags: MessageFlags.Ephemeral } });

  assert.equal(interaction.calls.defer.length, 1, "only one deferral reaches Discord");
  assert.equal(interaction.calls.edit.length, 1);
});

test("acknowledgeWithinDeadline does not defer when a reply is already on the wire", async () => {
  const interaction = fakeInteraction();
  // A reply whose HTTP POST is still in flight when the deadline expires.
  let releaseReply;
  const realReply = interaction.reply.bind(interaction);
  interaction.reply = (payload) => new Promise((resolve) => {
    releaseReply = () => realReply(payload).then(resolve);
  });

  await acknowledgeWithinDeadline(interaction, async () => {
    const send = interaction.reply({ content: "wire reply" });
    await new Promise((resolve) => setTimeout(resolve, 60)); // deadline fires meanwhile
    releaseReply();
    await send;
  }, { timeoutMs: 20, deferOptions: { flags: MessageFlags.Ephemeral } });

  assert.equal(interaction.calls.defer.length, 0, "an acknowledged interaction must not be deferred");
  assert.equal(interaction.calls.reply.length, 1, "the in-flight reply lands untouched");
  assert.equal(interaction.calls.edit.length, 0);
});

test("acknowledgeWithinDeadline still defers when the handler has not replied at all", async () => {
  const interaction = fakeInteraction();

  await acknowledgeWithinDeadline(interaction, () => new Promise((resolve) => setTimeout(resolve, 60)), { timeoutMs: 20, deferOptions: { flags: MessageFlags.Ephemeral } });

  assert.equal(interaction.calls.defer.length, 1);
  assert.equal(interaction.deferred, true);
});
