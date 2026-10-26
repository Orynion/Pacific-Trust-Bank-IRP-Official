import "dotenv/config";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import {
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { acknowledgeWithinDeadline, isExpiredInteractionError, respond } from "./interaction-responder.js";
import { getTransactionHistory, handleHistoryButton } from "./transaction-history.js";
import { handleBillCommand, processDueCharges, recurringChargeSchemaStatements, runRecurringChargesSweep, sendDueChargeReminders } from "./recurring-charges.js";
import {
  ensureFrozenUntilColumn,
  ephemeralReply,
  handleAddBalance,
  handleAccountFreeze,
  handleAccountUnfreeze,
  handleBalance,
  handleMoneyRequest,
  handleTransfer,
  schemaStatements,
} from "./bank-ops.js";
import { BLOXLINK_VERIFY_URL, createRegistrationEventHandler, validateRegistrationConfig, validateRoleAssignmentAccess } from "./bloxlink-registration.js";
import { handleAddUser, handleTicketCloseModal, handleTicketCloseRequest, handleTicketDecision, ticketSchemaStatements } from "./ticket-ops.js";
import { ticketConfig, validateTicketConfiguration } from "./ticket-config.js";
import { handleDepositTicketImage, ticketDepositSchemaStatements } from "./ticket-deposit.js";
import { ensureAmountComparisonColumn, handleTreasuryButton, handleTreasuryHistory, handleTreasuryModal, handleTreasuryReport, handleTreasurySearch, handleTreasuryStatus, handleTreasuryTotal, submitTreasuryPayment, treasurySchemaStatements } from "./treasury-ops.js";

const requiredEnv = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "TURSO_URL", "TURSO_AUTH_TOKEN"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length) {
  console.warn(`[PTB Info] Missing environment variables: ${missingEnv.join(", ")}`);
  console.warn("[PTB Info] Running with local SQLite fallback. Set Discord and Bloxlink configuration to connect.");
}
const port = Number(process.env.PORT || 3000);

let discordReady = false;

