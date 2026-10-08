import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import {
  evaluateSubscriptionPacing,
  findSubscriptionPlanWindows,
  normalizeSubscriptionPacingPolicy,
  subscriptionPlanWindowStart,
  SUBSCRIPTION_WEEK_WINDOW_HOURS,
  type ProviderQuotaResult,
  type SubscriptionPacingPause,
  type SubscriptionPacingPolicy,
  type SubscriptionPacingStatus,
  type SubscriptionPlanWindows,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { costService } from "./costs.js";
import { fetchAllQuotaWindows } from "./quota-windows.js";

const PAUSE_REASON = "subscription_pacing";
const ACTOR_ID = "subscription_pacing";
const PACEABLE_STATUSES = ["active", "idle", "running", "error"];
const WEEK_MS = SUBSCRIPTION_WEEK_WINDOW_HOURS * 60 * 60 * 1000;

type LastSweep = NonNullable<SubscriptionPacingStatus["lastSweep"]>;
const lastSweepByCompany = new Map<string, LastSweep>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function plainEnvValue(env: Record<string, unknown>, key: string): string | null {
  const binding = env[key];
  if (typeof binding === "string") return binding.trim() || null;
  const record = asRecord(binding);
  if (record.type === "plain" && typeof record.value === "string") return record.value.trim() || null;
  return null;
}

function hasEnvValue(env: Record<string, unknown>, key: string): boolean {
  if (plainEnvValue(env, key)) return true;
  const type = asRecord(env[key]).type;
  return type === "secret_ref" || type === "user_secret_ref";
}

/**
 * Mirrors the Claude adapter's billing decision (`resolveClaudeBillingType`)
 * from the agent's stored config: Bedrock and API-key agents are metered, every
 * other Claude agent runs on the machine's Claude subscription.
 */
export function runsOnClaudeSubscription(agent: { adapterType: string; adapterConfig: unknown }): boolean {
  if (agent.adapterType !== "claude_local") return false;
  const config = asRecord(agent.adapterConfig);
  if (config.managedAiConnection) return false;
  const env = asRecord(config.env);
  if (hasEnvValue(env, "ANTHROPIC_API_KEY") || hasEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")) return false;
  const useBedrock = plainEnvValue(env, "CLAUDE_CODE_USE_BEDROCK")?.toLowerCase();
  return useBedrock !== "1" && useBedrock !== "true";
}

export interface SubscriptionPacingServiceDeps {
  fetchQuotaWindows?: () => Promise<ProviderQuotaResult[]>;
  now?: () => Date;
}

export function subscriptionPacingService(db: Db, deps: SubscriptionPacingServiceDeps = {}) {
  const fetchQuotaWindows = deps.fetchQuotaWindows ?? fetchAllQuotaWindows;
  const now = deps.now ?? (() => new Date());
  const costs = costService(db);

  async function readPlanWindows(): Promise<{ plan: SubscriptionPlanWindows | null; error: string | null }> {
    const anthropic = (await fetchQuotaWindows()).find((result) => result.provider === "anthropic");
    if (!anthropic) return { plan: null, error: "No Claude adapter reports plan usage." };
    if (!anthropic.ok) return { plan: null, error: anthropic.error ?? "Claude plan usage is unavailable." };
    const plan = findSubscriptionPlanWindows(anthropic.windows);
    if (!plan.session && !plan.week) return { plan: null, error: "Claude reported no session or weekly window." };
    return { plan, error: null };
  }

  async function readPolicy(companyId: string): Promise<SubscriptionPacingPolicy> {
    const row = await db
      .select({ subscriptionPacing: companies.subscriptionPacing })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return normalizeSubscriptionPacingPolicy(row.subscriptionPacing);
  }

  async function listCompanyAgents(companyId: string) {
    return db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        pauseReason: agents.pauseReason,
        pausedAt: agents.pausedAt,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), notInArray(agents.status, ["terminated", "pending_approval"])));
  }

  async function pauseAgent(companyId: string, agentId: string, pause: SubscriptionPacingPause): Promise<boolean> {
    const at = now();
    const updated = await db
      .update(agents)
      .set({ status: "paused", pauseReason: PAUSE_REASON, pausedAt: at, updatedAt: at })
      .where(and(eq(agents.id, agentId), inArray(agents.status, PACEABLE_STATUSES)))
      .returning({ id: agents.id });
    if (updated.length === 0) return false;
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: ACTOR_ID,
      action: "agent.paused",
      entityType: "agent",
      entityId: agentId,
      details: { reason: PAUSE_REASON, ...pause },
    });
    return true;
  }

  async function resumeAgent(companyId: string, agentId: string, why: string): Promise<boolean> {
    const at = now();
    const updated = await db
      .update(agents)
      .set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: at })
      .where(and(eq(agents.id, agentId), eq(agents.status, "paused"), eq(agents.pauseReason, PAUSE_REASON)))
      .returning({ id: agents.id });
    if (updated.length === 0) return false;
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: ACTOR_ID,
      action: "agent.resumed",
      entityType: "agent",
      entityId: agentId,
      details: { reason: PAUSE_REASON, why },
    });
    return true;
  }

  /**
   * Pause the paced agents a rule wants paused and resume the agents pacing
   * paused that no rule wants paused any more. Without plan data it changes
   * nothing, except that turning auto-pause off always releases pacing's pauses.
   */
  async function applyCompany(companyId: string, plan: SubscriptionPlanWindows | null) {
    const policy = await readPolicy(companyId);
    const companyAgents = await listCompanyAgents(companyId);
    const pacingPaused = companyAgents.filter((agent) => agent.status === "paused" && agent.pauseReason === PAUSE_REASON);
    let paused = 0;
    let resumed = 0;

    if (!policy.autoPause) {
      for (const agent of pacingPaused) {
        if (await resumeAgent(companyId, agent.id, "auto_pause_off")) resumed += 1;
      }
      return { paused, resumed };
    }
    if (!plan) return { paused, resumed };

    const paced = companyAgents.filter(runsOnClaudeSubscription);
    const weekStart = plan.week
      ? subscriptionPlanWindowStart(plan.week, SUBSCRIPTION_WEEK_WINDOW_HOURS)
      : new Date(now().getTime() - WEEK_MS);
    const usage = await costs.subscriptionUsage(companyId, weekStart);
    const tokensByAgent = new Map(usage.agents.map((row) => [row.agentId, row.inputTokens + row.outputTokens]));
    const evaluations = evaluateSubscriptionPacing({
      policy,
      plan,
      agents: paced.map((agent) => ({ agentId: agent.id, weeklyTokens: tokensByAgent.get(agent.id) ?? 0 })),
    });
    const pauseByAgent = new Map(evaluations.map((row) => [row.agentId, row.pause]));

    for (const agent of paced) {
      const pause = pauseByAgent.get(agent.id) ?? null;
      if (pause && PACEABLE_STATUSES.includes(agent.status)) {
        if (await pauseAgent(companyId, agent.id, pause)) paused += 1;
      }
    }
    for (const agent of pacingPaused) {
      if (pauseByAgent.get(agent.id)) continue;
      const why = policy.exemptAgentIds.includes(agent.id)
        ? "exempt"
        : runsOnClaudeSubscription(agent)
          ? "no_rule_applies"
          : "not_on_subscription";
      if (await resumeAgent(companyId, agent.id, why)) resumed += 1;
    }
    return { paused, resumed };
  }

  async function runForCompanies(companyIds: string[], needsPlan: boolean) {
    const { plan, error } = needsPlan ? await readPlanWindows() : { plan: null, error: null };
    for (const companyId of companyIds) {
      const result = await applyCompany(companyId, plan);
      lastSweepByCompany.set(companyId, {
        at: now().toISOString(),
        ok: error === null,
        error,
        paused: result.paused,
        resumed: result.resumed,
      });
    }
  }

  return {
    readPolicy,

    async updatePolicy(companyId: string, policy: SubscriptionPacingPolicy, actorUserId: string | null) {
      const updated = await db
        .update(companies)
        .set({ subscriptionPacing: policy, updatedAt: now() })
        .where(eq(companies.id, companyId))
        .returning({ id: companies.id });
      if (updated.length === 0) throw notFound("Company not found");
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "company.subscription_pacing_updated",
        entityType: "company",
        entityId: companyId,
        details: { ...policy },
      });
    },

    async status(companyId: string): Promise<SubscriptionPacingStatus> {
      const policy = await readPolicy(companyId);
      const companyAgents = await listCompanyAgents(companyId);
      return {
        policy,
        agents: companyAgents
          .filter((agent) => runsOnClaudeSubscription(agent) || agent.pauseReason === PAUSE_REASON)
          .map((agent) => ({
            agentId: agent.id,
            agentName: agent.name,
            status: agent.status,
            pauseReason: agent.pauseReason,
            pausedAt: agent.pausedAt ? agent.pausedAt.toISOString() : null,
          })),
        lastSweep: lastSweepByCompany.get(companyId) ?? null,
      };
    },

    /** Evaluate one company now, fetching the plan windows only when auto-pause is on. */
    async evaluateCompany(companyId: string) {
      const policy = await readPolicy(companyId);
      await runForCompanies([companyId], policy.autoPause);
    },

    /**
     * Periodic sweep over every company with auto-pause on or with agents that
     * pacing paused. The plan windows are fetched once, and only when needed.
     */
    async sweep() {
      const rows = await db
        .select({ id: companies.id, subscriptionPacing: companies.subscriptionPacing })
        .from(companies)
        .where(notInArray(companies.status, ["archived"]));
      const autoPauseIds = rows
        .filter((row) => normalizeSubscriptionPacingPolicy(row.subscriptionPacing).autoPause)
        .map((row) => row.id);
      const withPacingPauses = await db
        .selectDistinct({ companyId: agents.companyId })
        .from(agents)
        .where(and(eq(agents.status, "paused"), eq(agents.pauseReason, PAUSE_REASON)));
      const companyIds = [...new Set([...autoPauseIds, ...withPacingPauses.map((row) => row.companyId)])];
      if (companyIds.length === 0) return;
      await runForCompanies(companyIds, autoPauseIds.length > 0);
    },
  };
}
