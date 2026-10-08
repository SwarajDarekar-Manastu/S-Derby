import { z } from "zod";
import type { QuotaWindow } from "./types/quota.js";

/**
 * Subscription pacing keeps agents that run on a provider subscription (a
 * Claude plan, a ChatGPT plan for Codex, a Google plan for Gemini) inside that
 * plan. For each plan that reports live usage windows (a short session window
 * and the week), it pauses that plan's agents when a rule fires, and resumes
 * the agents it paused once no rule applies to them, which happens when the
 * window resets. A plan that reports no windows is tracked but never paced.
 *
 * To support another subscription, add its provider (the `provider` its
 * adapter writes to cost events) to SUBSCRIPTION_PLAN_PROVIDERS and describe
 * it in SUBSCRIPTION_PLANS.
 */

export const SUBSCRIPTION_PLAN_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type SubscriptionPlanProvider = (typeof SUBSCRIPTION_PLAN_PROVIDERS)[number];

export interface SubscriptionPlanDefinition {
  /** Product name shown in the dashboard. */
  label: string;
  /** The adapter whose agents bill this plan when they have no API key. */
  adapterType: string;
  /** API-key variables; an agent that sets one is metered, not on the plan. */
  apiKeyEnvVars: string[];
  /**
   * Normalized quota-window labels (lowercase, alphanumerics only), or null
   * when the provider reports no plan usage, so the plan can't be paced.
   */
  sessionWindowLabel: string | null;
  weekWindowLabel: string | null;
  sessionWindowName: string;
  weekWindowName: string;
  sessionHours: number;
}

export const SUBSCRIPTION_PLANS: Record<SubscriptionPlanProvider, SubscriptionPlanDefinition> = {
  anthropic: {
    label: "Claude",
    adapterType: "claude_local",
    apiKeyEnvVars: ["ANTHROPIC_API_KEY"],
    sessionWindowLabel: "currentsession",
    weekWindowLabel: "currentweekallmodels",
    sessionWindowName: "Current session",
    weekWindowName: "Current week",
    sessionHours: 5,
  },
  openai: {
    label: "Codex",
    adapterType: "codex_local",
    apiKeyEnvVars: ["OPENAI_API_KEY"],
    sessionWindowLabel: "5hlimit",
    weekWindowLabel: "weeklylimit",
    sessionWindowName: "5-hour limit",
    weekWindowName: "Weekly limit",
    sessionHours: 5,
  },
  google: {
    label: "Gemini",
    adapterType: "gemini_local",
    apiKeyEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    sessionWindowLabel: null,
    weekWindowLabel: null,
    sessionWindowName: "Last 5 hours",
    weekWindowName: "Last 7 days",
    sessionHours: 5,
  },
};

/** Whether the provider reports live plan usage, which pacing needs. */
export function subscriptionPlanReportsUsage(provider: SubscriptionPlanProvider): boolean {
  const plan = SUBSCRIPTION_PLANS[provider];
  return plan.sessionWindowLabel !== null || plan.weekWindowLabel !== null;
}

export const SUBSCRIPTION_WEEK_WINDOW_HOURS = 7 * 24;

export const SUBSCRIPTION_PACING_RULES = ["weekly", "agent_limit", "session"] as const;
export type SubscriptionPacingRule = (typeof SUBSCRIPTION_PACING_RULES)[number];

export interface SubscriptionPlanPacing {
  /** When false, pacing only reports what it would do for this plan. */
  autoPause: boolean;
  /** Pause every agent on this plan when the session window reaches this percent. */
  sessionPauseAtPercent: number | null;
  /** Pause every agent on this plan when the week reaches this percent. */
  weeklyPauseAtPercent: number | null;
}

export interface SubscriptionPacingPolicy {
  plans: Record<SubscriptionPlanProvider, SubscriptionPlanPacing>;
  /** Per agent: the most of its plan's week, in percent, the agent may use. */
  agentWeeklyLimitPercent: Record<string, number>;
  /** Agents pacing never pauses. */
  exemptAgentIds: string[];
}

export const DEFAULT_SUBSCRIPTION_PLAN_PACING: SubscriptionPlanPacing = {
  autoPause: false,
  sessionPauseAtPercent: 90,
  weeklyPauseAtPercent: 95,
};

const percentSchema = z.number().int().min(1).max(100);

export const subscriptionPlanPacingSchema = z
  .object({
    autoPause: z.boolean(),
    sessionPauseAtPercent: percentSchema.nullable(),
    weeklyPauseAtPercent: percentSchema.nullable(),
  })
  .strict();

export const subscriptionPacingPolicySchema = z
  .object({
    plans: z
      .object({
        anthropic: subscriptionPlanPacingSchema,
        openai: subscriptionPlanPacingSchema,
        google: subscriptionPlanPacingSchema,
      })
      .strict(),
    agentWeeklyLimitPercent: z.record(z.string().uuid(), percentSchema),
    exemptAgentIds: z.array(z.string().uuid()).max(500),
  })
  .strict();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parsedOr<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function normalizePlanPacing(raw: unknown): SubscriptionPlanPacing {
  const source = asRecord(raw);
  const shape = subscriptionPlanPacingSchema.shape;
  return {
    autoPause: parsedOr(shape.autoPause, source.autoPause, DEFAULT_SUBSCRIPTION_PLAN_PACING.autoPause),
    sessionPauseAtPercent: parsedOr(
      shape.sessionPauseAtPercent,
      source.sessionPauseAtPercent,
      DEFAULT_SUBSCRIPTION_PLAN_PACING.sessionPauseAtPercent,
    ),
    weeklyPauseAtPercent: parsedOr(
      shape.weeklyPauseAtPercent,
      source.weeklyPauseAtPercent,
      DEFAULT_SUBSCRIPTION_PLAN_PACING.weeklyPauseAtPercent,
    ),
  };
}

