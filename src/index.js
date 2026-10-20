import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { getTransactionHistory } from "./transaction-history.js";
import { handleBillCommand, processDueCharges, recurringChargeSchemaStatements } from "./recurring-charges.js";
import {
  ephemeralReply,
  handleAddBalance,
  handleBalance,
  handleMoneyRequest,
  handleTransfer,
  schemaStatements,
} from "./bank-ops.js";
import {
  handleTicketDecision,
  rejectPendingTicketByChannel,
  ticketSchemaStatements,
} from "./ticket-ops.js";

const requiredEnv = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "TURSO_URL",
  "TURSO_AUTH_TOKEN",
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port number");
}

let ready = false;
const healthServer = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && requestUrl.pathname === "/oauth/roblox/callback") {
    void handleRobloxOAuthCallback(requestUrl, response);
    return;
  }

  if (request.url === "/health" || request.url === "/") {
    response.writeHead(ready ? 200 : 503, { "content-type": "text/plain; charset=utf-8" });
    response.end(ready ? "ok" : "starting");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});

healthServer.listen(port, "0.0.0.0", () => {
  console.log(`Health-check server listening on port ${port}`);
});

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const pingCommand = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Check whether the PTB bot is responding.");

const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show PTB commands available to you.");

const registerCommand = new SlashCommandBuilder()
  .setName("register")
  .setDescription("Link your Roblox account to PTB with Roblox OAuth.");

const verifyCommand = new SlashCommandBuilder()
  .setName("verify")
  .setDescription("Start Roblox verification for your PTB account.");

const balanceCommand = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("Check your own PTB account balance.");

const transactionCommand = new SlashCommandBuilder()
  .setName("transaction")
  .setDescription("View PTB transactions.")
  .addSubcommand((subcommand) => subcommand
    .setName("history")
    .setDescription("View your own recent PTB transaction history."));

function createMoneyRequestCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addIntegerOption((option) => option
      .setName("amount")
      .setDescription("The amount for your request.")
      .setMinValue(1)
      .setMaxValue(2_147_483_647)
      .setRequired(true));
}

const depositCommand = createMoneyRequestCommand("deposit", "Open a private ticket to request a deposit.");
const withdrawCommand = createMoneyRequestCommand("withdraw", "Open a private ticket to request a withdrawal.");

const verifyButton = new ButtonBuilder()
  .setCustomId("verify_with_roblox")
  .setLabel("Verify with Roblox")
  .setStyle(ButtonStyle.Primary);

const addBalanceCommand = new SlashCommandBuilder()
  .setName("add-balance")
  .setDescription("Add balance to a registered PTB account.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption((option) => option
    .setName("user")
    .setDescription("The Discord user whose balance will be increased.")
    .setRequired(true))
  .addIntegerOption((option) => option
    .setName("amount")
    .setDescription("The amount to add.")
    .setMinValue(1)
    .setRequired(true));

const transferCommand = new SlashCommandBuilder()
  .setName("transfer")
  .setDescription("Transfer money from your PTB account to another user.")
  .addUserOption((option) => option
    .setName("user")
    .setDescription("The user to receive the transfer.")
    .setRequired(true))
  .addIntegerOption((option) => option
    .setName("amount")
    .setDescription("The amount to transfer.")
    .setMinValue(1)
    .setRequired(true))
  .addBooleanOption((option) => option
    .setName("confirm")
    .setDescription("Confirm that you want to transfer this amount.")
    .setRequired(true));

const billCommand = new SlashCommandBuilder()
  .setName("bill")
  .setDescription("Manage recurring bills and taxes on PTB ledger accounts.")
  .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List your active recurring bills and taxes."))
  .addSubcommand((subcommand) => subcommand.setName("settle").setDescription("Settle all active recurring bills and taxes now.")
    .addUserOption((option) => option.setName("user").setDescription("Account to settle (administrator only).")))
  .addSubcommand((subcommand) => subcommand.setName("set").setDescription("Set a recurring charge for an account (administrator only).")
    .addUserOption((option) => option.setName("user").setDescription("Account to charge.").setRequired(true))
    .addStringOption((option) => option.setName("type").setDescription("Bill or tax.").setRequired(true)
      .addChoices({ name: "Bill", value: "bill" }, { name: "Tax", value: "tax" }))
    .addStringOption((option) => option.setName("name").setDescription("Charge label (up to 60 characters).").setMaxLength(60).setRequired(true))
    .addIntegerOption((option) => option.setName("amount").setDescription("Amount in ledger units.").setMinValue(1).setMaxValue(2_147_483_647).setRequired(true))
    .addStringOption((option) => option.setName("interval").setDescription("How often to deduct.").setRequired(true)
      .addChoices({ name: "Daily", value: "daily" }, { name: "Weekly", value: "weekly" }, { name: "Monthly", value: "monthly" })));

