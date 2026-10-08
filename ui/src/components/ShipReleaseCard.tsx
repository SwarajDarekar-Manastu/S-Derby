import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RELEASE_SHIP_TOKEN_SECRET_NAME, type ReleaseShipRepo, type ReleaseShipResult } from "@paperclipai/shared";
import { releaseShipApi } from "../api/release-ship";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function RepoShipRow({
  companyId,
  repo,
  tokenConfigured,
}: {
  companyId: string;
  repo: ReleaseShipRepo;
  tokenConfigured: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [shipped, setShipped] = useState<ReleaseShipResult | null>(null);
  const ship = useMutation({
    mutationFn: () => releaseShipApi.ship(companyId, repo.repo),
    onSuccess: (result) => {
      setShipped(result);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.releaseShip(companyId) });
    },
  });

  if (shipped) {
    return (
      <p className="text-sm">
        Shipped {shipped.shippedCommits} commit{shipped.shippedCommits === 1 ? "" : "s"} of {shipped.repo} to main
        ({shipped.mergeCommitSha.slice(0, 7)}).{" "}
        <a className="underline" href={shipped.pullRequestUrl} target="_blank" rel="noreferrer">
          View the pull request
        </a>
      </p>
    );
  }

  return (
    <div className="space-y-3 border border-border px-3 py-3">
      <div className="text-sm font-medium">
        {repo.repo}: {repo.aheadBy} commit{repo.aheadBy === 1 ? "" : "s"} in release waiting for main
      </div>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {repo.commits.map((commit) => (
          <li key={commit.sha}>
            <a className="font-mono underline" href={commit.url} target="_blank" rel="noreferrer">
              {commit.sha.slice(0, 7)}
            </a>{" "}
            {commit.message}
          </li>
        ))}
      </ul>
      {ship.error ? <p className="text-sm text-destructive">{(ship.error as Error).message}</p> : null}
      {!tokenConfigured ? (
        <p className="text-xs text-muted-foreground">
          To ship from here, add your GitHub token as the company secret {RELEASE_SHIP_TOKEN_SECRET_NAME}. Until then,
          merge release into main on GitHub.
        </p>
      ) : confirming ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={ship.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => ship.mutate()} disabled={ship.isPending}>
            {ship.isPending ? "Shipping…" : `Merge ${repo.aheadBy} commit${repo.aheadBy === 1 ? "" : "s"} into main`}
          </Button>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setConfirming(true)}>
            Ship to main
          </Button>
        </div>
      )}
    </div>
  );
}

/** Board decision: ship what the Release Manager landed in `release` to `main`. Hidden when nothing waits. */
export function ShipReleaseCard({ companyId }: { companyId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.releaseShip(companyId),
    queryFn: () => releaseShipApi.status(companyId),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const waiting = (data?.repos ?? []).filter((repo) => repo.aheadBy > 0 || repo.error);
  if (!data || waiting.length === 0) return null;

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Ship to main</CardTitle>
        <CardDescription>
          The Release Manager landed reviewed work in the release branch. Merging release into main is your decision.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5 pb-5 pt-2">
        {waiting.map((repo) =>
          repo.error ? (
            <p key={repo.repo} className="text-sm text-destructive">
              {repo.repo}: {repo.error}
            </p>
          ) : (
            <RepoShipRow key={repo.repo} companyId={companyId} repo={repo} tokenConfigured={data.tokenConfigured} />
          ),
        )}
      </CardContent>
    </Card>
  );
}
