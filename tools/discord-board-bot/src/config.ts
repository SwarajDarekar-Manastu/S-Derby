export const CHANNELS = ["status", "board-inbox", "bot-status", "cto", "senior-dev", "validation", "release"] as const;
export type ChannelName = (typeof CHANNELS)[number];

/** Agent channels and the agent each one talks to. */
export const AGENT_CHANNELS: Partial<Record<ChannelName, string>> = {
  cto: "CTO", "senior-dev": "Senior Developer", validation: "Validation Engineer", release: "Release Manager",
};

export interface Config {
  discordToken: string;
  guildId: string;
  boardUserId: string;
  channels: Record<ChannelName, string>;
  paperclipUrl: string;
  boardKey: string;
  companyId: string;
  stateFile: string;
}

/** Read every setting up front and stop with the missing name, never later mid-run. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const discordToken = need("DISCORD_TOKEN");
  const guildId = need("DISCORD_GUILD_ID");
  const boardUserId = need("DISCORD_BOARD_USER_ID");
  let channels: Record<string, string>;
  try {
    channels = JSON.parse(need("DISCORD_CHANNELS")) as Record<string, string>;
  } catch (error) {
    throw new Error(`DISCORD_CHANNELS must be JSON mapping ${CHANNELS.join(", ")} to channel IDs (${(error as Error).message})`);
  }
  const missing = CHANNELS.filter((c) => !/^\d+$/.test(channels[c] ?? ""));
  if (missing.length) throw new Error(`DISCORD_CHANNELS is missing channel IDs for: ${missing.join(", ")}`);
  return {
    discordToken, guildId, boardUserId,
    channels: channels as Record<ChannelName, string>,
    paperclipUrl: need("PAPERCLIP_URL").replace(/\/$/, ""),
    boardKey: need("PAPERCLIP_BOARD_KEY"),
    companyId: need("PAPERCLIP_COMPANY_ID"),
    stateFile: env.BOT_STATE_FILE?.trim() || "bot-state.json",
  };
}
