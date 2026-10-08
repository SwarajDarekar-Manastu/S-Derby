import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QuotaWindow } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { formatTokens } from "../lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type PlanWindowKey = "session" | "week";

const PLAN_WINDOWS: Record<PlanWindowKey, { label: string; quotaLabel: string; hours: number }> = {
  session: { label: "Current session", quotaLabel: "currentsession", hours: 5 },
  week: { label: "Current week", quotaLabel: "currentweekallmodels", hours: 7 * 24 },
};

const HOUR_MS = 60 * 60 * 1000;
const ROLLING_STEP_MS = 5 * 60 * 1000;

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function formatReset(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The usage window starts where Claude's plan window started: its reset time
 * minus the window length. Without plan data it falls back to a rolling window,
 * stepped every five minutes so the query key stays stable between renders.
 */
function windowStart(planWindow: QuotaWindow | null, hours: number): string {
  const lengthMs = hours * HOUR_MS;
  if (planWindow?.resetsAt) {
    return new Date(new Date(planWindow.resetsAt).getTime() - lengthMs).toISOString();
  }
  const now = Math.floor(Date.now() / ROLLING_STEP_MS) * ROLLING_STEP_MS;
  return new Date(now - lengthMs).toISOString();
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function SubscriptionUsagePanel({ companyId }: { companyId: string }) {
  const [windowKey, setWindowKey] = useState<PlanWindowKey>("session");
  const config = PLAN_WINDOWS[windowKey];

  const { data: quotaData, isFetched: quotaFetched } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    enabled: !!companyId,
    refetchInterval: 300_000,
    staleTime: 60_000,
  });
  const anthropic = quotaData?.find((result) => result.provider === "anthropic" && result.ok) ?? null;
  const planWindow = anthropic?.windows.find((window) => normalizeLabel(window.label) === config.quotaLabel) ?? null;
  const since = windowStart(planWindow, config.hours);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.subscriptionUsage(companyId, since),
    queryFn: () => costsApi.subscriptionUsage(companyId, since),
    // Wait for the plan windows so the first fetch already uses the plan's start.
    enabled: !!companyId && quotaFetched,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const totals = data?.totals;
  const windowNote = planWindow?.resetsAt
    ? `Claude plan window, resets ${formatReset(planWindow.resetsAt)}.`
    : `Last ${config.hours === 5 ? "5 hours" : "7 days"}. Claude plan data is unavailable, so this is a rolling window.`;

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Claude subscription usage</CardTitle>
            <CardDescription>
              Runs billed to your Claude plan. They cost $0 in the ledger and never count toward budgets.
            </CardDescription>
          </div>
          <Tabs value={windowKey} onValueChange={(value) => setWindowKey(value as PlanWindowKey)}>
            <TabsList variant="line">
              <TabsTrigger value="session">{PLAN_WINDOWS.session.label}</TabsTrigger>
              <TabsTrigger value="week">{PLAN_WINDOWS.week.label}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-2">
        {error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : !quotaFetched || isLoading || !totals ? (
          <p className="text-sm text-muted-foreground">Loading subscription usage…</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Plan used"
                value={planWindow?.usedPercent != null ? `${planWindow.usedPercent}%` : "—"}
              />
              <Stat label="Runs" value={String(totals.runs)} />
              <Stat label="Input tokens" value={formatTokens(totals.inputTokens + totals.cachedInputTokens)} />
              <Stat label="Output tokens" value={formatTokens(totals.outputTokens)} />
            </div>

            <div className="space-y-1 text-xs text-muted-foreground">
              <p>{windowNote}</p>
              {totals.estimatedRuns > 0 ? (
                <p>
                  {totals.estimatedRuns} {totals.estimatedRuns === 1 ? "run is" : "runs are"} estimated: cancelled
                  before Claude reported final usage.
                </p>
              ) : null}
              {totals.unrecordedRuns > 0 ? (
                <p>
                  {totals.unrecordedRuns} Claude {totals.unrecordedRuns === 1 ? "run" : "runs"} recorded no usage.
                </p>
              ) : null}
            </div>

            {data.agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No subscription runs in this window yet.</p>
            ) : (
              <div className="space-y-2">
                {data.agents.map((row) => (
                  <div
                    key={row.agentId}
                    className="flex items-center justify-between gap-3 border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <AgentIdentity
                        agent={{ id: row.agentId, name: row.agentName ?? row.agentId, appearance: row.agentAppearance }}
                        size="sm"
                      />
                      {row.models ? (
                        <div className="mt-1 truncate text-xs text-muted-foreground">{row.models}</div>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right text-sm tabular-nums">
                      <div className="font-medium">
                        {row.runs} {row.runs === 1 ? "run" : "runs"}
                        {row.unrecordedRuns > 0 ? (
                          <span className="font-normal text-muted-foreground"> · {row.unrecordedRuns} no usage</span>
                        ) : null}
                      </div>
                      {row.runs > 0 ? (
                        <div className="text-xs text-muted-foreground">
                          in {formatTokens(row.inputTokens + row.cachedInputTokens)} · out {formatTokens(row.outputTokens)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
