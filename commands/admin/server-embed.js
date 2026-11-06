import {
  handleServerEmbedCommand,
  serverEmbedCommand,
} from "../../src/ptb-embeds.js";

export const data = serverEmbedCommand;
export const execute = handleServerEmbedCommand;

export default { data, execute };