const healthServer = createServer((request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        status: "ok",
        service: "ptb-discord-bot",
        discordReady,
        database: dbUrl.startsWith("file:") ? "local-sqlite" : "turso",
        uptime: process.uptime()
      }));
      return;
    }

    if (requestUrl.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pacific Trust Bank - Discord Bot Status</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --success: #10b981;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      max-width: 600px;
      width: 100%;
      padding: 2rem;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .badge-ok { background: rgba(16, 185, 129, 0.2); color: var(--success); }
    .badge-warn { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
    }
    h1 { font-size: 1.5rem; margin-top: 1rem; margin-bottom: 0.5rem; }
    p { color: var(--text-muted); font-size: 0.95rem; line-height: 1.5; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1.5rem; margin-bottom: 1.5rem; }
    .stat { background: rgba(0, 0, 0, 0.2); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); }
    .stat-label { font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.05em; }
    .stat-val { font-size: 1.1rem; font-weight: 600; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge ${discordReady ? 'badge-ok' : 'badge-warn'}">
      <span class="status-dot"></span>
      ${discordReady ? 'Bot Connected & Operational' : 'Dev Server Running (Standby)'}
    </span>
    <h1>Pacific Trust Bank Bot</h1>
    <p>The backend server is active and responding on port ${port}.</p>
    <div class="grid">
      <div class="stat">
        <div class="stat-label">Discord Gateway</div>
        <div class="stat-val">${discordReady ? 'Online' : 'Awaiting Token'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Database</div>
        <div class="stat-val">${dbUrl.startsWith('file:') ? 'SQLite Local' : 'Turso Remote'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Receipt OCR</div>
        <div class="stat-val" style="color: var(--accent);">Tesseract + Sharp Active</div>
      </div>
      <div class="stat">
        <div class="stat-label">HTTP Health</div>
        <div class="stat-val" style="color: var(--success);">HTTP 200 OK</div>
      </div>
    </div>
  </div>
</body>
</html>`);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  } catch (error) {
    console.error("PTB health server request failed:", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("internal server error");
  }
});

healthServer.listen(port, "0.0.0.0", () => {
  console.log(`Health-check server listening on port ${port}`);
});

const dbUrl = process.env.TURSO_URL || "file:ptb-local.db";

// Increase the default connect timeout for remote Turso databases.
// Node's built-in fetch (undici) defaults to a 10 s connect timeout. On
// high-latency paths to Turso's ap-south-1 endpoint this often expires with
// UND_ERR_CONNECT_TIMEOUT before the TLS handshake completes. A 30 s ceiling
// with TCP/TLS keep-alive connection reuse prevents repeated handshake timeouts.
let tursoFetchDispatcher;
if (dbUrl && !dbUrl.startsWith("file:")) {
  try {
    const { Agent } = await import("undici");
    const timeoutMs = Number(process.env.TURSO_CONNECT_TIMEOUT_MS) || 30_000;
    tursoFetchDispatcher = new Agent({
      connect: { timeout: timeoutMs },
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
    console.log(`[PTB Info] Turso fetch connect timeout set to ${timeoutMs} ms with keep-alive.`);
  } catch {
    console.warn("[PTB Info] Could not load undici; using default fetch connect timeout.");
  }
}

const db = createClient({
  url: dbUrl,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  ...(tursoFetchDispatcher
    ? { fetch: (input, init) => globalThis.fetch(input, { ...init, dispatcher: tursoFetchDispatcher }) }
    : {}),
});

const pingCommand = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Check whether the PTB bot is responding.");

const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show PTB commands available to you.");

const registerCommand = new SlashCommandBuilder()
  .setName("register")
  .setDescription("Register your Roblox account with PTB through Bloxlink verification.");

const unregisterCommand = new SlashCommandBuilder()
  .setName("unregister")
  .setDescription("Disconnect your Roblox account from PTB while keeping your ledger account.");

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

const addUserCommand = new SlashCommandBuilder()
  .setName("add-user")
  .setDescription("Add a user to the current private ticket (ticket staff only).")
  .addUserOption((option) => option
    .setName("user")
    .setDescription("The user who should be able to view and reply in this ticket.")
    .setRequired(true));

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

const accountFreezeCommand = new SlashCommandBuilder()
  .setName("account-freeze")
  .setDescription("Freeze a registered PTB account (Administrators only).")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption((option) => option
    .setName("user")
    .setDescription("The user whose account will be frozen.")
    .setRequired(true))
  .addIntegerOption((option) => option
    .setName("duration")
    .setDescription("Duration of the freeze in days (1 to 7).")
    .setMinValue(1)
    .setMaxValue(7)
    .setRequired(true))
  .addBooleanOption((option) => option
    .setName("confirm")
    .setDescription("Confirm that you want to freeze this account.")
    .setRequired(true));

const accountUnfreezeCommand = new SlashCommandBuilder()
  .setName("account-unfreeze")
  .setDescription("Unfreeze a registered PTB account (Administrators only).")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption((option) => option
    .setName("user")
    .setDescription("The user whose account will be unfrozen.")
    .setRequired(true))
  .addBooleanOption((option) => option
    .setName("confirm")
    .setDescription("Confirm that you want to unfreeze this account.")
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

function createRecurringCommand(kind) {
  const plural = kind === "tax" ? "taxes" : "bills";
  return new SlashCommandBuilder()
    .setName(kind)
    .setDescription(`Manage recurring ${plural} on PTB ledger accounts.`)
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription(`List your active recurring ${plural}.`))
    .addSubcommand((subcommand) => subcommand.setName("settle").setDescription(`Settle all currently due ${plural}.`)
      .addUserOption((option) => option.setName("user").setDescription("Account to settle (administrator only).")));
}

const billCommand = createRecurringCommand("bill");
const taxCommand = createRecurringCommand("tax");

const treasurySubmitCommand = new SlashCommandBuilder().setName("treasury-submit").setDescription("Submit an in-game IRP Treasury payment receipt for review.")
  .addStringOption((o) => o.setName("payer").setDescription("Roblox username that made the payment.").setRequired(true).setMaxLength(20))
  .addIntegerOption((o) => o.setName("amount").setDescription("Amount paid in game.").setMinValue(1).setMaxValue(2_147_483_647).setRequired(true))
  .addStringOption((o) => o.setName("purpose").setDescription("Payment purpose or description.").setRequired(true).setMaxLength(500))
  .addAttachmentOption((o) => o.setName("screenshot").setDescription("Screenshot of the transaction.").setRequired(true));
const treasuryStatusCommand = new SlashCommandBuilder().setName("treasury-status").setDescription("Check your IRP Treasury submission status.")
  .addStringOption((o) => o.setName("reference").setDescription("Receipt reference, for example IRPT-000001.").setRequired(true).setMaxLength(20));
const treasuryHistoryCommand = new SlashCommandBuilder().setName("treasury-history").setDescription("View your recent IRP Treasury submissions.");
const treasurySearchCommand = new SlashCommandBuilder().setName("treasury-search").setDescription("Search IRP Treasury submissions (reviewers only).")
  .addStringOption((o) => o.setName("query").setDescription("Receipt reference or exact Roblox username.").setRequired(true).setMaxLength(20));
const treasuryReportCommand = new SlashCommandBuilder().setName("treasury-report").setDescription("Show IRP Treasury review and verified totals (reviewers only).")
  .addStringOption((o) => o.setName("from").setDescription("Start date YYYY-MM-DD (inclusive)."))
  .addStringOption((o) => o.setName("to").setDescription("End date YYYY-MM-DD (inclusive)."));
const treasuryTotalCommand = new SlashCommandBuilder().setName("treasury-total").setDescription("Show total verified IRP Treasury payments (reviewers only).");
const TREASURY_REVIEW_ROLES = process.env.TREASURY_REVIEWER_ROLE_IDS || "";

function createHelpEmbed(isAdministrator) {
  const embed = new EmbedBuilder()
    .setColor(0x0B3D2E)
    .setTitle("🏦 Pacific Trust Bank | Command Guide")
    .setDescription("PTB is a bank ledger for Emergency Hamburg RP. Commands below are limited to what your account can use.")
    .addFields(
      {
        name: "General",
        value: "`/ping` — Check whether PTB is responding.\nExample: `/ping`",
      },
      {
        name: "Account",
        value: [
          "`/register` — Check Bloxlink and register your linked Roblox account. PTB also registers automatically after Bloxlink verification.\nExample: `/register`",
          "`/unregister` — Disconnect your Roblox identity while keeping your PTB balance and transaction history.\nExample: `/unregister`",
          "`/balance` — Privately check your own PTB balance.\nExample: `/balance`",
          "`/bill list` and `/tax list` — View recurring bills and taxes separately. Use `/bill settle` or `/tax settle` to settle due charges of that type.",
        ].join("\n\n"),
      },
      {
        name: "Transactions",
        value: [
          "`/transaction history` — View your recent ledger activity with timestamps.\nExample: `/transaction history`",
          "`/deposit amount` — Open a private ticket to request a deposit.\nExample: `/deposit amount:500`",
          "`/withdraw amount` — Open a private ticket to request a withdrawal.\nExample: `/withdraw amount:250`",
          "`/add-user user` — Ticket staff can let another member view and reply in the current private ticket.",
          "`/transfer user amount confirm` — Transfer ledger funds to another user.\nExample: `/transfer user:@Alex amount:100 confirm:True`",
        ].join("\n\n"),
      },
      {
        name: "IRP Treasury payments",
        value: [
          "`/treasury-submit payer amount purpose screenshot` — Submit an in-game payment screenshot for authorized review.",
          "`/treasury-status reference` and `/treasury-history` — Privately check your own submissions.",
          "`/treasury-search`, `/treasury-report`, `/treasury-total` — Treasury staff tools for configured reviewers and administrators.",
        ].join("\n\n"),
      },
    );

  if (isAdministrator) {
    embed.addFields({
      name: "Administration",
      value: "`/add-balance user amount` — Add funds to a registered user's ledger account.\nExample: `/add-balance user:@Alex amount:500`",
    });
  }

  return embed.setFooter({ text: "Pacific Trust Bank • No real money is moved." });
}

async function handleHelp(interaction) {
  const isAdministrator = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  await respond(interaction, {
    embeds: [createHelpEmbed(isAdministrator)],
    ...ephemeralReply,
  });
}

async function handleTransactionHistory(interaction) {
  await respond(interaction, await getTransactionHistory(db, interaction.user.id, 0));
}

async function handleRegister(interaction) {
  // Acknowledge the interaction before any network call (DB, member fetch,
  // Bloxlink) so slow lookups can never turn into "The application did not
  // respond", which would leave users stuck in an unusable registration loop.
  await interaction.deferReply(ephemeralReply);

  const accountResult = await db.execute({
    sql: "SELECT roblox_id, roblox_username FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [interaction.user.id],
  });
  if (accountResult.rows[0]?.roblox_id) {
    await interaction.editReply(`Your PTB account is linked to **${accountResult.rows[0].roblox_username || "a Roblox account"}**.`);
    return;
  }
  if (!registrationConfig.ok) {
    await interaction.editReply(
      `PTB registration is not configured yet, so /register cannot set up your account. A PTB administrator must add these settings and restart the bot: ${registrationConfig.missing.join(", ")}.`,
    );
    return;
  }
  if (!registrationRolesReady) {
    await interaction.editReply("PTB registration is not ready: the Bloxlink and Registered roles could not be verified at startup (permissions or role position). Wait a minute and try /register again; if it still fails, a PTB administrator must fix the bot's Discord roles.");
    return;
  }

  let member;
  if (interaction.guild) {
    try {
      member = await interaction.guild.members.fetch(interaction.user.id);
    } catch {
      member = undefined;
    }
  }
  if (!member) {
    await interaction.editReply("Run `/register` in the PTB Discord server so PTB can check your Bloxlink link.");
    return;
  }

  const result = await handleGuildMemberUpdate.processVerifiedMember(member, { notify: false });
  if (result?.status === "registered" || result?.status === "existing_same") {
    const registeredAccount = await db.execute({
      sql: "SELECT roblox_id, roblox_username FROM accounts WHERE discord_id = ? LIMIT 1",
      args: [interaction.user.id],
    });
    const username = registeredAccount.rows[0]?.roblox_username;
    await interaction.editReply(username ? `Your Roblox account **${username}** is registered with PTB.` : "Your account is registered with PTB.");
    try {
      await interaction.user.send(username
        ? `Your Roblox account **${username}** is now registered with PTB.`
        : "Your account is now registered with PTB.");
    } catch (error) {
      console.warn("PTB could not send registration DM:", error?.message ?? "unknown error");
    }
  } else if (result?.status === "roblox_conflict") {
    await interaction.editReply("That Roblox account is already linked to another PTB account. Contact a PTB administrator if you think this is a mistake.");
  } else if (result?.status === "discord_conflict") {
    await interaction.editReply("Your Discord account already has a PTB account linked to a different Roblox identity. PTB has not changed that link. Contact a PTB administrator if you think this is a mistake.");
  } else if (result?.status === "conflict") {
    await interaction.editReply("PTB could not safely confirm your account link because another registration completed at the same time. Please contact a PTB administrator.");
  } else if (result?.status === "error" && /HTTP 404|did not return a verified Roblox ID/.test(result.error?.message ?? "")) {
    await interaction.editReply({
      content: "Bloxlink has not linked a Roblox account to you yet. Click **Verify with Bloxlink** below. After Bloxlink finishes, PTB will detect the link and register your account automatically.",
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Verify with Bloxlink").setStyle(ButtonStyle.Link).setURL(BLOXLINK_VERIFY_URL),
      )],
    });
  } else if (result?.status === "error") {
    await interaction.editReply("PTB could not complete registration right now (Bloxlink lookup or role assignment failed). Your Bloxlink verification is unchanged; please try again in a little while or contact a PTB administrator.");
  } else {
    // result is undefined only when registration is disabled for this request's
    // guild (for example /register used outside PTB's configured server).
    await interaction.editReply("PTB registration only works inside the PTB Discord server. Run `/register` there (the server where you verified with Bloxlink).");
  }
}
async function handleUnregister(interaction) {
  await interaction.deferReply(ephemeralReply);
  const result = await db.execute({
    sql: "UPDATE accounts SET roblox_id = NULL, roblox_username = NULL WHERE discord_id = ? AND roblox_id IS NOT NULL",
    args: [interaction.user.id],
  });
  if (Number(result.rowsAffected ?? 0) === 0) {
    await interaction.editReply("No account is linked.");
    return;
  }

  let roleNote = "";
  if (interaction.guild && process.env.REGISTERED_ROLE_ID) {
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (member.roles.cache.has(process.env.REGISTERED_ROLE_ID)) {
        await member.roles.remove(process.env.REGISTERED_ROLE_ID, "User disconnected their Roblox account from PTB");
      }
    } catch (error) {
      console.error("PTB could not remove Registered role after unlink:", error);
      roleNote = " I could not remove your Registered role, so please contact a server administrator.";
    }
  }

  await interaction.editReply(`Your Roblox account has been disconnected from PTB. Your PTB balance and transaction history were kept. Run /register to link an account again.${roleNote}`);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const registrationConfig = validateRegistrationConfig(process.env);
if (!registrationConfig.ok) console.error(`[PTB Config] Registration unavailable; set valid guild, role IDs, and Bloxlink API key: ${registrationConfig.missing.join(", ")}`);
let registrationRolesReady = false;
const handleGuildMemberUpdate = createRegistrationEventHandler({
  db,
  enabled: () => registrationConfig.ok && registrationRolesReady,
  guildId: process.env.GUILD_ID,
  verifiedRoleId: process.env.BLOXLINK_VERIFIED_ROLE_ID,
  registeredRoleId: process.env.REGISTERED_ROLE_ID,
  apiKey: process.env.BLOXLINK_API_KEY,
});
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => void handleGuildMemberUpdate(oldMember, newMember));
client.on(Events.MessageCreate, (message) => {
  void handleDepositTicketImage(db, message).catch((error) => console.error("PTB deposit receipt analysis failed:", error));
});

const INVITE_PERMISSIONS = 268_561_424; // Manage Channels, Manage Roles, View Channels, Send Messages, Manage Messages, Embed Links, Attach Files, Read Message History

client.once(Events.ClientReady, async (readyClient) => {
  discordReady = true;
  console.log(`Logged in as ${readyClient.user.tag}`);
  // Membership truth comes from the live gateway cache: registration can only
  // ever work in a server this bot account actually joined.
  const memberServers = readyClient.guilds.cache.map((guild) => `${guild.name} (${guild.id})`);
  console.log(`[PTB Config] Bot is a member of ${memberServers.length} server${memberServers.length === 1 ? "" : "s"}: ${memberServers.join(", ") || "none"}`);
  try {
    const ticketGuild = readyClient.guilds.cache.get(process.env.GUILD_ID) ?? readyClient.guilds.cache.first();
    if (ticketGuild) {
      const report = await validateTicketConfiguration(ticketGuild);
      if (report.problems.length) console.warn(`[PTB Ticket] Configuration warnings: ${report.problems.join("; ")}`);
      else console.log("[PTB Ticket] Category, staff roles, and log channel configuration verified.");
    }
  } catch (error) {
    console.warn("[PTB Ticket] Could not verify ticket configuration at startup:", error?.message ?? error);
  }
  if (!registrationConfig.ok) return;
  if (!readyClient.guilds.cache.has(process.env.GUILD_ID)) {
    console.error(`[PTB Config] GUILD_ID (${process.env.GUILD_ID}) is not a server this bot belongs to, so registration stays disabled.` +
      " Fix by copying the correct Server ID (Discord Developer Mode: right-click the server icon -> Copy Server ID) into GUILD_ID and restarting, or re-invite the bot to that exact server:" +
      ` https://discord.com/api/oauth2/authorize?client_id=${readyClient.application.id}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands`);
    return;
  }
  try {
    const guild = await readyClient.guilds.fetch(process.env.GUILD_ID);
    await guild.roles.fetch();
    const botMember = await guild.members.fetchMe();
    const readiness = validateRoleAssignmentAccess({
      hasManageRoles: botMember.permissions.has(PermissionFlagsBits.ManageRoles),
      botHighestPosition: botMember.roles.highest.position,
      verifiedRole: guild.roles.cache.get(process.env.BLOXLINK_VERIFIED_ROLE_ID),
      registeredRole: guild.roles.cache.get(process.env.REGISTERED_ROLE_ID),
    });
    if (!readiness.ok) {
      console.error("[PTB Config] Registration disabled due to Discord role configuration:", readiness.problems.join("; "));
      return;
    }
    registrationRolesReady = true;
    console.log("[PTB Config] Registration role permissions and hierarchy verified.");
  } catch (error) {
    console.error(`[PTB Config] Could not verify registration roles; registration remains disabled. ${error?.message ?? "unknown error"} (code ${error?.code ?? "?"})`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isModalSubmit() && interaction.customId.startsWith("tcm-close:")) {
    try { await handleTicketCloseModal(db, interaction); }
    catch (error) {
      console.error("PTB ticket close modal failed:", error);
      // Same strategy everywhere: reply if untouched, edit the deferred
      // response if pending, follow up once the first response was sent.
      await respond(interaction, { content: "I could not close this ticket right now. It keeps its current state, so you can safely retry.", ...ephemeralReply })
        .catch((replyError) => console.error("Could not send ticket close error reply:", replyError));
    }
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("trm-")) {
    try { await handleTreasuryModal(db, interaction, TREASURY_REVIEW_ROLES); }
    catch (error) {
      console.error("PTB treasury modal failed:", error);
      await respond(interaction, { content: "I could not process that treasury review action.", ...ephemeralReply })
        .catch((replyError) => console.error("Could not send treasury modal error reply:", replyError));
    }
    return;
  }
  if (interaction.isButton()) {
    const treasuryMatch = interaction.customId.match(/^trv-(approve|approve-confirm|reject|info|flag):(IRPT-\d+)$/);
    if (treasuryMatch) {
      try { await handleTreasuryButton(db, interaction, treasuryMatch[1], treasuryMatch[2], TREASURY_REVIEW_ROLES); }
      catch (error) {
        console.error("PTB treasury review failed:", error);
        await respond(interaction, { content: "I could not process that treasury review action.", ...ephemeralReply })
          .catch((replyError) => console.error("Could not send treasury button error reply:", replyError));
      }
      return;
    }
    const ticketDecisionMatch = interaction.customId.match(/^tkt-(approve|complete|reject):(\d+)$/);
    if (ticketDecisionMatch) {
      try {
        await handleTicketDecision(db, interaction, ticketDecisionMatch[1], ticketDecisionMatch[2]);
      } catch (error) {
        console.error("PTB ticket action failed:", error);
        await respond(interaction, {
          content: "I could not process that ticket action right now. The ticket keeps its recorded state, so retrying the same action is safe.",
          ...ephemeralReply,
        }).catch((replyError) => {
          console.error("Could not send ticket action error reply:", replyError);
        });
      }
      return;
    }

    const ticketCloseMatch = interaction.customId.match(/^ticket-close:(\d+)(?::(\d+))?$/);
    if (ticketCloseMatch) {
      await handleTicketCloseRequest(db, interaction, ticketCloseMatch[1], ticketCloseMatch[2] ?? null).catch(async (error) => {
        console.error("PTB ticket close button failed:", error);
        await respond(interaction, { content: "I could not close this ticket right now. It keeps its current state, so you can safely retry.", ...ephemeralReply })
          .catch((replyError) => console.error("Could not send ticket close error reply:", replyError));
      });
      return;
    }

    const historyMatch = interaction.customId.match(/^history:(\d+):(\d+)$/);
    if (historyMatch) {
      const [, ownerId, requestedPage] = historyMatch;
      await handleHistoryButton(db, interaction, ownerId, requestedPage);
      return;
    }

    try {
      await respond(interaction, {
        content: "That button is no longer available.",
        ...ephemeralReply,
      });
    } catch (replyError) {
      console.error("Could not acknowledge an unknown PTB button:", replyError);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    // Acknowledge within Discord's ~3s initial-response deadline even if the
    // registration check or the command's own database work is slow. On the
    // fast path nothing extra happens; on the slow path the interaction is
    // deferred (ephemerally) and made deferral-safe, so every reply() below
    // turns into editReply() and no handler sees "Unknown interaction".
    await acknowledgeWithinDeadline(interaction, () => runChatCommand(interaction), { deferOptions: ephemeralReply });
  } catch (error) {
    if (isExpiredInteractionError(error)) {
      console.warn(`[PTB Warning] Command /${interaction.commandName} interaction expired before response could be delivered:`, error?.message ?? error);
      return;
    }
    console.error(`Command /${interaction.commandName} failed:`, error);
    await respond(interaction, {
      content: "I could not complete that request right now. Please try again shortly.",
      ...ephemeralReply,
    }).catch((replyError) => {
      if (!isExpiredInteractionError(replyError)) {
        console.error("Could not send command error reply:", replyError);
      }
    });
  }
});

async function runChatCommand(interaction) {
  if (!["ping", "help", "register", "unregister"].includes(interaction.commandName) &&
      interaction.commandName !== "add-user" &&
      interaction.commandName !== "account-freeze" &&
      interaction.commandName !== "account-unfreeze" &&
      interaction.commandName !== "add-balance" &&
      !["treasury-search", "treasury-report", "treasury-total"].includes(interaction.commandName)) {
    const accountResult = await db.execute({
      sql: "SELECT 1 FROM accounts WHERE discord_id = ? AND roblox_id IS NOT NULL LIMIT 1",
      args: [interaction.user.id],
    });
    if (!accountResult.rows.length) {
      await respond(interaction, {
        content: "You need to run `/register` before using PTB commands.",
        ...ephemeralReply,
      });
      return;
    }
  }

  if (interaction.commandName === "help") {
    await handleHelp(interaction);
  } else if (interaction.commandName === "ping") {
    await respond(interaction, "pong");
  } else if (interaction.commandName === "register") {
    await handleRegister(interaction);
  } else if (interaction.commandName === "unregister") {
    await handleUnregister(interaction);
  } else if (interaction.commandName === "balance") {
    await handleBalance(db, interaction);
  } else if (interaction.commandName === "transaction" && interaction.options.getSubcommand() === "history") {
    await handleTransactionHistory(interaction);
  } else if (interaction.commandName === "deposit") {
    await handleMoneyRequest(db, interaction, "deposit");
  } else if (interaction.commandName === "withdraw") {
    await handleMoneyRequest(db, interaction, "withdraw");
  } else if (interaction.commandName === "add-user") {
    await handleAddUser(db, interaction, ticketConfig().staffRoleIds);
  } else if (interaction.commandName === "add-balance") {
    await handleAddBalance(db, interaction);
  } else if (interaction.commandName === "account-freeze") {
    await handleAccountFreeze(db, interaction);
  } else if (interaction.commandName === "account-unfreeze") {
    await handleAccountUnfreeze(db, interaction);
  } else if (interaction.commandName === "transfer") {
    await handleTransfer(db, interaction);
  } else if (interaction.commandName === "bill" || interaction.commandName === "tax") {
    await handleBillCommand(db, interaction, interaction.commandName);
  } else if (interaction.commandName === "treasury-submit") {
    await submitTreasuryPayment(db, interaction, { reviewChannelId: process.env.TREASURY_REVIEW_CHANNEL_ID, reviewerRoleIds: TREASURY_REVIEW_ROLES });
  } else if (interaction.commandName === "treasury-status") {
    await handleTreasuryStatus(db, interaction, interaction.options.getString("reference", true));
  } else if (interaction.commandName === "treasury-history") {
    await handleTreasuryHistory(db, interaction);
  } else if (interaction.commandName === "treasury-search") {
    await handleTreasurySearch(db, interaction, TREASURY_REVIEW_ROLES, interaction.options.getString("query", true));
  } else if (interaction.commandName === "treasury-report") {
    const from = interaction.options.getString("from");
    const to = interaction.options.getString("to");
    const validDate = (value) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
    if (!validDate(from) || !validDate(to) || (from && to && from > to)) await respond(interaction, { content: "Use valid dates in YYYY-MM-DD format, with from on or before to.", ...ephemeralReply });
    else await handleTreasuryReport(db, interaction, TREASURY_REVIEW_ROLES, { from, to });
  } else if (interaction.commandName === "treasury-total") {
    await handleTreasuryTotal(db, interaction, TREASURY_REVIEW_ROLES);
  }
}

const hasDiscordConfig = Boolean(
    process.env.DISCORD_TOKEN &&
    process.env.CLIENT_ID &&
    process.env.GUILD_ID,
);

async function initializeDatabase() {
  try {
    await db.batch([...schemaStatements, ...ticketSchemaStatements, ...ticketDepositSchemaStatements, ...recurringChargeSchemaStatements, ...treasurySchemaStatements], "write");
    // Adds amount_comparison to treasury tables created before the automatic
    // amount checker; fresh tables already include it and this call is idempotent.
    await ensureAmountComparisonColumn(db);
    await ensureFrozenUntilColumn(db);
    console.log("PTB ledger database initialized successfully.");
    return true;
  } catch (error) {
    console.error("PTB database initialization failed; Discord startup will continue and database-backed commands may be unavailable:", {
      name: error?.name ?? "Error",
      code: error?.code ?? "unknown",
      message: String(error?.message ?? "unknown error").replace(/(libsql:\/\/|https?:\/\/)[^\s)]+/gi, "[database endpoint]"),
    });
    return false;
  }
}

let databaseRetryRunning = false;
async function retryDatabaseInitialization() {
  if (databaseRetryRunning) return;
  databaseRetryRunning = true;
  try {
    const initialized = await initializeDatabase();
    if (initialized) clearInterval(databaseRetryTimer);
  } finally {
    databaseRetryRunning = false;
  }
}
let databaseRetryTimer;

async function startDiscord() {
  if (!hasDiscordConfig) {
    console.error("[PTB Startup] Discord gateway not started: missing required environment variables:",
      ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"].filter((name) => !process.env[name]).join(", "));
    return;
  }

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        {
          body: [
            helpCommand.toJSON(),
            pingCommand.toJSON(),
            registerCommand.toJSON(),
            unregisterCommand.toJSON(),
            balanceCommand.toJSON(),
            transactionCommand.toJSON(),
            depositCommand.toJSON(),
            withdrawCommand.toJSON(),
            addUserCommand.toJSON(),
            addBalanceCommand.toJSON(),
            accountFreezeCommand.toJSON(),
            accountUnfreezeCommand.toJSON(),
            transferCommand.toJSON(),
            billCommand.toJSON(),
            taxCommand.toJSON(),
            treasurySubmitCommand.toJSON(),
            treasuryStatusCommand.toJSON(),
            treasuryHistoryCommand.toJSON(),
            treasurySearchCommand.toJSON(),
            treasuryReportCommand.toJSON(),
            treasuryTotalCommand.toJSON(),
          ],
        },
      );
      console.log("Discord slash commands registered successfully.");
  } catch (error) {
    console.error("PTB slash-command registration failed; attempting gateway login so existing commands can still work:", {
      name: error?.name ?? "Error", code: error?.code ?? "unknown", message: error?.message ?? "unknown error",
    });
  }

  try {
      await client.login(process.env.DISCORD_TOKEN);
      console.log("Discord gateway login accepted; waiting for ClientReady.");

      let recurringChargesRunning = false;
      const runRecurringCharges = async () => {
        // A short network interruption should not leave the scheduled sweep
        // waiting for the next minute. Keep retries bounded so the interval
        // cannot pile up overlapping runs during a longer outage.
        if (recurringChargesRunning) return;
        recurringChargesRunning = true;
        try {
          await runRecurringChargesSweep(db, client);
        } finally {
          recurringChargesRunning = false;
        }
      };
      void runRecurringCharges();
      setInterval(runRecurringCharges, 60_000).unref();
  } catch (error) {
    console.error("PTB Discord gateway login failed:", {
      name: error?.name ?? "Error", code: error?.code ?? "unknown", message: error?.message ?? "unknown error",
    });
  }
}

if (!await initializeDatabase()) {
  console.warn("[PTB Startup] Retrying database initialization every 30 seconds until it succeeds.");
  databaseRetryTimer = setInterval(() => void retryDatabaseInitialization(), 30_000);
  databaseRetryTimer.unref();
}
await startDiscord();
