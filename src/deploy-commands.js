import "dotenv/config";
import { REST, Routes } from "discord.js";
import { serverEmbedCommand } from "./ptb-embeds.js";

export { serverEmbedCommand };

/**
 * Deploy slash commands to Discord REST API.
 * @param {object} [options]
 * @param {string} [options.token]
 * @param {string} [options.clientId]
 * @param {string} [options.guildId]
 * @param {Array} [options.commands]
 * @returns {Promise<unknown>}
 */
export async function deployCommands({
  token = process.env.DISCORD_TOKEN,
  clientId = process.env.CLIENT_ID,
  guildId = process.env.GUILD_ID,
  commands = [serverEmbedCommand],
} = {}) {
  if (!token || !clientId) {
    throw new Error("Missing DISCORD_TOKEN or CLIENT_ID environment variables.");
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const body = commands.map((cmd) => (typeof cmd.toJSON === "function" ? cmd.toJSON() : cmd));

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  console.log(`[Deploy Commands] Registering ${body.length} slash commands...`);
  const data = await rest.put(route, { body });
  console.log("[Deploy Commands] Slash commands registered successfully.");
  return data;
}

export default serverEmbedCommand;