function createHelpEmbed(isAdministrator) {
  const embed = new EmbedBuilder()
    .setColor(0x0B3D2E)
    .setTitle("🏦 Pacific Trust Bank | Command Guide")
    .setDescription("PTB is a roleplay ledger for Emergency Hamburg RP. Commands below are limited to what your account can use.")
    .addFields(
      {
        name: "General",
        value: "`/ping` — Check whether PTB is responding.\nExample: `/ping`",
      },
      {
        name: "Account",
        value: [
          "`/register` — Link your Roblox account to PTB.\nExample: `/register`",
          "`/verify` — Start Roblox verification for your PTB account.\nExample: `/verify`",
          "`/balance` — Privately check your own PTB balance.\nExample: `/balance`",
          "`/bill list` — View active recurring bills and taxes; `/bill settle` pays all active charges now.",
        ].join("\n\n"),
      },
      {
        name: "Transactions",
        value: [
          "`/transaction history` — View your recent ledger activity with timestamps.\nExample: `/transaction history`",
          "`/deposit amount` — Open a private ticket to request a deposit.\nExample: `/deposit amount:500`",
          "`/withdraw amount` — Open a private ticket to request a withdrawal.\nExample: `/withdraw amount:250`",
          "`/transfer user amount confirm` — Transfer ledger funds to another user.\nExample: `/transfer user:@Alex amount:100 confirm:True`",
        ].join("\n\n"),
      },
    );

  if (isAdministrator) {
    embed.addFields({
      name: "Administration",
      value: "`/add-balance user amount` — Add funds to a registered user's ledger account.\nExample: `/add-balance user:@Alex amount:500`\n`/bill set user type name amount interval` — Create a daily, weekly, or monthly recurring bill or tax.",
    });
  }

  return embed.setFooter({ text: "Pacific Trust Bank • Roleplay ledger only; no real money is moved." });
}

async function handleHelp(interaction) {
  const isAdministrator = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  await interaction.reply({
    embeds: [createHelpEmbed(isAdministrator)],
    ...ephemeralReply,
  });
}

async function handleTransactionHistory(interaction) {
  await interaction.reply(await getTransactionHistory(db, interaction.user.id, 0));
}

function createAlreadyVerifiedReply(accountName) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("change_roblox_account")
      .setLabel("Change Account")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("cancel_change_account")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    content: `You are already verified with the account **${accountName}**. Do you want to change it?`,
    components: [row],
    ...ephemeralReply,
  };
}

async function handleVerify(interaction) {
  const accountResult = await db.execute({
    sql: "SELECT roblox_username FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [interaction.user.id],
  });
  if (accountResult.rows.length > 0) {
    const accountName = accountResult.rows[0].roblox_username || "Unknown";
    await interaction.reply(createAlreadyVerifiedReply(accountName));
    return;
  }

  await interaction.reply({
    content: "Click below to verify your Roblox account and link it to PTB.",
    components: [new ActionRowBuilder().addComponents(verifyButton)],
    ...ephemeralReply,
  });
}

async function handleTicketClose(interaction, channelId, ownerId) {
  const channel = interaction.channel;
  if (
    !channel || channel.id !== channelId ||
    !channel.topic?.match(/^ptb-ticket:(deposit|withdraw):(\d+):\d+(?::\d+)?$/) ||
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

const oauthConfigured = () => Boolean(
  process.env.ROBLOX_CLIENT_ID &&
  process.env.ROBLOX_CLIENT_SECRET &&
  process.env.ROBLOX_REDIRECT_URI,
);

async function startOAuthFlow(interaction, isChange = false) {
  if (!oauthConfigured()) {
    const content = "Roblox OAuth is not configured yet. The PTB administrator must add the Roblox OAuth app settings before accounts can be linked.";
    if (interaction.isButton() && interaction.customId === "change_roblox_account") {
      await interaction.update({ content, components: [] });
    } else if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content, ...ephemeralReply });
    } else {
      await interaction.followUp({ content, ...ephemeralReply });
    }
    return;
  }

  const discordId = interaction.user.id;
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await db.batch([
    {
      sql: "DELETE FROM oauth_sessions WHERE expires_at <= ? OR discord_id = ?",
      args: [new Date().toISOString(), discordId],
    },
    {
      sql: `INSERT INTO oauth_sessions (state, discord_id, code_verifier, expires_at)
        VALUES (?, ?, ?, ?)`,
      args: [state, discordId, codeVerifier, expiresAt],
    },
  ], "write");

  const authorizeUrl = new URL("https://apis.roblox.com/oauth/v1/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: process.env.ROBLOX_CLIENT_ID,
    redirect_uri: process.env.ROBLOX_REDIRECT_URI,
    scope: "openid profile",
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();

  const actionText = isChange ? "link a different Roblox account" : "link your Roblox account";
  const content = `Authorize PTB to ${actionText}: ${authorizeUrl.toString()}\nThis link expires in 10 minutes.`;

  if (interaction.isButton() && interaction.customId === "change_roblox_account") {
    await interaction.update({ content, components: [] });
  } else if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({ content, ...ephemeralReply });
  } else {
    await interaction.followUp({ content, ...ephemeralReply });
  }
}

