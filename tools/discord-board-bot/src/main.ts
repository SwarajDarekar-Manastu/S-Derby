import { Client, DiscordAPIError, Events, GatewayIntentBits, REST, Routes, type Interaction, type TextChannel } from "discord.js";
import { AGENT_CHANNELS, loadConfig, type ChannelName, type Config } from "./config.ts";
import { paperclipClient, PaperclipError, PaperclipUnavailable, type Agent, type Paperclip } from "./paperclip.ts";
import { loadState, saveState, type State } from "./state.ts";
import { refreshStatus, rebuildStatus } from "./status.ts";
import { handleInboxInteraction, pollInbox, rebuildInbox } from "./inbox.ts";
import { ensureWebhooks, handleRelayMessage, pollRelay, rebuildThreads } from "./relay.ts";
import { commandDefinitions, handleCommand, handleCommandComponent } from "./commands.ts";
import type { Payload } from "./render.ts";

export interface Ctx {
  cfg: Config;
  pc: Paperclip;
  client: Client;
  state: State;
  save(): void;
  channel(name: ChannelName): Promise<TextChannel>;
  agents(fresh?: boolean): Promise<Agent[]>;
  agentByName(name: string): Promise<Agent | undefined>;
  notice(text: string): Promise<void>;
  health: { paperclipUp: boolean; failures: number; keyInvalid: boolean; readOnly: boolean };
}

/** discord.js takes camelCase allowedMentions; render.ts builds API-shaped payloads. */
export function forDiscord(p: Payload) {
  const { allowed_mentions, ...rest } = p;
  return { ...rest, allowedMentions: allowed_mentions ?? { parse: [] } };
}

export function isDiscordCode(error: unknown, code: number): boolean {
  return error instanceof DiscordAPIError && error.code === code;
}

async function main() {
  let cfg: Config;
  try {
    cfg = loadConfig(process.env);
  } catch (error) {
    console.error(`config error: ${(error as Error).message}`);
    process.exit(2);
  }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] },
  });
  const state = loadState(cfg.stateFile);
  let agentCache: { at: number; agents: Agent[] } = { at: 0, agents: [] };
  const channelCache = new Map<string, TextChannel>();

  const ctx: Ctx = {
    cfg, client, state,
    pc: paperclipClient(cfg.paperclipUrl, cfg.boardKey, cfg.companyId),
    save: () => saveState(cfg.stateFile, state),
    channel: async (name) => {
      const id = cfg.channels[name];
      const cached = channelCache.get(id);
      if (cached) return cached;
      const channel = (await client.channels.fetch(id)) as TextChannel | null;
      if (!channel) throw new Error(`channel #${name} (${id}) not found`);
      channelCache.set(id, channel);
      return channel;
    },
    agents: async (fresh = false) => {
      if (fresh || Date.now() - agentCache.at > 30_000) agentCache = { at: Date.now(), agents: await ctx.pc.agents() };
      return agentCache.agents;
    },
    agentByName: async (name) => (await ctx.agents()).find((a) => a.name.toLowerCase() === name.trim().toLowerCase()),
    notice: async (text) => {
      console.log(`[notice] ${text}`);
      await (await ctx.channel("bot-status")).send({ content: text, allowedMentions: { parse: [] } }).catch((e) => console.error("notice failed", e));
    },
    health: { paperclipUp: true, failures: 0, keyInvalid: false, readOnly: false },
  };

  client.once(Events.ClientReady, async (ready) => {
    console.log(`logged in as ${ready.user.tag}`);
    const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
    if (!guild) {
      console.error(`DISCORD_GUILD_ID ${cfg.guildId}: the bot is not in that server`);
      process.exit(2);
    }
    await new REST().setToken(cfg.discordToken).put(Routes.applicationGuildCommands(ready.user.id, cfg.guildId), { body: commandDefinitions() });
    // Startup recovery needs Paperclip; if it is down, run without it and let the loops catch up.
    try {
      await rebuildStatus(ctx);
      await rebuildInbox(ctx);
      await rebuildThreads(ctx);
      await ensureWebhooks(ctx);
      ctx.save();
      await ctx.notice(`Bot started · watching company \`${cfg.companyId.slice(0, 8)}\``);
    } catch (error) {
      console.error("startup recovery", error);
      await ctx.notice(`⚠️ Bot started, but startup recovery failed: ${(error as Error).message}`);
    }
    every(15_000, "inbox", () => pollInbox(ctx));
    every(10_000, "relay", () => pollRelay(ctx));
    every(60_000, "status", () => refreshStatus(ctx));
    every(60_000, "health", () => checkHealth(ctx));
    every(300_000, "alive", () => alive(ctx));
    every(3_600_000, "key-expiry", () => checkKeyExpiry(ctx));
    void refreshStatus(ctx).catch((e) => console.error("status", e));
    void alive(ctx);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete() || interaction.isChatInputCommand()) return await handleCommand(ctx, interaction);
      if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
      if (interaction.user.id !== cfg.boardUserId) {
        return await interaction.reply({ content: "Not allowed: this bot only acts for the S-Derby Board.", flags: 64 });
      }
      if (interaction.customId.startsWith("ag")) return await handleCommandComponent(ctx, interaction);
      return await handleInboxInteraction(ctx, interaction);
    } catch (error) {
      await reportInteractionError(ctx, interaction, error);
    }
  });

  client.on(Events.MessageCreate, (message) => {
    void handleRelayMessage(ctx, message).catch((error) => console.error("relay message", error));
  });

  const shutdown = () => {
    ctx.save();
    void client.destroy().finally(() => process.exit(0));
  };
  // A stray Discord or Paperclip rejection is logged, never fatal: the loops retry on their own.
  process.on("unhandledRejection", (error) => console.error("unhandled rejection", error));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await client.login(cfg.discordToken);
  } catch (error) {
    const message = (error as Error).message;
    if (/disallowed intents/i.test(message)) {
      console.error("config error: turn on Message Content Intent (Developer Portal > Bot > Privileged Gateway Intents) and save");
    } else if (/invalid token/i.test(message)) {
      console.error("config error: DISCORD_TOKEN was rejected by Discord; reset it in the Developer Portal");
    } else throw error;
    process.exit(2);
  }

  function every(ms: number, name: string, fn: () => Promise<void>) {
    let busy = false;
    setInterval(async () => {
      if (busy || (ctx.health.keyInvalid && name !== "health")) return;
      busy = true;
      try {
        await fn();
        ctx.save();
      } catch (error) {
        await handleLoopError(ctx, name, error);
      } finally {
        busy = false;
      }
    }, ms);
  }
}

