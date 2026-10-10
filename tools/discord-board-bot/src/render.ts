// Pure functions that turn Paperclip data into Discord message payloads.
// No I/O here, so every message the Board sees is unit-testable.
import type { Agent, AttentionItem, Comment, Decision, Interaction, Issue, Pacing, QuotaProvider } from "./paperclip.ts";

export const COLOR = { neutral: 0x5865f2, good: 0x3ba55c, warn: 0xfaa61a, bad: 0xed4245, muted: 0x4f545c } as const;
export const DECISION_AGENTS = ["CTO", "Senior Developer", "Validation Engineer", "Release Manager"] as const;
export const MAX_MESSAGE = 2000;

export interface Embed { title?: string; description?: string; color?: number; fields?: { name: string; value: string; inline?: boolean }[]; footer?: { text: string } }
export interface Button { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string; disabled?: boolean }
export interface Select { type: 3; custom_id: string; placeholder?: string; min_values?: number; max_values?: number; options: { label: string; value: string; description?: string }[] }
export interface Row { type: 1; components: (Button | Select)[] }
export interface Payload { content?: string; embeds?: Embed[]; components?: Row[]; allowed_mentions?: { parse: []; users?: string[] } }

const SECRET_PATTERNS = [/pcp_[A-Za-z0-9_]{8,}/g, /ghp_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /\bsk-[A-Za-z0-9_-]{16,}/g, /xox[abprs]-[A-Za-z0-9-]{10,}/g];

/** Blank out known token formats before any text leaves for Discord. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((out, re) => out.replace(re, "[redacted]"), text);
}

export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Split long text on paragraph, then line, then hard boundaries, keeping order. */
export function split(text: string, max = MAX_MESSAGE): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const at = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const end = at > max / 2 ? at : max;
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

const ts = (iso: string | null | undefined, style: "R" | "t" | "f" = "R") =>
  iso ? `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>` : "unknown";

function stateLine(agent: Agent, running: boolean): string {
  if (agent.status === "paused") return `⏸ paused (${pauseReasonText(agent.pauseReason)})`;
  if (agent.status === "error") return `⛔ error${agent.errorReason ? `: ${cut(agent.errorReason, 120)}` : ""}`;
  if (running || agent.status === "running") return "▶ running";
  return "idle";
}

export function pauseReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case "subscription_pacing": return "subscription pacing";
    case "manual": return "by the Board";
    case "budget": return "budget";
    case null: case undefined: return "no reason given";
    default: return reason.replaceAll("_", " ");
  }
}

export interface AgentSnapshot {
  agent: Agent;
  running: boolean;
  task: Issue | null;
  statement: Comment | null;
  runsToday: number;
}

export interface StatusInput {
  agents: AgentSnapshot[];
  quota: QuotaProvider[];
  pacing: Pacing;
  counts: { open: number; inProgress: number; blocked: number; done: number; pendingApprovals: number };
  usedProviders: string[];
  now: string;
}

export function dailyCap(agent: Agent): number | null {
  const hb = (agent.runtimeConfig?.heartbeat ?? {}) as Record<string, unknown>;
  const cap = hb.maxDailyRuns ?? hb.dailyRunLimit ?? hb.dailyRunCap ?? hb.maxRunsPerDay;
  return typeof cap === "number" ? cap : null;
}

export function concurrency(agent: Agent): number {
  const hb = (agent.runtimeConfig?.heartbeat ?? {}) as Record<string, unknown>;
  return typeof hb.maxConcurrentRuns === "number" ? hb.maxConcurrentRuns : 1;
}

