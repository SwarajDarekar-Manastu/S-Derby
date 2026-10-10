import { AttachmentBuilder, ThreadAutoArchiveDuration, type Message, type Webhook } from "discord.js";
import { AGENT_CHANNELS, type ChannelName } from "./config.ts";
import type { Ctx } from "./main.ts";
import { isDiscordCode } from "./main.ts";
import { PaperclipError, type Comment, type Issue } from "./paperclip.ts";
import { commentAuthorAgentId, redact, split, statusNotice, taskFromMessage, threadName } from "./render.ts";

const WEBHOOK_NAME = "S-Derby relay";
const FILE_THRESHOLD = 8000;
/** Issues with a Board comment request in flight: their new comment may not be in ownComments yet. */
const commentsInFlight = new Set<string>();
const webhookCache = new Map<string, Webhook>();

function agentChannelOf(ctx: Ctx, channelId: string | null | undefined): ChannelName | undefined {
  return (Object.keys(AGENT_CHANNELS) as ChannelName[]).find((name) => ctx.cfg.channels[name] === channelId);
}

/** A Board message in an agent channel starts a task; a reply in its thread becomes a comment. */
export async function handleRelayMessage(ctx: Ctx, message: Message): Promise<void> {
  if (message.system || message.author.bot || message.webhookId) return; // never relay our own output or Discord notices
  const inThread = message.channel.isThread();
  const channelName = agentChannelOf(ctx, inThread ? message.channel.parentId : message.channelId);
  if (!channelName) return;
  if (message.author.id !== ctx.cfg.boardUserId) return void message.react("⛔").catch(() => undefined);
  const text = message.content.trim();
  if (!text) return void message.reply({ content: "Text is required; attachments are not supported yet.", allowedMentions: { parse: [] } });

  try {
    if (inThread) {
      const issueId = Object.entries(ctx.state.threads).find(([, t]) => t.threadId === message.channelId)?.[0];
      if (!issueId) return void message.reply({ content: "This thread is not linked to a Paperclip task.", allowedMentions: { parse: [] } });
      const before = ctx.state.threads[issueId].status;
      commentsInFlight.add(issueId);
      try {
        const comment = await ctx.pc.comment(issueId, text);
        ctx.state.ownComments.push(comment.id);
        ctx.save();
      } finally {
        commentsInFlight.delete(issueId);
      }
      await message.react("✅");
      if (before === "done") await message.channel.send({ content: "↩️ Task reopened and the agent was woken.", allowedMentions: { parse: [] } });
      return;
    }
    const agent = await ctx.agentByName(AGENT_CHANNELS[channelName] ?? "");
    if (!agent) return void message.reply({ content: `Agent ${AGENT_CHANNELS[channelName]} was not found in Paperclip.`, allowedMentions: { parse: [] } });
    if (agent.status === "terminated") return void message.reply({ content: `${agent.name} is terminated; messages here are not delivered.`, allowedMentions: { parse: [] } });
    const issue = await ctx.pc.createIssue({ ...taskFromMessage(text), assigneeAgentId: agent.id });
    const thread = await message.startThread({ name: threadName(issue), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
    ctx.state.threads[issue.id] = { threadId: thread.id, channel: channelName, status: issue.status, assigneeAgentId: agent.id };
    ctx.save();
    const paused = agent.status === "paused" ? ` ${agent.name} is paused, so it starts after \`/agent resume\`.` : "";
    await thread.send({ content: `Created \`${issue.identifier}\` for ${agent.name}. Replies here go to the task.${paused}`, allowedMentions: { parse: [] } });
  } catch (error) {
    if (error instanceof PaperclipError) {
      return void message.reply({ content: `Paperclip said: ${error.reason}`, allowedMentions: { parse: [] } });
    }
    throw error;
  }
}

/** Relay new comments and status changes on tracked tasks into their threads. */
export async function pollRelay(ctx: Ctx): Promise<void> {
  const tracked = ctx.state.threads;
  if (!Object.keys(tracked).length) return;
  // The cursor is saved, so issues that changed while the bot was down are caught up after a restart.
  const cursor = ctx.state.relayCursor ?? new Date(Date.now() - 60_000).toISOString();
  const since = new Date(Date.parse(cursor) - 30_000).toISOString(); // overlap: comment cursors prevent duplicates
  const pollStarted = new Date().toISOString();
  const changed = (await ctx.pc.issues({ updatedSince: since, limit: 500 })).filter((i) => tracked[i.id] && !commentsInFlight.has(i.id));
  for (const issue of changed) await relayIssue(ctx, issue);
  if (!changed.some((i) => commentsInFlight.has(i.id))) ctx.state.relayCursor = pollStarted;
}

async function relayIssue(ctx: Ctx, issue: Issue) {
  const link = ctx.state.threads[issue.id];
  const names = new Map((await ctx.agents()).map((a) => [a.id, a.name]));
  const comments = await newComments(ctx, issue.id, link.lastCommentId);
  for (const comment of comments) {
    if (!ctx.state.ownComments.includes(comment.id)) {
      const agentId = commentAuthorAgentId(comment);
      await post(ctx, link, agentId ? names.get(agentId) ?? "Agent" : "Board (web)", comment.body);
    }
    link.lastCommentId = comment.id; // only after delivery: a failed post is retried next poll
    ctx.save();
  }
  const assignee = issue.assigneeAgentId ? names.get(issue.assigneeAgentId) ?? "an agent" : null;
  const previousAssignee = link.assigneeAgentId ? names.get(link.assigneeAgentId) ?? "an agent" : null;
  const notice = statusNotice(issue, assignee, { status: link.status, assignee: previousAssignee });
  if (notice) await post(ctx, link, null, notice);
  link.status = issue.status;
  link.assigneeAgentId = issue.assigneeAgentId ?? null;
  ctx.save();
}

/** Comments after the cursor. If the cursor comment was deleted Paperclip returns [], so fall back to the newest few. */
async function newComments(ctx: Ctx, issueId: string, after: string | undefined): Promise<Comment[]> {
  if (!after) return ctx.pc.comments(issueId);
  const page = await ctx.pc.comments(issueId, after);
  if (page.length) return page;
  const recent = (await ctx.pc.lastComments(issueId, 20)).reverse();
  const at = recent.findIndex((c) => c.id === after);
  return at >= 0 ? recent.slice(at + 1) : [];
}

/** Agent text goes through the channel webhook under the agent's name; notices come from the bot. */
async function post(ctx: Ctx, link: Ctx["state"]["threads"][string], author: string | null, raw: string) {
  const text = redact(raw);
  const thread = await ctx.client.channels.fetch(link.threadId).catch(() => null);
  if (!thread?.isThread()) return; // thread deleted by hand: nothing to post into
  if (author === null) return void thread.send({ content: text, allowedMentions: { parse: [] } });
  const parts = split(author === "Board (web)" ? `**Board (web):** ${text}` : text);
  const files = text.length > FILE_THRESHOLD ? [new AttachmentBuilder(Buffer.from(text), { name: "full-reply.md" })] : [];
  const shown = files.length ? [`${parts[0]}\n\n_Full reply attached._`] : parts;
  for (const [n, content] of shown.entries()) {
    const payload = { content, username: author.slice(0, 80), threadId: link.threadId, allowedMentions: { parse: [] as never[] },
      files: n === shown.length - 1 ? files : [] };
    try {
      await (await webhook(ctx, link.channel as ChannelName)).send(payload);
    } catch (error) {
      if (!isDiscordCode(error, 10015)) throw error;
      delete ctx.state.webhooks[link.channel]; // webhook deleted by hand: recreate once and retry
      await ensureWebhooks(ctx);
      await (await webhook(ctx, link.channel as ChannelName)).send(payload);
    }
  }
}

async function webhook(ctx: Ctx, channel: ChannelName): Promise<Webhook> {
  const w = ctx.state.webhooks[channel];
  if (!w) throw new Error(`no webhook for #${channel}; check the Manage Webhooks permission`);
  const key = `${w.id}:${w.token}`;
  const hook = webhookCache.get(key) ?? (await ctx.client.fetchWebhook(w.id, w.token));
  webhookCache.set(key, hook);
  return hook;
}

/** One webhook per agent channel, created with that agent's avatar (Paperclip serves it on localhost only). */
export async function ensureWebhooks(ctx: Ctx): Promise<void> {
  for (const [name, agentName] of Object.entries(AGENT_CHANNELS) as [ChannelName, string][]) {
    if (ctx.state.webhooks[name]) continue;
    try {
      const channel = await ctx.channel(name);
      const existing = (await channel.fetchWebhooks()).find((w) => w.name === WEBHOOK_NAME && w.owner?.id === ctx.client.user?.id && w.token);
      const created = existing ?? (await channel.createWebhook({ name: WEBHOOK_NAME, avatar: await agentAvatar(ctx, agentName) }));
      ctx.state.webhooks[name] = { id: created.id, token: created.token ?? "" };
    } catch (error) {
      if (isDiscordCode(error, 50013)) await ctx.notice(`⚠️ Missing permission Manage Webhooks in #${name}; agent replies there cannot be relayed.`);
      else throw error;
    }
  }
}

async function agentAvatar(ctx: Ctx, agentName: string): Promise<Buffer | undefined> {
  const agent = await ctx.agentByName(agentName);
  if (!agent?.avatarUrl) return undefined;
  const res = await fetch(new URL(agent.avatarUrl, ctx.cfg.paperclipUrl), { headers: { authorization: `Bearer ${ctx.cfg.boardKey}` } }).catch(() => null);
  return res?.ok ? Buffer.from(await res.arrayBuffer()) : undefined;
}

/** After a lost state file, re-link threads by the task identifier at the start of each thread name. */
export async function rebuildThreads(ctx: Ctx): Promise<void> {
  if (Object.keys(ctx.state.threads).length) return;
  for (const name of Object.keys(AGENT_CHANNELS) as ChannelName[]) {
    const channel = await ctx.channel(name);
    const active = await channel.threads.fetchActive().catch(() => null);
    for (const thread of active?.threads.values() ?? []) {
      const identifier = thread.name.split(" ")[0];
      const issue = await ctx.pc.issue(identifier).catch(() => null);
      if (!issue) continue;
      const last = (await ctx.pc.lastComments(issue.id, 1))[0];
      ctx.state.threads[issue.id] = { threadId: thread.id, channel: name, lastCommentId: last?.id, status: issue.status, assigneeAgentId: issue.assigneeAgentId ?? null };
    }
  }
}