/** Every Paperclip failure is classified once here, so loops and handlers stay simple. */
export async function handleLoopError(ctx: Ctx, name: string, error: unknown) {
  if (error instanceof PaperclipUnavailable) return; // the health loop reports outages
  if (error instanceof PaperclipError && error.status === 401) return markKeyInvalid(ctx);
  console.error(`[${name}]`, error);
}

export async function markKeyInvalid(ctx: Ctx) {
  if (ctx.health.keyInvalid) return;
  ctx.health.keyInvalid = true;
  await ctx.notice("⛔ The board API key was rejected (expired or revoked). The bot has stopped acting. Create a new key, update the env file and restart the bot.");
}

async function reportInteractionError(ctx: Ctx, interaction: Interaction, error: unknown) {
  let text: string;
  if (error instanceof PaperclipUnavailable) text = "Paperclip is unavailable right now. Try again in a minute.";
  else if (error instanceof PaperclipError && error.status === 401) {
    await markKeyInvalid(ctx);
    text = "The board key was rejected; see #bot-status.";
  } else if (error instanceof PaperclipError) text = `Paperclip said: ${error.reason}`;
  else {
    console.error("interaction", error);
    text = `Something went wrong: ${(error as Error).message}`;
  }
  if (!interaction.isRepliable()) return;
  const payload = { content: text, flags: 64 } as const;
  await (interaction.replied || interaction.deferred ? interaction.followUp(payload) : interaction.reply(payload)).catch(() => undefined);
}

async function checkHealth(ctx: Ctx) {
  const up = await ctx.pc.health().then(() => true, () => false);
  if (up) {
    if (!ctx.health.paperclipUp) await ctx.notice("✅ Paperclip is back.");
    ctx.health.paperclipUp = true;
    ctx.health.failures = 0;
    if (ctx.health.keyInvalid) {
      const keyOk = await ctx.pc.myKeys().then(() => true, () => false);
      if (keyOk) {
        ctx.health.keyInvalid = false;
        await ctx.notice("✅ The board key works again; resuming.");
      }
    }
    return;
  }
  ctx.health.failures += 1;
  // Two failed checks in a row: a normal deploy restart does not raise an alarm.
  if (ctx.health.failures === 2 && ctx.health.paperclipUp) {
    ctx.health.paperclipUp = false;
    await ctx.notice("⚠️ Paperclip is not responding (2 checks in a row). Buttons and commands will fail until it is back.");
  }
}

async function checkKeyExpiry(ctx: Ctx) {
  const name = process.env.PAPERCLIP_BOARD_KEY_NAME ?? "discord-board-bot";
  const key = (await ctx.pc.myKeys()).find((k) => k.name === name && !k.revokedAt);
  if (!key?.expiresAt) return;
  const days = (Date.parse(key.expiresAt) - Date.now()) / 86_400_000;
  const warnKey = `key-expiry:${key.id}`;
  if (days < 7 && !ctx.state.warned.includes(warnKey)) {
    ctx.state.warned.push(warnKey);
    await ctx.notice(`⚠️ The board key \`${name}\` expires <t:${Math.floor(Date.parse(key.expiresAt) / 1000)}:R>. Create a new one before then.`);
  }
}

async function alive(ctx: Ctx) {
  const channel = await ctx.channel("bot-status");
  const content = `🟢 alive at <t:${Math.floor(Date.now() / 1000)}:t> · Paperclip ${ctx.health.paperclipUp ? "up" : "down"}${ctx.health.keyInvalid ? " · key rejected" : ""}`;
  if (ctx.state.aliveMessageId) {
    const edited = await channel.messages.edit(ctx.state.aliveMessageId, { content }).then(() => true, () => false);
    if (edited) return;
  }
  ctx.state.aliveMessageId = (await channel.send({ content })).id;
  ctx.save();
}

if (import.meta.main) await main();
