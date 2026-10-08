import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBSCRIPTION_PLAN_PACING,
  evaluateSubscriptionPacing,
  findSubscriptionPlanWindows,
  normalizeSubscriptionPacingPolicy,
  subscriptionPlanReportsUsage,
  type SubscriptionPacingPolicy,
  type SubscriptionPlanPacing,
} from "./subscription-pacing.js";

const CTO = "11111111-1111-4111-8111-111111111111";
const DEV = "22222222-2222-4222-8222-222222222222";
const SESSION_RESET = "2026-10-08T15:50:00.000Z";
const WEEK_RESET = "2026-10-08T23:00:00.000Z";

function policy(
  claude: Partial<SubscriptionPlanPacing> = {},
  overrides: Partial<Omit<SubscriptionPacingPolicy, "plans">> = {},
): SubscriptionPacingPolicy {
  return {
    plans: {
      anthropic: { ...DEFAULT_SUBSCRIPTION_PLAN_PACING, autoPause: true, ...claude },
      openai: DEFAULT_SUBSCRIPTION_PLAN_PACING,
      google: DEFAULT_SUBSCRIPTION_PLAN_PACING,
    },
    agentWeeklyLimitPercent: {},
    exemptAgentIds: [],
    ...overrides,
  };
}

function plan(sessionPercent: number, weekPercent: number) {
  return {
    session: { usedPercent: sessionPercent, resetsAt: SESSION_RESET },
    week: { usedPercent: weekPercent, resetsAt: WEEK_RESET },
  };
}

const agents = [
  { agentId: CTO, weeklyTokens: 750_000 },
  { agentId: DEV, weeklyTokens: 250_000 },
];

describe("evaluateSubscriptionPacing", () => {
  it("pauses nobody while the plan is under every threshold, and splits the week by token share", () => {
    const result = evaluateSubscriptionPacing({ policy: policy(), provider: "anthropic", plan: plan(30, 60), agents });

    expect(result).toEqual([
      { agentId: CTO, exempt: false, weeklySharePercent: 75, weeklyPlanPercent: 45, limitPercent: null, pause: null },
      { agentId: DEV, exempt: false, weeklySharePercent: 25, weeklyPlanPercent: 15, limitPercent: null, pause: null },
    ]);
  });

  it("pauses every agent on the plan until the session resets when the session reaches its threshold", () => {
    const result = evaluateSubscriptionPacing({ policy: policy(), provider: "anthropic", plan: plan(92, 60), agents });

    expect(result.map((row) => row.pause)).toEqual([
      { rule: "session", observedPercent: 92, limitPercent: 90, resumesAt: SESSION_RESET },
      { rule: "session", observedPercent: 92, limitPercent: 90, resumesAt: SESSION_RESET },
    ]);
  });

  it("uses the thresholds of the plan being evaluated", () => {
    const codexStrict = policy({}, {});
    codexStrict.plans.openai = { autoPause: true, sessionPauseAtPercent: 50, weeklyPauseAtPercent: null };

    expect(
      evaluateSubscriptionPacing({ policy: codexStrict, provider: "openai", plan: plan(60, 99), agents })[0]?.pause,
    ).toEqual({ rule: "session", observedPercent: 60, limitPercent: 50, resumesAt: SESSION_RESET });
    expect(
      evaluateSubscriptionPacing({ policy: codexStrict, provider: "anthropic", plan: plan(60, 70), agents })[0]?.pause,
    ).toBeNull();
  });

  it("never pauses an exempt agent", () => {
    const result = evaluateSubscriptionPacing({
      policy: policy({}, { exemptAgentIds: [DEV] }),
      provider: "anthropic",
      plan: plan(95, 97),
      agents,
    });

    expect(result[1]).toEqual({
      agentId: DEV,
      exempt: true,
      weeklySharePercent: 25,
      weeklyPlanPercent: 24.3,
      limitPercent: null,
      pause: null,
    });
    expect(result[0]?.pause?.rule).toBe("weekly");
  });

  it("pauses only the agent over its weekly limit, until the week resets", () => {
    const result = evaluateSubscriptionPacing({
      policy: policy({}, { agentWeeklyLimitPercent: { [CTO]: 40, [DEV]: 40 } }),
      provider: "anthropic",
      plan: plan(30, 60),
      agents,
    });

    expect(result.map((row) => row.pause)).toEqual([
      { rule: "agent_limit", observedPercent: 45, limitPercent: 40, resumesAt: WEEK_RESET },
      null,
    ]);
  });

  it("keeps the rule whose window resets last when several fire", () => {
    const result = evaluateSubscriptionPacing({
      policy: policy({}, { agentWeeklyLimitPercent: { [CTO]: 10 } }),
      provider: "anthropic",
      plan: plan(95, 96),
      agents: [{ agentId: CTO, weeklyTokens: 100 }],
    });

    expect(result[0]?.pause).toEqual({ rule: "weekly", observedPercent: 96, limitPercent: 95, resumesAt: WEEK_RESET });
  });

  it("pauses nobody when the provider reports no plan windows", () => {
    const result = evaluateSubscriptionPacing({
      policy: policy({}, { agentWeeklyLimitPercent: { [CTO]: 1 } }),
      provider: "anthropic",
      plan: { session: null, week: null },
      agents,
    });

    expect(result.map((row) => [row.weeklySharePercent, row.weeklyPlanPercent, row.pause])).toEqual([
      [75, null, null],
      [25, null, null],
    ]);
  });
});

