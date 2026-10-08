import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SUBSCRIPTION_PLAN_PROVIDERS, SUBSCRIPTION_PLANS, type SubscriptionPlanProvider } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { SubscriptionPacingCard } from "./SubscriptionPacingCard";
import { SubscriptionUsagePanel } from "./SubscriptionUsagePanel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Subscription plans for the Costs page. The overview shows a usage panel for
 * each plan that has agents on it; the full view switches between every
 * supported plan and adds its pacing settings.
 */
export function SubscriptionPlansSection({ companyId, view }: { companyId: string; view: "overview" | "full" }) {
  const statusQuery = useQuery({
    queryKey: queryKeys.subscriptionPacing(companyId),
    queryFn: () => costsApi.subscriptionPacing(companyId),
    refetchInterval: 60_000,
  });
  const agentCount = (provider: SubscriptionPlanProvider) =>
    (statusQuery.data?.agents ?? []).filter((agent) => agent.provider === provider).length;
  const inUse = SUBSCRIPTION_PLAN_PROVIDERS.filter((provider) => agentCount(provider) > 0);
  const [selected, setSelected] = useState<SubscriptionPlanProvider | null>(null);

  if (view === "overview") {
    return (
      <>
        {inUse.map((provider) => (
          <SubscriptionUsagePanel key={provider} companyId={companyId} provider={provider} />
        ))}
      </>
    );
  }

  if (statusQuery.error) {
    return <p className="text-sm text-destructive">{(statusQuery.error as Error).message}</p>;
  }
  if (!statusQuery.data) {
    return <p className="text-sm text-muted-foreground">Loading subscription plans…</p>;
  }
  const provider = selected ?? inUse[0] ?? SUBSCRIPTION_PLAN_PROVIDERS[0];

  return (
    <div className="space-y-4">
      <Tabs value={provider} onValueChange={(value) => setSelected(value as SubscriptionPlanProvider)}>
        <TabsList variant="line" className="justify-start">
          {SUBSCRIPTION_PLAN_PROVIDERS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {SUBSCRIPTION_PLANS[key].label}
              <span className="text-xs text-muted-foreground">{agentCount(key)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <SubscriptionUsagePanel key={`usage-${provider}`} companyId={companyId} provider={provider} />
      <SubscriptionPacingCard key={`pacing-${provider}`} companyId={companyId} provider={provider} />
    </div>
  );
}
