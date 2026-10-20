import "dotenv/config";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import {
  Client,
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
import { createRegistrationEventHandler, validateRegistrationConfig, validateRoleAssignmentAccess } from "./bloxlink-registration.js";
import { handleTicketClose, handleTicketDecision, ticketSchemaStatements } from "./ticket-ops.js";

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
  .setDescription("Check your PTB registration status or learn how to register.");

const verifyCommand = new SlashCommandBuilder()
  .setName("verify")
  .setDescription("Check your PTB link or learn how to register through Bloxlink.");

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
          "`/register` — Check your PTB registration or learn how to register.\nExample: `/register`",
          "`/verify` — Check your PTB link or learn how to register through Bloxlink.\nExample: `/verify`",
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

async function handleVerify(interaction) {
  const accountResult = await db.execute({
    sql: "SELECT roblox_username FROM accounts WHERE discord_id = ? LIMIT 1",
    args: [interaction.user.id],
  });
  if (accountResult.rows.length) {
    await interaction.reply({ content: `Your PTB account is linked to **${accountResult.rows[0].roblox_username || "a Roblox account"}**.`, ...ephemeralReply });
    return;
  }
  if (!registrationConfig.ok) {
    await interaction.reply({ content: "PTB account registration is not configured yet. Please contact a PTB administrator.", ...ephemeralReply });
    return;
  }
  await interaction.reply({ content: "First verify with Bloxlink in this server. PTB will register you after the configured Bloxlink verification role is added.", ...ephemeralReply });
}

async function handleRegister(interaction) {
  await handleVerify(interaction);
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
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

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  if (!registrationConfig.ok) return;
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
    console.error("[PTB Config] Could not verify registration roles; registration remains disabled.", error?.message ?? "unknown error");
  }
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
    } else if (interaction.commandName === "bill" || interaction.commandName === "tax") {
      await handleBillCommand(db, interaction, interaction.commandName);
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
            verifyCommand.toJSON(),
            balanceCommand.toJSON(),
            transactionCommand.toJSON(),
            depositCommand.toJSON(),
            withdrawCommand.toJSON(),
            addBalanceCommand.toJSON(),
            transferCommand.toJSON(),
            billCommand.toJSON(),
            taxCommand.toJSON(),
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