/** The pinned #status message: one embed per decision agent, the team, subscription, tasks. */
export function statusBoard(input: StatusInput): Payload {
  const byName = new Map(input.agents.map((s) => [s.agent.name, s]));
  const cards: Embed[] = DECISION_AGENTS.flatMap((name) => {
    const s = byName.get(name);
    if (!s) return [];
    const cap = dailyCap(s.agent);
    const lines = [
      `**${stateLine(s.agent, s.running)}** · runs today ${s.runsToday}${cap === null ? "" : `/${cap}`}${cap !== null && s.runsToday >= cap ? " (cap reached)" : ""}`,
      s.task ? `Task: \`${s.task.identifier}\` ${cut(s.task.title, 80)} · ${s.task.status.replaceAll("_", " ")}` : "Task: idle, no task",
      s.statement ? `> ${cut(redact(s.statement.body).replace(/\s+/g, " "), 300)}\n${ts(s.statement.createdAt)}` : "_No statement yet_",
    ];
    return [{ title: name, description: lines.join("\n"), color: agentColor(s) }];
  });
  const team = input.agents
    .filter((s) => !(DECISION_AGENTS as readonly string[]).includes(s.agent.name))
    .map((s) => `**${s.agent.name}** · ${stateLine(s.agent, s.running)}${s.task ? ` · \`${s.task.identifier}\`` : ""}`);
  const subscription = subscriptionLines(input);
  const c = input.counts;
  return {
    content: `**S-Derby status** · updated ${ts(input.now)}`,
    embeds: [
      ...cards,
      { title: "Team", description: team.join("\n") || "No other agents", color: COLOR.muted },
      {
        title: "Subscription and tasks",
        description: [...subscription, "",
          `Tasks: ${c.open} open · ${c.inProgress} in progress · ${c.blocked} blocked · ${c.done} done`,
          `Pending approvals: ${c.pendingApprovals}`].join("\n"),
        color: COLOR.neutral,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function agentColor(s: AgentSnapshot): number {
  if (s.agent.status === "error") return COLOR.bad;
  if (s.agent.status === "paused") return COLOR.warn;
  if (s.running || s.agent.status === "running") return COLOR.good;
  return COLOR.muted;
}

function subscriptionLines(input: StatusInput): string[] {
  const lines: string[] = [];
  for (const provider of input.quota.filter((p) => input.usedProviders.includes(p.provider))) {
    if (!provider.ok) {
      lines.push(`**${provider.provider}**: quota unavailable`);
      continue;
    }
    const plan = input.pacing.policy.plans[provider.provider];
    for (const w of provider.windows.filter((w) => w.usedPercent !== null)) {
      lines.push(`**${provider.provider} · ${w.label}**: ${w.usedPercent}% · resets ${ts(w.resetsAt)}`);
    }
    if (plan?.autoPause) lines.push(`Pacing pauses agents at ${plan.sessionPauseAtPercent}% of the session and ${plan.weeklyPauseAtPercent}% of the week`);
  }
  const paced = input.agents.filter((s) => s.agent.pauseReason === "subscription_pacing").map((s) => s.agent.name);
  lines.push(paced.length ? `Paused by pacing: ${paced.join(", ")}` : "No agent paused by pacing");
  return lines;
}

/** Warnings derived from the same data as the board. Keys make each fire once per window. */
export interface Warning { key: string; text: string; ping: boolean }

export function warnings(input: StatusInput): Warning[] {
  const out: Warning[] = [];
  for (const provider of input.quota.filter((p) => p.ok && input.usedProviders.includes(p.provider))) {
    for (const w of provider.windows) {
      if (w.usedPercent === null) continue;
      const weekly = /week/i.test(w.label);
      const threshold = weekly ? 80 : 75;
      if (w.usedPercent >= threshold) {
        out.push({ key: `quota:${provider.provider}:${w.label}:${w.resetsAt}`, ping: false,
          text: `${provider.provider} ${w.label} is at ${w.usedPercent}% (resets ${ts(w.resetsAt)}).` });
      }
    }
  }
  for (const s of input.agents) {
    if (s.agent.status === "paused" && s.agent.pauseReason === "subscription_pacing") {
      out.push({ key: `paced:${s.agent.id}`, ping: true, text: `${s.agent.name} was paused by subscription pacing. Work has stopped until the window resets.` });
    }
    if (s.agent.status === "error") {
      out.push({ key: `error:${s.agent.id}:${s.agent.errorReason ?? ""}`, ping: true, text: `${s.agent.name} is in error state${s.agent.errorReason ? `: ${cut(s.agent.errorReason, 300)}` : ""}.` });
    }
  }
  return out;
}

// ---- Board inbox ----

/** Kinds that mention the Board so the phone gets a notification. */
export const PING_KINDS = new Set(["approval", "decision", "issue_thread_interaction"]);

const KIND_LABEL: Record<string, string> = {
  approval: "Approval", decision: "Decision", issue_thread_interaction: "Agent question", recovery_action: "Recovery hold",
  blocker_attention: "Blocked task", failed_run: "Failed run", budget_alert: "Budget alert", agent_error_alert: "Agent error",
  review: "Review", join_request: "Join request", productivity_review: "Productivity review",
};

export interface InboxDetail {
  decision?: Decision;
  interaction?: Interaction;
  approvalPayload?: Record<string, unknown> | null;
  agentNames: Map<string, string>;
  boardUserId: string;
}

/** Item IDs inside custom_ids stay under Discord's 100-character limit by using the subject ID. */
export function inboxMessage(item: AttentionItem, d: InboxDetail): Payload {
  const kind = KIND_LABEL[item.sourceKind] ?? item.sourceKind;
  const ownTitle = item.sourceKind === "issue_thread_interaction" ? d.interaction?.payload.title : undefined;
  const title = cut(redact(typeof ownTitle === "string" ? ownTitle : item.subject.title ?? kind), 240);
  const lines: string[] = [];
  const fields: Embed["fields"] = [];
  const components: Row[] = [];
  const detail = (item.detail ?? {}) as Record<string, unknown>;
  const by = (id: unknown) => (typeof id === "string" ? d.agentNames.get(id) : undefined);

  if (item.whyNow) lines.push(`_${item.whyNow}_`);
  if (item.sourceKind === "approval") {
    const p = d.approvalPayload ?? {};
    const summary = [p.summary, p.description, p.body, detail.summaryExcerpt].find((v) => typeof v === "string") as string | undefined;
    if (summary) lines.push(cut(redact(summary), 1500));
    const requester = by(item.subject.metadata?.requestedByAgentId);
    if (requester) fields.push({ name: "Requested by", value: requester, inline: true });
    fields.push({ name: "Type", value: String(item.subject.metadata?.type ?? "approval").replaceAll("_", " "), inline: true });
    components.push({ type: 1, components: [
      { type: 2, style: 3, label: "Approve", custom_id: `ap:${item.subject.id}:approve` },
      { type: 2, style: 4, label: "Reject", custom_id: `ap:${item.subject.id}:reject` },
    ] });
  } else if (item.sourceKind === "decision" && d.decision) {
    if (d.decision.body) lines.push(cut(redact(d.decision.body), 1500));
    lines.push(d.decision.options.map((o, n) => `**${n + 1}. ${o.label}**${o.description ? ` — ${cut(o.description, 200)}` : ""}`).join("\n"));
    if (d.decision.inputs?.length) lines.push(`_Choosing an option asks for: ${d.decision.inputs.map((i) => i.label).join(", ")}_`);
    const asker = by(item.subject.metadata?.originAgentId);
    if (asker) fields.push({ name: "Asked by", value: asker, inline: true });
    const buttons: Button[] = d.decision.options.slice(0, 10).map((o, n) => ({ type: 2, style: n === 0 ? 1 : 2, label: cut(`${n + 1}. ${o.label}`, 80), custom_id: `dc:${item.subject.id}:${n}` }));
    for (let n = 0; n < buttons.length; n += 5) components.push({ type: 1, components: buttons.slice(n, n + 5) });
  } else if (item.sourceKind === "issue_thread_interaction" && d.interaction) {
    const issueId = String(item.subject.metadata?.issueId ?? item.relatedIssue?.id ?? "");
    const ix = d.interaction;
    if (ix.kind === "request_confirmation") {
      lines.push(cut(redact(String(ix.payload.prompt ?? detail.promptExcerpt ?? "")), 1500));
      components.push({ type: 1, components: [
        { type: 2, style: 3, label: "Confirm", custom_id: `cf:${issueId}:${ix.id}:accept` },
        { type: 2, style: 4, label: "Decline", custom_id: `cf:${issueId}:${ix.id}:reject` },
      ] });
    } else if (ix.kind === "ask_user_questions") {
      const questions = (ix.payload.questions ?? []) as Question[];
      if (questions.length <= 4) {
        questions.forEach((q, n) => {
          lines.push(`**${n + 1}. ${cut(redact(q.prompt), 400)}**`);
          components.push({ type: 1, components: [{
            type: 3, custom_id: `qs:${issueId}:${ix.id}:${n}`, placeholder: cut(`Answer ${n + 1}`, 150),
            min_values: 1, max_values: q.selectionMode === "multiple" ? Math.min(25, q.options.length) : 1,
            options: q.options.slice(0, 25).map((o) => ({ label: cut(o.label, 100), value: o.id, ...(o.description ? { description: cut(o.description, 100) } : {}) })),
          }] });
        });
      } else {
        lines.push(`${questions.length} questions: too many for Discord. **Needs the desktop.**`);
      }
    } else {
      lines.push(`${ix.kind.replaceAll("_", " ")}: **needs the desktop.**`);
    }
  } else {
    const summary = Object.entries(detail).filter(([k, v]) => typeof v === "string" && k !== "kind").map(([, v]) => cut(redact(String(v)), 400));
    lines.push(...summary.slice(0, 3), "**Needs the desktop.**");
  }
  if (item.relatedIssue?.identifier) fields.push({ name: "Task", value: `\`${item.relatedIssue.identifier}\` ${cut(item.relatedIssue.title ?? "", 80)}`, inline: false });
  if (item.decideBy) fields.push({ name: "Decide by", value: ts(item.decideBy, "f"), inline: true });

  const ping = PING_KINDS.has(item.sourceKind);
  return {
    content: ping ? `<@${d.boardUserId}> ${kind} needs you` : `${kind}`,
    embeds: [{ title: `${kind}: ${title}`, description: cut(lines.join("\n\n"), 4000), color: severityColor(item.severity), fields,
      footer: { text: `desktop: ${item.relatedIssue?.identifier ?? item.subject.identifier ?? item.subject.kind} · item:${item.id}` } }],
    components,
    allowed_mentions: ping ? { parse: [], users: [d.boardUserId] } : { parse: [] },
  };
}

