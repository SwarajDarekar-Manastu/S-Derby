import { z } from "zod";
import type { QuotaWindow } from "./types/quota.js";

/**
 * Subscription pacing keeps agents that run on a Claude subscription inside
 * the plan. It reads the live plan windows Claude reports (the 5-hour session
 * and the week), pauses agents when a rule fires, and resumes the agents it
 * paused once no rule applies to them, which happens when the window resets.
 */

export const SUBSCRIPTION_PACING_RULES = ["weekly", "agent_limit", "session"] as const;
export type SubscriptionPacingRule = (typeof SUBSCRIPTION_PACING_RULES)[number];

export interface SubscriptionPacingPolicy {
  /** When false, pacing only reports what it would do. */
  autoPause: boolean;
  /** Pause every paced agent when the 5-hour session reaches this percent. */
  sessionPauseAtPercent: number | null;
  /** Pause every paced agent when the week reaches this percent. */
  weeklyPauseAtPercent: number | null;
  /** Per agent: the most of the weekly plan, in percent, the agent may use. */
  agentWeeklyLimitPercent: Record<string, number>;
  /** Agents pacing never pauses. */
  exemptAgentIds: string[];
}

export const DEFAULT_SUBSCRIPTION_PACING_POLICY: SubscriptionPacingPolicy = {
  autoPause: false,
  sessionPauseAtPercent: 90,
  weeklyPauseAtPercent: 95,
  agentWeeklyLimitPercent: {},
  exemptAgentIds: [],
};

const percentSchema = z.number().int().min(1).max(100);

export const subscriptionPacingPolicySchema = z
  .object({
    autoPause: z.boolean(),
    sessionPauseAtPercent: percentSchema.nullable(),
    weeklyPauseAtPercent: percentSchema.nullable(),
    agentWeeklyLimitPercent: z.record(z.string().uuid(), percentSchema),
    exemptAgentIds: z.array(z.string().uuid()).max(500),
  })
  .strict();

/** Stored policies may be empty or partial; fill each missing or invalid field with its default. */
export function normalizeSubscriptionPacingPolicy(raw: unknown): SubscriptionPacingPolicy {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const shape = subscriptionPacingPolicySchema.shape;
  const field = <K extends keyof SubscriptionPacingPolicy>(key: K): SubscriptionPacingPolicy[K] => {
    const parsed = shape[key].safeParse(source[key]);
    return parsed.success ? (parsed.data as SubscriptionPacingPolicy[K]) : DEFAULT_SUBSCRIPTION_PACING_POLICY[key];
  };
  return {
    autoPause: field("autoPause"),
    sessionPauseAtPercent: field("sessionPauseAtPercent"),
    weeklyPauseAtPercent: field("weeklyPauseAtPercent"),
    agentWeeklyLimitPercent: field("agentWeeklyLimitPercent"),
    exemptAgentIds: field("exemptAgentIds"),
  };
}

export interface SubscriptionPlanWindow {
  usedPercent: number;
  resetsAt: string;
}

export interface SubscriptionPlanWindows {
  session: SubscriptionPlanWindow | null;
  week: SubscriptionPlanWindow | null;
}

export const SUBSCRIPTION_SESSION_WINDOW_HOURS = 5;
export const SUBSCRIPTION_WEEK_WINDOW_HOURS = 7 * 24;

function normalizeWindowLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function toPlanWindow(window: QuotaWindow | undefined): SubscriptionPlanWindow | null {
  if (!window || window.usedPercent == null || !window.resetsAt) return null;
  return { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
}

/** Pick the session and all-models week windows out of Claude's quota windows. */
export function findSubscriptionPlanWindows(windows: QuotaWindow[]): SubscriptionPlanWindows {
  const byLabel = new Map(windows.map((window) => [normalizeWindowLabel(window.label), window]));
  return {
    session: toPlanWindow(byLabel.get("currentsession")),
    week: toPlanWindow(byLabel.get("currentweekallmodels")),
  };
}

/** The instant a plan window started: its reset time minus the window length. */
export function subscriptionPlanWindowStart(window: SubscriptionPlanWindow, hours: number): Date {
  return new Date(new Date(window.resetsAt).getTime() - hours * 60 * 60 * 1000);
}

export interface SubscriptionPacingAgentInput {
  agentId: string;
  /** Input plus output tokens this plan week. Cache reads are excluded. */
  weeklyTokens: number;
}

export interface SubscriptionPacingPause {
  rule: SubscriptionPacingRule;
  observedPercent: number;
  limitPercent: number;
  resumesAt: string;
}

export interface SubscriptionPacingAgentEvaluation {
  agentId: string;
  exempt: boolean;
  /** The agent's share of all paced agents' tokens this week. */
  weeklySharePercent: number;
  /** Estimated percent of the weekly plan the agent used: its share times the plan's weekly percent. */
  weeklyPlanPercent: number | null;
  limitPercent: number | null;
  /** The rule that wants this agent paused, or null when none does. */
  pause: SubscriptionPacingPause | null;
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Decide, for each paced agent, whether a rule wants it paused. When several
 * rules fire, the one whose window resets last wins, so the agent stays paused
 * until every reason has ended. The result does not depend on `autoPause`;
 * callers apply it only when auto-pause is on.
 */
export function evaluateSubscriptionPacing(input: {
  policy: SubscriptionPacingPolicy;
  plan: SubscriptionPlanWindows;
  agents: SubscriptionPacingAgentInput[];
}): SubscriptionPacingAgentEvaluation[] {
  const { policy, plan } = input;
  const exempt = new Set(policy.exemptAgentIds);
  const totalTokens = input.agents.reduce((sum, agent) => sum + Math.max(0, agent.weeklyTokens), 0);

  return input.agents.map((agent) => {
    const share = totalTokens > 0 ? (Math.max(0, agent.weeklyTokens) / totalTokens) * 100 : 0;
    const weeklyPlanPercent = plan.week ? (share / 100) * plan.week.usedPercent : null;
    const limitPercent = policy.agentWeeklyLimitPercent[agent.agentId] ?? null;
    const isExempt = exempt.has(agent.agentId);

    const candidates: SubscriptionPacingPause[] = [];
    if (!isExempt) {
      if (plan.week && policy.weeklyPauseAtPercent != null && plan.week.usedPercent >= policy.weeklyPauseAtPercent) {
        candidates.push({
          rule: "weekly",
          observedPercent: plan.week.usedPercent,
          limitPercent: policy.weeklyPauseAtPercent,
          resumesAt: plan.week.resetsAt,
        });
      }
      if (plan.week && limitPercent != null && weeklyPlanPercent != null && weeklyPlanPercent >= limitPercent) {
        candidates.push({
          rule: "agent_limit",
          observedPercent: roundOneDecimal(weeklyPlanPercent),
          limitPercent,
          resumesAt: plan.week.resetsAt,
        });
      }
      if (plan.session && policy.sessionPauseAtPercent != null && plan.session.usedPercent >= policy.sessionPauseAtPercent) {
        candidates.push({
          rule: "session",
          observedPercent: plan.session.usedPercent,
          limitPercent: policy.sessionPauseAtPercent,
          resumesAt: plan.session.resetsAt,
        });
      }
    }
    const pause = candidates.reduce<SubscriptionPacingPause | null>(
      (latest, candidate) =>
        !latest || new Date(candidate.resumesAt).getTime() > new Date(latest.resumesAt).getTime() ? candidate : latest,
      null,
    );

    return {
      agentId: agent.agentId,
      exempt: isExempt,
      weeklySharePercent: roundOneDecimal(share),
      weeklyPlanPercent: weeklyPlanPercent == null ? null : roundOneDecimal(weeklyPlanPercent),
      limitPercent,
      pause,
    };
  });
}

export interface SubscriptionPacingAgent {
  agentId: string;
  agentName: string;
  status: string;
  pauseReason: string | null;
  pausedAt: string | null;
}

export interface SubscriptionPacingStatus {
  policy: SubscriptionPacingPolicy;
  /** Agents that run on the Claude subscription, so pacing applies to them. */
  agents: SubscriptionPacingAgent[];
  lastSweep: {
    at: string;
    ok: boolean;
    error: string | null;
    paused: number;
    resumed: number;
  } | null;
}
