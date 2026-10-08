import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  evaluateSubscriptionPacing,
  findSubscriptionPlanWindows,
  subscriptionPlanWindowStart,
  SUBSCRIPTION_WEEK_WINDOW_HOURS,
  type SubscriptionPacingAgent,
  type SubscriptionPacingAgentEvaluation,
  type SubscriptionPacingPause,
  type SubscriptionPacingPolicy,
} from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

const WEEK_MS = SUBSCRIPTION_WEEK_WINDOW_HOURS * 60 * 60 * 1000;
const ROLLING_STEP_MS = 5 * 60 * 1000;

function parsePercent(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : "invalid";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function ruleText(pause: SubscriptionPacingPause): string {
  switch (pause.rule) {
    case "session":
      return `Session at ${pause.observedPercent}% (limit ${pause.limitPercent}%)`;
    case "weekly":
      return `Week at ${pause.observedPercent}% (limit ${pause.limitPercent}%)`;
    case "agent_limit":
      return `Used about ${pause.observedPercent}% of the week (limit ${pause.limitPercent}%)`;
  }
}

function agentStatusText(
  agent: SubscriptionPacingAgent,
  evaluation: SubscriptionPacingAgentEvaluation | undefined,
  autoPause: boolean,
): { text: string; tone: "muted" | "warning" } {
  const pause = evaluation?.pause ?? null;
  if (agent.status === "paused" && agent.pauseReason === "subscription_pacing") {
    return pause
      ? { text: `Paused by pacing: ${ruleText(pause)}. Resumes ${formatTime(pause.resumesAt)}.`, tone: "warning" }
      : { text: "Paused by pacing. Resumes at the next check.", tone: "warning" };
  }
  if (agent.status === "paused") {
    return { text: `Paused (${agent.pauseReason ?? "manual"}). Pacing leaves it alone.`, tone: "muted" };
  }
  if (evaluation?.exempt) return { text: "Never paused by pacing.", tone: "muted" };
  if (pause) {
    return autoPause
      ? { text: `Pauses at the next check: ${ruleText(pause)}.`, tone: "warning" }
      : { text: `Would pause: ${ruleText(pause)}. Auto-pause is off.`, tone: "warning" };
  }
  return { text: "Running inside its limits.", tone: "muted" };
}

interface Draft {
  autoPause: boolean;
  sessionText: string;
  weeklyText: string;
  limitTextByAgent: Record<string, string>;
  exempt: Set<string>;
}

function draftFromPolicy(policy: SubscriptionPacingPolicy): Draft {
  return {
    autoPause: policy.autoPause,
    sessionText: policy.sessionPauseAtPercent == null ? "" : String(policy.sessionPauseAtPercent),
    weeklyText: policy.weeklyPauseAtPercent == null ? "" : String(policy.weeklyPauseAtPercent),
    limitTextByAgent: Object.fromEntries(
      Object.entries(policy.agentWeeklyLimitPercent).map(([agentId, limit]) => [agentId, String(limit)]),
    ),
    exempt: new Set(policy.exemptAgentIds),
  };
}

/** The policy the draft describes, or null while any field is invalid. */
function policyFromDraft(draft: Draft): SubscriptionPacingPolicy | null {
  const session = parsePercent(draft.sessionText);
  const weekly = parsePercent(draft.weeklyText);
  if (session === "invalid" || weekly === "invalid") return null;
  const limits: Record<string, number> = {};
  for (const [agentId, text] of Object.entries(draft.limitTextByAgent)) {
    const limit = parsePercent(text);
    if (limit === "invalid") return null;
    if (limit != null) limits[agentId] = limit;
  }
  return {
    autoPause: draft.autoPause,
    sessionPauseAtPercent: session,
    weeklyPauseAtPercent: weekly,
    agentWeeklyLimitPercent: limits,
    exemptAgentIds: [...draft.exempt],
  };
}

export function SubscriptionPacingCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: queryKeys.subscriptionPacing(companyId),
    queryFn: () => costsApi.subscriptionPacing(companyId),
    refetchInterval: 60_000,
  });
  const { data: quotaData, isFetched: quotaFetched } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    refetchInterval: 300_000,
    staleTime: 60_000,
  });
  const anthropic = quotaData?.find((result) => result.provider === "anthropic" && result.ok) ?? null;
  const plan = useMemo(() => findSubscriptionPlanWindows(anthropic?.windows ?? []), [anthropic]);
  const weekStart = plan.week
    ? subscriptionPlanWindowStart(plan.week, SUBSCRIPTION_WEEK_WINDOW_HOURS).toISOString()
    : new Date(Math.floor(Date.now() / ROLLING_STEP_MS) * ROLLING_STEP_MS - WEEK_MS).toISOString();
  const usageQuery = useQuery({
    queryKey: queryKeys.subscriptionUsage(companyId, weekStart),
    queryFn: () => costsApi.subscriptionUsage(companyId, weekStart),
    enabled: quotaFetched,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const status = statusQuery.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (status && !dirty) setDraft(draftFromPolicy(status.policy));
  }, [status, dirty]);

  const onStatus = (next: Awaited<ReturnType<typeof costsApi.subscriptionPacing>>) => {
    queryClient.setQueryData(queryKeys.subscriptionPacing(companyId), next);
    setDirty(false);
    setDraft(draftFromPolicy(next.policy));
  };
  const saveMutation = useMutation({
    mutationFn: (policy: SubscriptionPacingPolicy) => costsApi.updateSubscriptionPacing(companyId, policy),
    onSuccess: onStatus,
  });
  const checkMutation = useMutation({
    mutationFn: () => costsApi.evaluateSubscriptionPacing(companyId),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.subscriptionPacing(companyId), next),
  });

  const draftPolicy = draft ? policyFromDraft(draft) : null;
  const tokensByAgent = useMemo(
    () => new Map((usageQuery.data?.agents ?? []).map((row) => [row.agentId, row.inputTokens + row.outputTokens])),
    [usageQuery.data],
  );
  const appearanceByAgent = useMemo(
    () => new Map((usageQuery.data?.agents ?? []).map((row) => [row.agentId, row.agentAppearance])),
    [usageQuery.data],
  );
  const evaluations = useMemo(() => {
    if (!status || !draftPolicy) return new Map<string, SubscriptionPacingAgentEvaluation>();
    const rows = evaluateSubscriptionPacing({
      policy: draftPolicy,
      plan,
      agents: status.agents.map((agent) => ({ agentId: agent.agentId, weeklyTokens: tokensByAgent.get(agent.agentId) ?? 0 })),
    });
    return new Map(rows.map((row) => [row.agentId, row]));
  }, [status, draftPolicy, plan, tokensByAgent]);

  const update = (change: (current: Draft) => Draft) => {
    setDraft((current) => (current ? change(current) : current));
    setDirty(true);
  };

  if (statusQuery.error) {
    return <p className="text-sm text-destructive">{(statusQuery.error as Error).message}</p>;
  }
  if (!status || !draft) {
    return <p className="text-sm text-muted-foreground">Loading subscription pacing…</p>;
  }

  const lastSweep = status.lastSweep;
  const saveError = (saveMutation.error ?? checkMutation.error) as Error | null;

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Subscription pacing</CardTitle>
            <CardDescription>
              Pauses agents on the Claude subscription before the plan runs out and resumes them when the plan window
              resets. Agents paused by you, the Board, or a budget are never touched.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ToggleSwitch
              checked={draft.autoPause}
              onCheckedChange={(checked) => update((current) => ({ ...current, autoPause: checked }))}
              aria-label={draft.autoPause ? "Turn auto-pause off" : "Turn auto-pause on"}
            />
            <span className="text-sm text-muted-foreground">Auto-pause {draft.autoPause ? "on" : "off"}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 px-5 pb-5 pt-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block border border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">Pause everyone when the session reaches (%)</span>
            <Input
              className="mt-1"
              inputMode="numeric"
              value={draft.sessionText}
              placeholder="Off"
              onChange={(event) => update((current) => ({ ...current, sessionText: event.target.value }))}
            />
          </label>
          <label className="block border border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">Pause everyone when the week reaches (%)</span>
            <Input
              className="mt-1"
              inputMode="numeric"
              value={draft.weeklyText}
              placeholder="Off"
              onChange={(event) => update((current) => ({ ...current, weeklyText: event.target.value }))}
            />
          </label>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Agents on the subscription</div>
          <p className="text-xs text-muted-foreground">
            Each agent's share of this plan week, from input and output tokens (cache reads excluded). Opus uses the plan
            faster than Sonnet, so treat the percent of the week as an estimate. Leave a limit blank for no limit.
          </p>
          {status.agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents run on the Claude subscription.</p>
          ) : (
            [...status.agents]
              .sort(
                (a, b) =>
                  (evaluations.get(b.agentId)?.weeklySharePercent ?? 0) -
                  (evaluations.get(a.agentId)?.weeklySharePercent ?? 0),
              )
              .map((agent) => {
              const evaluation = evaluations.get(agent.agentId);
              const statusText = agentStatusText(agent, evaluation, draft.autoPause);
              const planPercent = evaluation?.weeklyPlanPercent ?? null;
              return (
                <div key={agent.agentId} className="border border-border px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <AgentIdentity
                      agent={{ id: agent.agentId, name: agent.agentName, appearance: appearanceByAgent.get(agent.agentId) }}
                      size="sm"
                    />
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Limit (% of week)
                        <Input
                          className="w-20"
                          inputMode="numeric"
                          placeholder="None"
                          value={draft.limitTextByAgent[agent.agentId] ?? ""}
                          onChange={(event) =>
                            update((current) => ({
                              ...current,
                              limitTextByAgent: { ...current.limitTextByAgent, [agent.agentId]: event.target.value },
                            }))}
                        />
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox
                          checked={draft.exempt.has(agent.agentId)}
                          aria-label={`Never pause ${agent.agentName}`}
                          onCheckedChange={(checked) =>
                            update((current) => {
                              const exempt = new Set(current.exempt);
                              if (checked) exempt.add(agent.agentId);
                              else exempt.delete(agent.agentId);
                              return { ...current, exempt };
                            })}
                        />
                        Never pause
                      </label>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      {planPercent == null
                        ? "Plan data unavailable"
                        : `About ${planPercent}% of the week · ${evaluation?.weeklySharePercent ?? 0}% of subscription tokens`}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden bg-muted">
                    <div className="h-full bg-primary/70" style={{ width: `${Math.min(100, planPercent ?? 0)}%` }} />
                  </div>
                  <div
                    className={
                      statusText.tone === "warning"
                        ? "mt-2 text-xs text-(--status-agent-paused)"
                        : "mt-2 text-xs text-muted-foreground"
                    }
                  >
                    {statusText.text}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {saveError ? <p className="text-sm text-destructive">{saveError.message}</p> : null}
        {!draftPolicy ? (
          <p className="text-sm text-destructive">Percentages must be whole numbers from 1 to 100, or blank.</p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Button
              variant="outline"
              size="sm"
              disabled={checkMutation.isPending}
              onClick={() => checkMutation.mutate()}
            >
              {checkMutation.isPending ? "Checking…" : "Check now"}
            </Button>
            <span>
              {lastSweep
                ? lastSweep.ok
                  ? `Last check ${relativeTime(lastSweep.at)}: paused ${lastSweep.paused}, resumed ${lastSweep.resumed}.`
                  : `Last check ${relativeTime(lastSweep.at)} could not read the plan: ${lastSweep.error}`
                : "Checks run every 5 minutes while auto-pause is on."}
            </span>
          </div>
          <Button
            disabled={!dirty || !draftPolicy || saveMutation.isPending}
            onClick={() => {
              if (draftPolicy) saveMutation.mutate(draftPolicy);
            }}
          >
            {saveMutation.isPending ? "Saving…" : "Save pacing"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