describe("findSubscriptionPlanWindows", () => {
  it("picks Claude's session and all-models week windows by label", () => {
    expect(
      findSubscriptionPlanWindows("anthropic", [
        { label: "Current session", usedPercent: 31, resetsAt: SESSION_RESET, valueLabel: null },
        { label: "Current week (Sonnet only)", usedPercent: 12, resetsAt: WEEK_RESET, valueLabel: null },
        { label: "Current week (all models)", usedPercent: 69, resetsAt: WEEK_RESET, valueLabel: null },
        { label: "Extra usage", usedPercent: null, resetsAt: null, valueLabel: "$0" },
      ]),
    ).toEqual({
      session: { usedPercent: 31, resetsAt: SESSION_RESET },
      week: { usedPercent: 69, resetsAt: WEEK_RESET },
    });
  });

  it("picks Codex's 5-hour and weekly limits by label", () => {
    expect(
      findSubscriptionPlanWindows("openai", [
        { label: "5h limit", usedPercent: 12, resetsAt: SESSION_RESET, valueLabel: null },
        { label: "Weekly limit", usedPercent: 40, resetsAt: WEEK_RESET, valueLabel: null },
        { label: "GPT-5 · 5h limit", usedPercent: 99, resetsAt: SESSION_RESET, valueLabel: null },
        { label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$4.20 remaining" },
      ]),
    ).toEqual({
      session: { usedPercent: 12, resetsAt: SESSION_RESET },
      week: { usedPercent: 40, resetsAt: WEEK_RESET },
    });
  });

  it("finds no windows for Gemini, which reports no plan usage", () => {
    expect(subscriptionPlanReportsUsage("google")).toBe(false);
    expect(subscriptionPlanReportsUsage("anthropic")).toBe(true);
    expect(
      findSubscriptionPlanWindows("google", [
        { label: "Current session", usedPercent: 50, resetsAt: SESSION_RESET, valueLabel: null },
      ]),
    ).toEqual({ session: null, week: null });
  });
});

describe("normalizeSubscriptionPacingPolicy", () => {
  it("fills an empty stored policy with the defaults for every plan", () => {
    const off = { autoPause: false, sessionPauseAtPercent: 90, weeklyPauseAtPercent: 95 };
    expect(normalizeSubscriptionPacingPolicy({})).toEqual({
      plans: { anthropic: off, openai: off, google: off },
      agentWeeklyLimitPercent: {},
      exemptAgentIds: [],
    });
  });

  it("keeps valid fields, keeps an explicit null threshold, and replaces invalid ones", () => {
    expect(
      normalizeSubscriptionPacingPolicy({
        plans: { anthropic: { autoPause: true, sessionPauseAtPercent: null, weeklyPauseAtPercent: 250 } },
        agentWeeklyLimitPercent: { [CTO]: 30 },
        exemptAgentIds: ["not-a-uuid"],
      }),
    ).toEqual({
      plans: {
        anthropic: { autoPause: true, sessionPauseAtPercent: null, weeklyPauseAtPercent: 95 },
        openai: { autoPause: false, sessionPauseAtPercent: 90, weeklyPauseAtPercent: 95 },
        google: { autoPause: false, sessionPauseAtPercent: 90, weeklyPauseAtPercent: 95 },
      },
      agentWeeklyLimitPercent: { [CTO]: 30 },
      exemptAgentIds: [],
    });
  });
});