interface Question { id: string; prompt: string; selectionMode?: string; options: { id: string; label: string; description?: string | null; freeText?: boolean }[] }

function severityColor(severity: string): number {
  return severity === "critical" || severity === "high" ? COLOR.bad : severity === "medium" ? COLOR.warn : COLOR.neutral;
}

/** The same message after resolution: buttons gone, outcome stated. */
export function resolvedMessage(previous: Payload, outcome: string): Payload {
  const embed = previous.embeds?.[0] ?? {};
  return {
    content: previous.content?.replace(/<@\d+> /, ""),
    embeds: [{ ...embed, color: COLOR.muted, title: `✓ ${embed.title ?? ""}`, description: cut(`**${outcome}**\n\n${embed.description ?? ""}`, 4000) }],
    components: [],
    allowed_mentions: { parse: [] },
  };
}

// ---- Relay ----

export function threadName(issue: Pick<Issue, "identifier" | "title">): string {
  return cut(`${issue.identifier} ${issue.title}`, 100);
}

/** First line becomes the title (120 chars); the full text is the description. */
export function taskFromMessage(text: string): { title: string; description: string } {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return { title: cut(firstLine, 120), description: text.trim() };
}

export function commentAuthorAgentId(c: Comment): string | null {
  return c.authorAgentId ?? c.derivedAuthorAgentId ?? null;
}

