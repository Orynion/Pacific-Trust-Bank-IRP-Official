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
import { getTransactionHistory, handleHistoryButton } from "./transaction-history.js";
import { handleBillCommand, processDueCharges, recurringChargeSchemaStatements, sendDueChargeReminders } from "./recurring-charges.js";
import {
  ephemeralReply,
  handleAddBalance,
  handleBalance,
  handleMoneyRequest,
  handleTransfer,
  schemaStatements,
} from "./bank-ops.js";
import { BLOXLINK_VERIFY_URL, createRegistrationEventHandler, validateRegistrationConfig, validateRoleAssignmentAccess } from "./bloxlink-registration.js";
import { handleTicketClose, handleTicketDecision, ticketSchemaStatements } from "./ticket-ops.js";
import { handleDepositTicketImage, handleTreasuryButton, handleTreasuryHistory, handleTreasuryModal, handleTreasuryReport, handleTreasurySearch, handleTreasuryStatus, handleTreasuryTotal, submitTreasuryPayment, treasurySchemaStatements } from "./treasury-ops.js";

const requiredEnv = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "TURSO_URL", "TURSO_AUTH_TOKEN"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length) {
  console.warn(`[PTB Info] Missing environment variables: ${missingEnv.join(", ")}`);
  console.warn("[PTB Info] Running with local SQLite fallback. Set Discord and Bloxlink configuration to connect.");
}
const port = Number(process.env.PORT || 3000);

let ready = false;

const healthServer = createServer((request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/health" || requestUrl.pathname === "/") {
      response.writeHead(ready ? 200 : 503, { "content-type": "text/plain; charset=utf-8" });
      response.end(ready ? "ok" : "starting");
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  } catch (error) {
    // A request-handler throw must never take the health server (or the bot) down.
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
const db = createClient({
  url: dbUrl,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
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
    .setDescription("PTB is a roleplay ledger for Emergency Hamburg RP. Commands below are limited to what your account can use.")
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
  void handleDepositTicketImage(db, message).catch((error) => console.error("PTB experimental deposit receipt detection failed:", error));
});

const INVITE_PERMISSIONS = 268_520_464; // Manage Channels, Manage Roles, View Channels, Send Messages, Embed Links, Read Message History

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  // Membership truth comes from the live gateway cache: registration can only
  // ever work in a server this bot account actually joined.
  const memberServers = readyClient.guilds.cache.map((guild) => `${guild.name} (${guild.id})`);
  console.log(`[PTB Config] Bot is a member of ${memberServers.length} server${memberServers.length === 1 ? "" : "s"}: ${memberServers.join(", ") || "none"}`);
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
  if (interaction.isModalSubmit() && interaction.customId.startsWith("trm-")) {
    try { await handleTreasuryModal(db, interaction, TREASURY_REVIEW_ROLES); }
    catch (error) { console.error("PTB treasury modal failed:", error); await interaction.reply({ content: "I could not process that treasury review action.", ...ephemeralReply }).catch(() => {}); }
    return;
  }
  if (interaction.isButton()) {
    const treasuryMatch = interaction.customId.match(/^trv-(approve|approve-confirm|reject|info|flag):(IRPT-\d+)$/);
    if (treasuryMatch) {
      try { await handleTreasuryButton(db, interaction, treasuryMatch[1], treasuryMatch[2], TREASURY_REVIEW_ROLES); }
      catch (error) { console.error("PTB treasury review failed:", error); await interaction.reply({ content: "I could not process that treasury review action.", ...ephemeralReply }).catch(() => {}); }
      return;
    }
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
      await handleTicketClose(db, interaction, ticketCloseMatch[1], ticketCloseMatch[2]).catch(async (error) => {
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
      await handleHistoryButton(db, interaction, ownerId, requestedPage);
      return;
    }

    try {
      await interaction.reply({
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
    if (interaction.commandName !== "register" && interaction.commandName !== "unregister" &&
        !["treasury-search", "treasury-report", "treasury-total"].includes(interaction.commandName)) {
      const accountResult = await db.execute({
        sql: "SELECT 1 FROM accounts WHERE discord_id = ? AND roblox_id IS NOT NULL LIMIT 1",
        args: [interaction.user.id],
      });
      if (!accountResult.rows.length) {
        await interaction.reply({
          content: "You need to run `/register` before using PTB commands.",
          ...ephemeralReply,
        });
        return;
      }
    }

    if (interaction.commandName === "help") {
      await handleHelp(interaction);
    } else if (interaction.commandName === "ping") {
      await interaction.reply("pong");
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
    } else if (interaction.commandName === "add-balance") {
      await handleAddBalance(db, interaction);
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
      if (!validDate(from) || !validDate(to) || (from && to && from > to)) await interaction.reply({ content: "Use valid dates in YYYY-MM-DD format, with from on or before to.", ...ephemeralReply });
      else await handleTreasuryReport(db, interaction, TREASURY_REVIEW_ROLES, { from, to });
    } else if (interaction.commandName === "treasury-total") {
      await handleTreasuryTotal(db, interaction, TREASURY_REVIEW_ROLES);
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
  await db.batch([...schemaStatements, ...ticketSchemaStatements, ...recurringChargeSchemaStatements, ...treasurySchemaStatements], "write");
  console.log("PTB ledger database initialized successfully.");

  const hasDiscordConfig = Boolean(
    process.env.DISCORD_TOKEN &&
    process.env.CLIENT_ID &&
    process.env.GUILD_ID,
  );

  if (hasDiscordConfig) {
    try {
      const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
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
            addBalanceCommand.toJSON(),
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

      await client.login(process.env.DISCORD_TOKEN);

      const runRecurringCharges = async () => {
        try {
          await sendDueChargeReminders(db, client);
          await processDueCharges(db, new Date(), client);
        } catch (error) {
          console.error("Recurring bill/tax processing failed:", error);
        }
      };
      void runRecurringCharges();
      setInterval(runRecurringCharges, 60_000).unref();
    } catch (discordError) {
      console.error("Discord bot login/command registration failed:", discordError.message || discordError);
    }
  } else {
    console.log("[PTB Standby] Discord credentials (DISCORD_TOKEN, CLIENT_ID, GUILD_ID) not fully configured in .env. Bot gateway on standby.");
  }

  ready = true;
} catch (error) {
  console.error("PTB startup database initialization failed:", error);
  ready = false;
}