/** Stored policies may be empty or partial; fill each missing or invalid field with its default. */
export function normalizeSubscriptionPacingPolicy(raw: unknown): SubscriptionPacingPolicy {
  const source = asRecord(raw);
  const plans = asRecord(source.plans);
  const shape = subscriptionPacingPolicySchema.shape;
  return {
    plans: {
      anthropic: normalizePlanPacing(plans.anthropic),
      openai: normalizePlanPacing(plans.openai),
      google: normalizePlanPacing(plans.google),
    },
    agentWeeklyLimitPercent: parsedOr(shape.agentWeeklyLimitPercent, source.agentWeeklyLimitPercent, {}),
    exemptAgentIds: parsedOr(shape.exemptAgentIds, source.exemptAgentIds, []),
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

function normalizeWindowLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function toPlanWindow(window: QuotaWindow | undefined): SubscriptionPlanWindow | null {
  if (!window || window.usedPercent == null || !window.resetsAt) return null;
  return { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
}

/** Pick a plan's session and week windows out of the provider's quota windows. */
export function findSubscriptionPlanWindows(
  provider: SubscriptionPlanProvider,
  windows: QuotaWindow[],
): SubscriptionPlanWindows {
  const plan = SUBSCRIPTION_PLANS[provider];
  const byLabel = new Map(windows.map((window) => [normalizeWindowLabel(window.label), window]));
  return {
    session: plan.sessionWindowLabel ? toPlanWindow(byLabel.get(plan.sessionWindowLabel)) : null,
    week: plan.weekWindowLabel ? toPlanWindow(byLabel.get(plan.weekWindowLabel)) : null,
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
  /** The agent's share of all tokens on this plan this week. */
  weeklySharePercent: number;
  /** Estimated percent of the plan's week the agent used: its share times the plan's weekly percent. */
  weeklyPlanPercent: number | null;
  limitPercent: number | null;
  /** The rule that wants this agent paused, or null when none does. */
  pause: SubscriptionPacingPause | null;
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Decide, for each agent on one plan, whether a rule wants it paused. When
 * several rules fire, the one whose window resets last wins, so the agent stays
 * paused until every reason has ended. The result does not depend on
 * `autoPause`; callers apply it only when auto-pause is on for that plan.
 */
export function evaluateSubscriptionPacing(input: {
  policy: SubscriptionPacingPolicy;
  provider: SubscriptionPlanProvider;
  plan: SubscriptionPlanWindows;
  agents: SubscriptionPacingAgentInput[];
}): SubscriptionPacingAgentEvaluation[] {
  const { policy, plan } = input;
  const thresholds = policy.plans[input.provider];
  const exempt = new Set(policy.exemptAgentIds);
  const totalTokens = input.agents.reduce((sum, agent) => sum + Math.max(0, agent.weeklyTokens), 0);

  return input.agents.map((agent) => {
    const share = totalTokens > 0 ? (Math.max(0, agent.weeklyTokens) / totalTokens) * 100 : 0;
    const weeklyPlanPercent = plan.week ? (share / 100) * plan.week.usedPercent : null;
    const limitPercent = policy.agentWeeklyLimitPercent[agent.agentId] ?? null;
    const isExempt = exempt.has(agent.agentId);

    const candidates: SubscriptionPacingPause[] = [];
    if (!isExempt) {
      if (plan.week && thresholds.weeklyPauseAtPercent != null && plan.week.usedPercent >= thresholds.weeklyPauseAtPercent) {
        candidates.push({
          rule: "weekly",
          observedPercent: plan.week.usedPercent,
          limitPercent: thresholds.weeklyPauseAtPercent,
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
      if (
        plan.session &&
        thresholds.sessionPauseAtPercent != null &&
        plan.session.usedPercent >= thresholds.sessionPauseAtPercent
      ) {
        candidates.push({
          rule: "session",
          observedPercent: plan.session.usedPercent,
          limitPercent: thresholds.sessionPauseAtPercent,
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
  /** The plan the agent bills, or null when pacing paused it but it no longer runs on a subscription. */
  provider: SubscriptionPlanProvider | null;
  status: string;
  pauseReason: string | null;
  pausedAt: string | null;
}

export interface SubscriptionPacingStatus {
  policy: SubscriptionPacingPolicy;
  /** Agents that run on a provider subscription, so pacing applies to them. */
  agents: SubscriptionPacingAgent[];
  lastSweep: {
    at: string;
    paused: number;
    resumed: number;
    /** Plans whose usage could not be read on this sweep, with the reason. */
    errors: Partial<Record<SubscriptionPlanProvider, string>>;
  } | null;
}