export function statusNotice(issue: Pick<Issue, "identifier" | "status">, assignee: string | null, previous: { status: string; assignee: string | null }): string | null {
  const parts: string[] = [];
  if (issue.status !== previous.status) parts.push(`status → **${issue.status.replaceAll("_", " ")}**`);
  if (assignee !== previous.assignee) parts.push(`reassigned to **${assignee ?? "nobody"}**`);
  return parts.length ? `\`${issue.identifier}\` ${parts.join(" · ")}` : null;
}

// ---- Commands ----

export function taskSummary(issue: Issue, assignee: string | null, comments: Comment[], names: Map<string, string>): Payload {
  const recent = comments.slice(0, 5).reverse().map((c) => {
    const who = names.get(commentAuthorAgentId(c) ?? "") ?? "Board";
    return `**${who}** ${ts(c.createdAt)}\n${cut(redact(c.body), 350)}`;
  });
  return {
    embeds: [{
      title: cut(`${issue.identifier} ${issue.title}`, 256),
      description: cut([issue.description ? cut(redact(issue.description), 1200) : "_No description_", "", ...recent].join("\n"), 4000),
      fields: [
        { name: "Status", value: issue.status.replaceAll("_", " "), inline: true },
        { name: "Assignee", value: assignee ?? "nobody", inline: true },
        { name: "Priority", value: issue.priority ?? "medium", inline: true },
      ],
      color: COLOR.neutral,
    }],
    allowed_mentions: { parse: [] },
  };
}