async function handleRegister(interaction) {
  if (!oauthConfigured()) {
    await interaction.reply({
      content: "Roblox OAuth is not configured yet. The PTB administrator must add the Roblox OAuth app settings before accounts can be linked.",
      ...ephemeralReply,
    });
    return;
  }

  const discordId = interaction.user.id;
  const accountResult = await db.execute({
    sql: "SELECT roblox_username FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [discordId],
  });
  if (accountResult.rows.length > 0) {
    const accountName = accountResult.rows[0].roblox_username || "Unknown";
    await interaction.reply(createAlreadyVerifiedReply(accountName));
    return;
  }

  await startOAuthFlow(interaction, false);
}

function sendOAuthResult(response, status, message) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>PTB Roblox link</title></head><body><main><h1>PTB Roblox link</h1><p>${message}</p></main></body></html>`);
}

async function consumeOAuthState(state) {
  const transaction = await db.transaction("write");
  try {
    const result = await transaction.execute({
      sql: "SELECT discord_id, code_verifier, expires_at FROM oauth_sessions WHERE state = ?",
      args: [state],
    });
    const session = result.rows[0];
    await transaction.execute({ sql: "DELETE FROM oauth_sessions WHERE state = ?", args: [state] });
    await transaction.commit();
    if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
    return session;
  } finally {
    transaction.close();
  }
}

async function requestOAuthJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", ...options?.headers },
  });
  if (!response.ok) throw new Error(`Roblox OAuth returned HTTP ${response.status}`);
  return response.json();
}

async function handleRobloxOAuthCallback(requestUrl, response) {
  try {
    if (!oauthConfigured()) {
      sendOAuthResult(response, 503, "Roblox account linking is not configured on PTB yet. Return to Discord and contact a PTB administrator.");
      return;
    }

    const state = requestUrl.searchParams.get("state");
    if (!state) {
      sendOAuthResult(response, 400, "The authorization request was invalid. Run /register in Discord and try again.");
      return;
    }

    const session = await consumeOAuthState(state);
    if (!session) {
      sendOAuthResult(response, 400, "This authorization link expired or was already used. Run /register in Discord and try again.");
      return;
    }

    if (requestUrl.searchParams.has("error")) {
      sendOAuthResult(response, 400, "Roblox authorization was cancelled. You can run /register in Discord to try again.");
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      sendOAuthResult(response, 400, "Roblox did not return an authorization code. Run /register in Discord and try again.");
      return;
    }

    const tokenBody = new URLSearchParams({
      client_id: process.env.ROBLOX_CLIENT_ID,
      client_secret: process.env.ROBLOX_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      code_verifier: session.code_verifier,
    });
    const tokens = await requestOAuthJson("https://apis.roblox.com/oauth/v1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    if (typeof tokens.access_token !== "string") throw new Error("Roblox OAuth token response was invalid");

    const identity = await requestOAuthJson("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const robloxId = String(identity.sub ?? "");
    const robloxUsername = identity.preferred_username;
    if (!/^\d+$/.test(robloxId) || typeof robloxUsername !== "string" || !robloxUsername) {
      throw new Error("Roblox user information response was incomplete");
    }

    const pendingId = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await db.execute({
      sql: `INSERT INTO pending_links (id, discord_id, roblox_id, roblox_username, expires_at)
        VALUES (?, ?, ?, ?, ?)`,
      args: [pendingId, session.discord_id, robloxId, robloxUsername, expiresAt],
    });

    let dmSent = true;
    try {
      const user = await client.users.fetch(session.discord_id);
      await user.send({
        content: `We received a request to link your Roblox account **${robloxUsername}** to PTB. If this was you, click below to confirm. If not, ignore this message.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_link_${pendingId}`)
            .setLabel("Confirm linking")
            .setStyle(ButtonStyle.Success),
        )],
      });
    } catch (dmError) {
      dmSent = false;
      console.error("Could not send confirmation DM:", dmError);
    }

    const dmInstruction = dmSent
      ? "Return to Discord and click the confirmation button we sent you."
      : "We could not send you a Discord DM. Please enable Direct Messages from server members in your Discord privacy settings, then run /register in Discord again.";
    sendOAuthResult(response, 200, `Your Roblox account <strong>${escapeHtml(robloxUsername)}</strong> is ready. ${dmInstruction}`);
  } catch (error) {
    console.error("Roblox OAuth callback failed:", error.message);
    if (!response.headersSent) {
      sendOAuthResult(response, 502, "Roblox could not complete the account link right now. Run /register in Discord to try again.");
    }
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

async function handleConfirmLink(interaction, pendingId) {
  const transaction = await db.transaction("write");
  try {
    const result = await transaction.execute({
      sql: "SELECT discord_id, roblox_id, roblox_username, expires_at FROM pending_links WHERE id = ?",
      args: [pendingId],
    });
    const pending = result.rows[0];
    await transaction.execute({ sql: "DELETE FROM pending_links WHERE id = ?", args: [pendingId] });
    await transaction.commit();

    if (!pending || Date.parse(pending.expires_at) <= Date.now()) {
      await interaction.reply({ content: "This confirmation link expired. Run /register again.", ...ephemeralReply });
      return;
    }
    if (pending.discord_id !== interaction.user.id) {
      await interaction.reply({ content: "This confirmation was not for your account.", ...ephemeralReply });
      return;
    }

    const existingRoblox = await db.execute({
      sql: "SELECT discord_id FROM accounts WHERE roblox_id = ? LIMIT 1",
      args: [pending.roblox_id],
    });
    if (existingRoblox.rows.length > 0 && existingRoblox.rows[0].discord_id !== interaction.user.id) {
      await interaction.reply({ content: "That Roblox account is already linked to another PTB account.", ...ephemeralReply });
      return;
    }

    const existingDiscord = await db.execute({
      sql: "SELECT 1 FROM accounts WHERE discord_id = ? LIMIT 1",
      args: [interaction.user.id],
    });
    if (existingDiscord.rows.length > 0) {
      await db.execute({
        sql: "UPDATE accounts SET roblox_id = ?, roblox_username = ? WHERE discord_id = ?",
        args: [pending.roblox_id, pending.roblox_username, interaction.user.id],
      });
      await interaction.reply({
        content: `Your linked Roblox account has been updated to **${pending.roblox_username}**.`,
        ...ephemeralReply,
      });
    } else {
      await db.execute({
        sql: `INSERT INTO accounts (discord_id, roblox_id, roblox_username, balance, frozen)
          VALUES (?, ?, ?, 0, 0)`,
        args: [interaction.user.id, pending.roblox_id, pending.roblox_username],
      });
      await interaction.reply({
        content: `Your Roblox account **${pending.roblox_username}** is now linked to PTB.`,
        ...ephemeralReply,
      });
    }
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const ticketDecisionMatch = interaction.customId.match(/^tkt-(approve|complete|reject):(\d+)$/);
    if (ticketDecisionMatch) {
      try {
        await handleTicketDecision(db, interaction, ticketDecisionMatch[1], ticketDecisionMatch[2]);
      } catch (error) {
        console.error("PTB ticket action failed:", error);
        const reply = {
          content: "I could not process that ticket action right now. The ticket keeps its recorded state, so retrying the same action is safe.",
          ...ephemeralReply,
        };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch((replyError) => {
            console.error("Could not send ticket action error reply:", replyError);
          });
        } else {
          await interaction.reply(reply).catch((replyError) => {
            console.error("Could not send ticket action error reply:", replyError);
          });
        }
      }
      return;
    }

    const ticketCloseMatch = interaction.customId.match(/^ticket-close:(\d+):(\d+)$/);
    if (ticketCloseMatch) {
      await handleTicketClose(interaction, ticketCloseMatch[1], ticketCloseMatch[2]).catch(async (error) => {
        console.error("PTB ticket close button failed:", error);
        const reply = { content: "I could not close this ticket right now.", ...ephemeralReply };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      });
      return;
    }

    const historyMatch = interaction.customId.match(/^history:(\d+):(\d+)$/);
    if (historyMatch) {
      const [, ownerId, requestedPage] = historyMatch;
      if (interaction.user.id !== ownerId) {
        await interaction.reply({
          content: "Only the person who opened this transaction history can use these buttons.",
          ...ephemeralReply,
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
          ...ephemeralReply,
        }).catch((replyError) => console.error("Could not send history error reply:", replyError));
      }
      return;
    }

    if (interaction.customId === "verify_with_roblox") {
      try {
        await handleRegister(interaction);
      } catch (error) {
        console.error("Roblox verification button failed:", error);
        await interaction.reply({
          content: "I could not start verification right now. Please try again shortly.",
          ...ephemeralReply,
        }).catch((replyError) => console.error("Could not send verification error reply:", replyError));
      }
      return;
    }

    if (interaction.customId === "change_roblox_account") {
      try {
        await startOAuthFlow(interaction, true);
      } catch (error) {
        console.error("Change Roblox account button failed:", error);
        const reply = {
          content: "I could not start account change right now. Please try again shortly.",
          components: [],
        };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ ...reply, ...ephemeralReply }).catch(() => {});
        } else {
          await interaction.update(reply).catch(() => {});
        }
      }
      return;
    }

    if (interaction.customId === "cancel_change_account") {
      try {
        await interaction.update({
          content: "Account change cancelled.",
          components: [],
        });
      } catch (error) {
        console.error("Cancel change account button failed:", error);
      }
      return;
    }

    if (interaction.customId.startsWith("confirm_link_")) {
      const pendingId = interaction.customId.slice("confirm_link_".length);
      try {
        await handleConfirmLink(interaction, pendingId);
      } catch (error) {
        console.error("Confirm link failed:", error);
        await interaction.reply({
          content: "I could not complete that request right now. Please try again shortly.",
          ...ephemeralReply,
        }).catch((replyError) => console.error("Could not send confirm error reply:", replyError));
      }
      return;
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === "help") {
      await handleHelp(interaction);
    } else if (interaction.commandName === "ping") {
      await interaction.reply("pong");
    } else if (interaction.commandName === "register") {
      await handleRegister(interaction);
    } else if (interaction.commandName === "verify") {
      await handleVerify(interaction);
    } else if (interaction.commandName === "balance") {
      await handleBalance(db, interaction);
    } else if (interaction.commandName === "transaction" && interaction.options.getSubcommand() === "history") {
      await handleTransactionHistory(interaction);
    } else if (interaction.commandName === "deposit") {
      await handleMoneyRequest(db, interaction, "deposit");
    } else if (interaction.commandName === "withdraw") {
      await handleMoneyRequest(db, interaction, "withdraw");
    } else if (interaction.commandName === "add-balance") {
      await handleAddBalance(db, interaction);
    } else if (interaction.commandName === "transfer") {
      await handleTransfer(db, interaction);
    } else if (interaction.commandName === "bill") {
      await handleBillCommand(db, interaction);
    }
  } catch (error) {
    console.error(`Command /${interaction.commandName} failed:`, error);
    const reply = {
      content: "I could not complete that request right now. Please try again shortly.",
      ...ephemeralReply,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch((replyError) => {
        console.error("Could not send command error reply:", replyError);
      });
    } else {
      await interaction.reply(reply).catch((replyError) => {
        console.error("Could not send command error reply:", replyError);
      });
    }
  }
});

try {
  await db.batch([...schemaStatements, ...ticketSchemaStatements, ...recurringChargeSchemaStatements], "write");

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    {
      body: [
        helpCommand.toJSON(),
        pingCommand.toJSON(),
        registerCommand.toJSON(),
        verifyCommand.toJSON(),
        balanceCommand.toJSON(),
        transactionCommand.toJSON(),
        depositCommand.toJSON(),
        withdrawCommand.toJSON(),
        addBalanceCommand.toJSON(),
        transferCommand.toJSON(),
        billCommand.toJSON(),
      ],
    },
  );

  await client.login(process.env.DISCORD_TOKEN);
  ready = true;
  const runRecurringCharges = () => processDueCharges(db).catch((error) => {
    console.error("Recurring bill/tax processing failed:", error);
  });
  void runRecurringCharges();
  setInterval(runRecurringCharges, 60_000).unref();
} catch (error) {
  console.error("PTB startup failed:", error);
  healthServer.close();
  await db.close();
  process.exitCode = 1;
}
