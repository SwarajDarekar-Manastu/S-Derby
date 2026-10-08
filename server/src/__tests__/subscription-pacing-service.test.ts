import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import type { ProviderQuotaResult, SubscriptionPacingPolicy } from "@paperclipai/shared";
import { runsOnClaudeSubscription, subscriptionPacingService } from "../services/subscription-pacing.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const SESSION_RESET = "2026-10-08T15:50:00.000Z";
const WEEK_RESET = "2026-10-09T23:00:00.000Z";

function quota(sessionPercent: number, weekPercent: number): ProviderQuotaResult[] {
  return [
    {
      provider: "anthropic",
      ok: true,
      windows: [
        { label: "Current session", usedPercent: sessionPercent, resetsAt: SESSION_RESET, valueLabel: null },
        { label: "Current week (all models)", usedPercent: weekPercent, resetsAt: WEEK_RESET, valueLabel: null },
      ],
    },
  ];
}

describe("runsOnClaudeSubscription", () => {
  it("treats a Claude agent without an API key, Bedrock, or managed connection as subscription-billed", () => {
    expect(runsOnClaudeSubscription({ adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5" } })).toBe(true);
    expect(
      runsOnClaudeSubscription({ adapterType: "claude_local", adapterConfig: { env: { ANTHROPIC_API_KEY: "sk-ant-x" } } }),
    ).toBe(false);
    expect(
      runsOnClaudeSubscription({
        adapterType: "claude_local",
        adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: randomUUID() } } },
      }),
    ).toBe(false);
    expect(
      runsOnClaudeSubscription({
        adapterType: "claude_local",
        adapterConfig: { env: { CLAUDE_CODE_USE_BEDROCK: { type: "plain", value: "1" } } },
      }),
    ).toBe(false);
    expect(runsOnClaudeSubscription({ adapterType: "codex_local", adapterConfig: {} })).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("subscription pacing service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-subscription-pacing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(policy: Partial<SubscriptionPacingPolicy>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "S-Derby",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      subscriptionPacing: policy,
    });
    const ids = {
      cto: randomUUID(),
      dev: randomUUID(),
      qa: randomUUID(),
      apiAgent: randomUUID(),
      manual: randomUUID(),
    };
    const base = { companyId, role: "engineer", runtimeConfig: {}, permissions: {} };
    await db.insert(agents).values([
      { ...base, id: ids.cto, name: "CTO", status: "idle", adapterType: "claude_local", adapterConfig: {} },
      { ...base, id: ids.dev, name: "Developer", status: "running", adapterType: "claude_local", adapterConfig: {} },
      { ...base, id: ids.qa, name: "QA", status: "idle", adapterType: "claude_local", adapterConfig: {} },
      {
        ...base,
        id: ids.apiAgent,
        name: "API agent",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { env: { ANTHROPIC_API_KEY: "sk-ant-test" } },
      },
      {
        ...base,
        id: ids.manual,
        name: "Manually paused",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-10-08T09:00:00.000Z"),
        adapterType: "claude_local",
        adapterConfig: {},
      },
    ]);
    return { companyId, ids };
  }

  async function agentState(agentId: string) {
    const [row] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row;
  }

  it("pauses the subscription agents when the session reaches its limit, and leaves the rest alone", async () => {
    const { companyId, ids } = await seed({ autoPause: true, exemptAgentIds: [] });
    const fetchQuotaWindows = vi.fn().mockResolvedValue(quota(93, 40));
    const qaExempt = subscriptionPacingService(db, { fetchQuotaWindows, now: () => NOW });
    await qaExempt.updatePolicy(
      companyId,
      { autoPause: true, sessionPauseAtPercent: 90, weeklyPauseAtPercent: 95, agentWeeklyLimitPercent: {}, exemptAgentIds: [ids.qa] },
      "user-1",
    );

    await qaExempt.evaluateCompany(companyId);

    expect(await agentState(ids.cto)).toEqual({ status: "paused", pauseReason: "subscription_pacing" });
    expect(await agentState(ids.dev)).toEqual({ status: "paused", pauseReason: "subscription_pacing" });
    expect(await agentState(ids.qa)).toEqual({ status: "idle", pauseReason: null });
    expect(await agentState(ids.apiAgent)).toEqual({ status: "idle", pauseReason: null });
    expect(await agentState(ids.manual)).toEqual({ status: "paused", pauseReason: "manual" });

    const pauses = await db
      .select({ entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.action, "agent.paused"), eq(activityLog.actorId, "subscription_pacing")));
    expect(pauses).toHaveLength(2);
    expect(pauses.find((row) => row.entityId === ids.cto)?.details).toEqual({
      reason: "subscription_pacing",
      rule: "session",
      observedPercent: 93,
      limitPercent: 90,
      resumesAt: SESSION_RESET,
    });
    const status = await qaExempt.status(companyId);
    expect(status.lastSweep).toEqual({ at: NOW.toISOString(), ok: true, error: null, paused: 2, resumed: 0 });
  });

  it("resumes only the agents pacing paused once no rule applies", async () => {
    const { companyId, ids } = await seed({ autoPause: true });
    const fetchQuotaWindows = vi.fn().mockResolvedValueOnce(quota(95, 40)).mockResolvedValueOnce(quota(4, 41));
    const pacing = subscriptionPacingService(db, { fetchQuotaWindows, now: () => NOW });

    await pacing.evaluateCompany(companyId);
    expect(await agentState(ids.cto)).toEqual({ status: "paused", pauseReason: "subscription_pacing" });

    await pacing.evaluateCompany(companyId);
    expect(await agentState(ids.cto)).toEqual({ status: "idle", pauseReason: null });
    expect(await agentState(ids.dev)).toEqual({ status: "idle", pauseReason: null });
    expect(await agentState(ids.manual)).toEqual({ status: "paused", pauseReason: "manual" });
    const resumed = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(and(eq(activityLog.action, "agent.resumed"), eq(activityLog.actorId, "subscription_pacing")));
    expect(resumed.map((row) => row.entityId).sort()).toEqual([ids.cto, ids.dev, ids.qa].sort());
  });

  it("releases pacing's pauses when auto-pause is turned off, without reading the plan", async () => {
    const { companyId, ids } = await seed({ autoPause: true });
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "subscription_pacing", pausedAt: NOW })
      .where(eq(agents.id, ids.cto));
    const fetchQuotaWindows = vi.fn().mockResolvedValue(quota(99, 99));
    const pacing = subscriptionPacingService(db, { fetchQuotaWindows, now: () => NOW });
    await pacing.updatePolicy(
      companyId,
      { autoPause: false, sessionPauseAtPercent: 90, weeklyPauseAtPercent: 95, agentWeeklyLimitPercent: {}, exemptAgentIds: [] },
      "user-1",
    );

    await pacing.sweep();

    expect(fetchQuotaWindows).not.toHaveBeenCalled();
    expect(await agentState(ids.cto)).toEqual({ status: "idle", pauseReason: null });
    expect(await agentState(ids.dev)).toEqual({ status: "running", pauseReason: null });
  });

  it("pauses only the agent over its share of the week", async () => {
    const { companyId, ids } = await seed({ autoPause: true });
    const pacing = subscriptionPacingService(db, { fetchQuotaWindows: vi.fn().mockResolvedValue(quota(20, 60)), now: () => NOW });
    await pacing.updatePolicy(
      companyId,
      {
        autoPause: true,
        sessionPauseAtPercent: 90,
        weeklyPauseAtPercent: 95,
        agentWeeklyLimitPercent: { [ids.cto]: 30, [ids.dev]: 30 },
        exemptAgentIds: [],
      },
      "user-1",
    );
    const event = {
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included" as const,
      costStatus: "unpriced" as const,
      model: "claude-opus-5-5",
      cachedInputTokens: 5_000_000,
      costCents: 0,
      occurredAt: new Date("2026-10-08T08:00:00.000Z"),
    };
    await db.insert(costEvents).values([
      { ...event, companyId, agentId: ids.cto, inputTokens: 600_000, outputTokens: 100_000 },
      { ...event, companyId, agentId: ids.dev, inputTokens: 250_000, outputTokens: 50_000 },
    ]);

    await pacing.evaluateCompany(companyId);

    expect(await agentState(ids.cto)).toEqual({ status: "paused", pauseReason: "subscription_pacing" });
    expect(await agentState(ids.dev)).toEqual({ status: "running", pauseReason: null });
    const [pause] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.action, "agent.paused"), eq(activityLog.entityId, ids.cto)));
    expect(pause?.details).toEqual({
      reason: "subscription_pacing",
      rule: "agent_limit",
      observedPercent: 42,
      limitPercent: 30,
      resumesAt: WEEK_RESET,
    });
  });

  it("changes nothing when Claude's plan usage is unavailable", async () => {
    const { companyId, ids } = await seed({ autoPause: true });
    const pacing = subscriptionPacingService(db, {
      fetchQuotaWindows: vi.fn().mockResolvedValue([
        { provider: "anthropic", ok: false, error: "anthropic usage api returned 401", windows: [] },
      ]),
      now: () => NOW,
    });

    await pacing.evaluateCompany(companyId);

    expect(await agentState(ids.cto)).toEqual({ status: "idle", pauseReason: null });
    expect((await pacing.status(companyId)).lastSweep).toEqual({
      at: NOW.toISOString(),
      ok: false,
      error: "anthropic usage api returned 401",
      paused: 0,
      resumed: 0,
    });
  });
});
