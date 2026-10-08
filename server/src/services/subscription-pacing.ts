import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import {
  evaluateSubscriptionPacing,
  findSubscriptionPlanWindows,
  normalizeSubscriptionPacingPolicy,
  subscriptionPlanReportsUsage,
  subscriptionPlanWindowStart,
  SUBSCRIPTION_PLAN_PROVIDERS,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_WEEK_WINDOW_HOURS,
  type ProviderQuotaResult,
  type SubscriptionPacingPause,
  type SubscriptionPacingPolicy,
  type SubscriptionPacingStatus,
  type SubscriptionPlanProvider,
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
type PlanReadings = Partial<Record<SubscriptionPlanProvider, { plan: SubscriptionPlanWindows | null; error: string | null }>>;
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

function usesClaudeBedrock(env: Record<string, unknown>): boolean {
  const useBedrock = plainEnvValue(env, "CLAUDE_CODE_USE_BEDROCK")?.toLowerCase();
  return useBedrock === "1" || useBedrock === "true" || hasEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL");
}

/**
 * The subscription plan an agent bills, read from its stored config the way
 * each adapter decides its billing type at run time: an agent with an API key,
 * a managed AI connection, or (for Claude) Bedrock is metered, not on a plan.
 */
export function subscriptionPlanProvider(agent: {
  adapterType: string;
  adapterConfig: unknown;
}): SubscriptionPlanProvider | null {
  const provider = SUBSCRIPTION_PLAN_PROVIDERS.find((key) => SUBSCRIPTION_PLANS[key].adapterType === agent.adapterType);
  if (!provider) return null;
  const config = asRecord(agent.adapterConfig);
  if (config.managedAiConnection) return null;
  const env = asRecord(config.env);
  if (SUBSCRIPTION_PLANS[provider].apiKeyEnvVars.some((key) => hasEnvValue(env, key))) return null;
  if (provider === "anthropic" && usesClaudeBedrock(env)) return null;
  return provider;
}

function pacedPlans(policy: SubscriptionPacingPolicy): SubscriptionPlanProvider[] {
  return SUBSCRIPTION_PLAN_PROVIDERS.filter(
    (provider) => policy.plans[provider].autoPause && subscriptionPlanReportsUsage(provider),
  );
}

export interface SubscriptionPacingServiceDeps {
  fetchQuotaWindows?: () => Promise<ProviderQuotaResult[]>;
  now?: () => Date;
}

export function subscriptionPacingService(db: Db, deps: SubscriptionPacingServiceDeps = {}) {
  const fetchQuotaWindows = deps.fetchQuotaWindows ?? fetchAllQuotaWindows;
  const now = deps.now ?? (() => new Date());
  const costs = costService(db);

  /** One quota fetch covers every provider; read each plan's windows from it. */
  async function readPlans(): Promise<PlanReadings> {
    const results = await fetchQuotaWindows();
    const readings: PlanReadings = {};
    for (const provider of SUBSCRIPTION_PLAN_PROVIDERS) {
      if (!subscriptionPlanReportsUsage(provider)) continue;
      const label = SUBSCRIPTION_PLANS[provider].label;
      const result = results.find((row) => row.provider === provider);
      if (!result) {
        readings[provider] = { plan: null, error: `${label} plan usage is not available on this server.` };
      } else if (!result.ok) {
        readings[provider] = { plan: null, error: result.error ?? `${label} plan usage is unavailable.` };
      } else {
        const plan = findSubscriptionPlanWindows(provider, result.windows);
        readings[provider] =
          plan.session || plan.week
            ? { plan, error: null }
            : { plan: null, error: `${label} reported no session or weekly window.` };
      }
    }
    return readings;
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

  async function pauseAgent(
    companyId: string,
    agentId: string,
    provider: SubscriptionPlanProvider,
    pause: SubscriptionPacingPause,
  ): Promise<boolean> {
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
      details: { reason: PAUSE_REASON, provider, ...pause },
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
   * For each plan, pause the agents a rule wants paused and resume the agents
   * pacing paused that no rule wants paused any more. A plan whose usage could
   * not be read changes nothing; a plan with auto-pause off releases pacing's
   * pauses. Agents that left every plan are released too.
   */
  async function applyCompany(companyId: string, readings: PlanReadings) {
    const policy = await readPolicy(companyId);
    const companyAgents = (await listCompanyAgents(companyId)).map((agent) => ({
      ...agent,
      provider: subscriptionPlanProvider(agent),
    }));
    const isPacingPaused = (agent: { status: string; pauseReason: string | null }) =>
      agent.status === "paused" && agent.pauseReason === PAUSE_REASON;
    let paused = 0;
    let resumed = 0;
    const errors: LastSweep["errors"] = {};

    for (const agent of companyAgents) {
      if (agent.provider === null && isPacingPaused(agent)) {
        if (await resumeAgent(companyId, agent.id, "not_on_subscription")) resumed += 1;
      }
    }

    const paced = new Set(pacedPlans(policy));
    for (const provider of SUBSCRIPTION_PLAN_PROVIDERS) {
      const planAgents = companyAgents.filter((agent) => agent.provider === provider);
      if (!paced.has(provider)) {
        for (const agent of planAgents.filter(isPacingPaused)) {
          if (await resumeAgent(companyId, agent.id, "auto_pause_off")) resumed += 1;
        }
        continue;
      }
      const reading = readings[provider];
      if (!reading?.plan) {
        if (reading?.error) errors[provider] = reading.error;
        continue;
      }

      const plan = reading.plan;
      const weekStart = plan.week
        ? subscriptionPlanWindowStart(plan.week, SUBSCRIPTION_WEEK_WINDOW_HOURS)
        : new Date(now().getTime() - WEEK_MS);
      const usage = await costs.subscriptionUsage(companyId, weekStart, provider);
      const tokensByAgent = new Map(usage.agents.map((row) => [row.agentId, row.inputTokens + row.outputTokens]));
      const evaluations = evaluateSubscriptionPacing({
        policy,
        provider,
        plan,
        agents: planAgents.map((agent) => ({ agentId: agent.id, weeklyTokens: tokensByAgent.get(agent.id) ?? 0 })),
      });
      const pauseByAgent = new Map(evaluations.map((row) => [row.agentId, row.pause]));

      for (const agent of planAgents) {
        const pause = pauseByAgent.get(agent.id) ?? null;
        if (pause && PACEABLE_STATUSES.includes(agent.status)) {
          if (await pauseAgent(companyId, agent.id, provider, pause)) paused += 1;
        } else if (!pause && isPacingPaused(agent)) {
          const why = policy.exemptAgentIds.includes(agent.id) ? "exempt" : "no_rule_applies";
          if (await resumeAgent(companyId, agent.id, why)) resumed += 1;
        }
      }
    }
    return { paused, resumed, errors };
  }

  async function runForCompanies(companyIds: string[], needsPlans: boolean) {
    const readings = needsPlans ? await readPlans() : {};
    for (const companyId of companyIds) {
      const result = await applyCompany(companyId, readings);
      lastSweepByCompany.set(companyId, { at: now().toISOString(), ...result });
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
          .map((agent) => ({ agent, provider: subscriptionPlanProvider(agent) }))
          .filter(({ agent, provider }) => provider !== null || agent.pauseReason === PAUSE_REASON)
          .map(({ agent, provider }) => ({
            agentId: agent.id,
            agentName: agent.name,
            provider,
            status: agent.status,
            pauseReason: agent.pauseReason,
            pausedAt: agent.pausedAt ? agent.pausedAt.toISOString() : null,
          })),
        lastSweep: lastSweepByCompany.get(companyId) ?? null,
      };
    },

    /** Evaluate one company now, reading plan usage only when one of its plans is paced. */
    async evaluateCompany(companyId: string) {
      const policy = await readPolicy(companyId);
      await runForCompanies([companyId], pacedPlans(policy).length > 0);
    },

    /**
     * Periodic sweep over every company with a paced plan or with agents that
     * pacing paused. Plan usage is read once, and only when some plan is paced.
     */
    async sweep() {
      const rows = await db
        .select({ id: companies.id, subscriptionPacing: companies.subscriptionPacing })
        .from(companies)
        .where(notInArray(companies.status, ["archived"]));
      const pacedIds = rows
        .filter((row) => pacedPlans(normalizeSubscriptionPacingPolicy(row.subscriptionPacing)).length > 0)
        .map((row) => row.id);
      const withPacingPauses = await db
        .selectDistinct({ companyId: agents.companyId })
        .from(agents)
        .where(and(eq(agents.status, "paused"), eq(agents.pauseReason, PAUSE_REASON)));
      const companyIds = [...new Set([...pacedIds, ...withPacingPauses.map((row) => row.companyId)])];
      if (companyIds.length === 0) return;
      await runForCompanies(companyIds, pacedIds.length > 0);
    },
  };
}
