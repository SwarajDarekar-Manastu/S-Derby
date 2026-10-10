import type { Ctx } from "./main.ts";
import { forDiscord, isDiscordCode } from "./main.ts";
import { DECISION_AGENTS, statusBoard, warnings, type AgentSnapshot, type StatusInput } from "./render.ts";
import type { Agent, Comment, Issue } from "./paperclip.ts";

const OPEN_STATUSES = "in_progress,in_review,blocked,todo";

export async function gatherStatus(ctx: Ctx): Promise<StatusInput> {
  const { pc } = ctx;
  const [agents, live, open, dash, quota, pacing, runs] = await Promise.all([
    ctx.agents(true), pc.liveRuns(), pc.issues({ status: OPEN_STATUSES, limit: 500 }), pc.dashboard(),
    pc.quotaWindows().catch(() => []), pc.pacing(), pc.runs(),
  ]);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const snapshots: AgentSnapshot[] = await Promise.all(agents.map(async (agent): Promise<AgentSnapshot> => {
    const task = currentTask(open, agent);
    const statement = (DECISION_AGENTS as readonly string[]).includes(agent.name) ? await latestStatement(ctx, agent, task) : null;
    return {
      agent, task, statement,
      running: live.some((r) => r.agentId === agent.id),
      runsToday: runs.filter((r) => r.agentId === agent.id && Date.parse(r.createdAt) >= startOfDay.getTime()).length,
    };
  }));
  const usedProviders = [...new Set(pacing.agents.map((a) => a.provider).filter((p): p is string => Boolean(p)))];
  return {
    agents: snapshots, quota, pacing, usedProviders: usedProviders.length ? usedProviders : quota.map((q) => q.provider),
    counts: { ...dash.tasks, pendingApprovals: dash.pendingApprovals }, now: new Date().toISOString(),
  };
}

const RANK: Record<string, number> = { in_progress: 0, in_review: 1, blocked: 2, todo: 3 };

function currentTask(open: Issue[], agent: Agent): Issue | null {
  return open
    .filter((i) => i.assigneeAgentId === agent.id)
    .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
}

/** The agent's newest comment on its current task, else on its most recently updated task. */
async function latestStatement(ctx: Ctx, agent: Agent, task: Issue | null): Promise<Comment | null> {
  const issue = task ?? (await ctx.pc.issues({ assigneeAgentId: agent.id, limit: 1 }))[0];
  if (!issue) return null;
  const comments = await ctx.pc.lastComments(issue.id, 20);
  return comments.find((c) => (c.authorAgentId ?? c.derivedAuthorAgentId) === agent.id) ?? null;
}

export async function refreshStatus(ctx: Ctx): Promise<void> {
  const input = await gatherStatus(ctx);
  const channel = await ctx.channel("status");
  const payload = forDiscord(statusBoard(input));
  if (ctx.state.statusMessageId) {
    try {
      await channel.messages.edit(ctx.state.statusMessageId, payload);
    } catch (error) {
      if (!isDiscordCode(error, 10008)) throw error;
      ctx.state.statusMessageId = undefined; // deleted by someone: recreate below
    }
  }
  if (!ctx.state.statusMessageId) {
    const message = await channel.send(payload);
    await message.pin().catch(async (error) => {
      if (isDiscordCode(error, 50013)) await ctx.notice("⚠️ Missing permission Pin Messages in #status; the status board is posted but not pinned.");
      else throw error;
    });
    ctx.state.statusMessageId = message.id;
  }
  await sendWarnings(ctx, input);
}

async function sendWarnings(ctx: Ctx, input: StatusInput) {
  const current = warnings(input);
  const inbox = await ctx.channel("board-inbox");
  for (const w of current) {
    if (ctx.state.warned.includes(w.key)) continue;
    ctx.state.warned.push(w.key);
    await inbox.send({
      content: `${w.ping ? `<@${ctx.cfg.boardUserId}> ` : ""}⚠️ ${w.text}`,
      allowedMentions: w.ping ? { parse: [], users: [ctx.cfg.boardUserId] } : { parse: [] },
    });
  }
  // Paused/error warnings re-arm once the condition clears, with one line saying so.
  const live = new Set(current.map((w) => w.key));
  for (const key of ctx.state.warned.filter((k) => (k.startsWith("paced:") || k.startsWith("error:")) && !live.has(k))) {
    ctx.state.warned = ctx.state.warned.filter((k) => k !== key);
    const agent = input.agents.find((s) => key.includes(s.agent.id))?.agent.name ?? "An agent";
    await inbox.send({ content: `✅ ${agent} is ${key.startsWith("paced:") ? "no longer paused by pacing" : "out of error state"}.` });
  }
}

/** After a lost state file, find the pinned status message instead of posting a second one. */
export async function rebuildStatus(ctx: Ctx): Promise<void> {
  if (ctx.state.statusMessageId) return;
  const pinned = await (await ctx.channel("status")).messages.fetchPins().catch(() => null);
  const mine = pinned?.items.find((pin) => pin.message.author.id === ctx.client.user?.id);
  if (mine) ctx.state.statusMessageId = mine.message.id;
}
