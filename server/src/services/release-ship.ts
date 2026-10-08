import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import {
  RELEASE_SHIP_TOKEN_SECRET_NAME,
  type ReleaseShipRepo,
  type ReleaseShipResult,
  type ReleaseShipStatus,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";

const GITHUB_API = "https://api.github.com";
const RELEASE_BRANCH = "release";
const MAIN_BRANCH = "main";

/** `owner/name` for a github.com repository URL, or null for anything else. */
export function githubRepoFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^(?:https:\/\/|git@)(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

type FetchLike = typeof fetch;

export function releaseShipService(db: Db, deps: { fetch?: FetchLike } = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const secrets = secretService(db);

  async function boardToken(companyId: string, actorUserId: string | null): Promise<string | null> {
    const secret = await Promise.resolve(secrets.getByName(companyId, RELEASE_SHIP_TOKEN_SECRET_NAME)).catch(() => null);
    if (!secret) return null;
    const value = await secrets
      .resolveSecretValue(companyId, secret.id, "latest", {
        accessContext: {
          consumerType: "system",
          consumerId: "release-ship",
          actorType: actorUserId ? "user" : "system",
          responsibleUserId: actorUserId,
        },
      })
      .then((v) => v.trim())
      .catch(() => "");
    return value || null;
  }

  async function github<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const message = (data && typeof data === "object" && "message" in data ? String(data.message) : text) || res.statusText;
      throw Object.assign(new Error(`GitHub ${method} ${path}: ${res.status} ${message}`), { status: res.status });
    }
    return data as T;
  }

  /** Repositories of the company's project workspaces that live on github.com. */
  async function companyRepos(companyId: string): Promise<string[]> {
    const rows = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, companyId), isNotNull(projectWorkspaces.repoUrl)));
    return [...new Set(rows.map((row) => githubRepoFromUrl(row.repoUrl)).filter((repo): repo is string => repo !== null))];
  }

  async function repoStatus(token: string | null, repo: string): Promise<ReleaseShipRepo> {
    try {
      const compare = await github<{
        ahead_by: number;
        commits: Array<{ sha: string; html_url: string; commit: { message: string; author: { name?: string } | null } }>;
      }>(token, "GET", `/repos/${repo}/compare/${MAIN_BRANCH}...${RELEASE_BRANCH}`);
      const [owner] = repo.split("/");
      const pulls = await github<Array<{ html_url: string }>>(
        token,
        "GET",
        `/repos/${repo}/pulls?state=open&base=${MAIN_BRANCH}&head=${owner}:${RELEASE_BRANCH}`,
      );
      return {
        repo,
        aheadBy: compare.ahead_by,
        commits: compare.commits.map((c) => ({
          sha: c.sha,
          message: c.commit.message.split("\n")[0] ?? "",
          author: c.commit.author?.name ?? null,
          url: c.html_url,
        })),
        openPullRequestUrl: pulls[0]?.html_url ?? null,
        error: null,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = status === 404 ? `No \`${RELEASE_BRANCH}\` branch in ${repo}.` : (err as Error).message;
      return { repo, aheadBy: 0, commits: [], openPullRequestUrl: null, error: message };
    }
  }

  return {
    async status(companyId: string): Promise<ReleaseShipStatus> {
      const token = await boardToken(companyId, null);
      const repos = await Promise.all((await companyRepos(companyId)).map((repo) => repoStatus(token, repo)));
      return { tokenConfigured: token !== null, repos: repos.filter((r) => r.error === null || !r.error.startsWith("No `")) };
    },

    /** Open (or reuse) the release → main pull request and merge it with the Board's token. */
    async ship(companyId: string, repo: string, actorUserId: string | null): Promise<ReleaseShipResult> {
      if (!(await companyRepos(companyId)).includes(repo)) throw notFound(`${repo} is not a repository of this company`);
      const token = await boardToken(companyId, actorUserId);
      if (!token) {
        throw unprocessable(`Add the Board's GitHub token as the company secret ${RELEASE_SHIP_TOKEN_SECRET_NAME} first.`);
      }
      const status = await repoStatus(token, repo);
      if (status.error) throw unprocessable(status.error);
      if (status.aheadBy === 0) throw conflict(`Nothing to ship: ${RELEASE_BRANCH} has no commits that ${MAIN_BRANCH} lacks.`);

      const pr = status.openPullRequestUrl
        ? await github<{ number: number; html_url: string }>(
            token,
            "GET",
            `/repos/${repo}/pulls/${status.openPullRequestUrl.split("/").pop()}`,
          )
        : await github<{ number: number; html_url: string }>(token, "POST", `/repos/${repo}/pulls`, {
            title: `Ship release to main (${status.aheadBy} commit${status.aheadBy === 1 ? "" : "s"})`,
            head: RELEASE_BRANCH,
            base: MAIN_BRANCH,
            body: [
              "Shipped by the Board from Paperclip (Decisions, Ship to main).",
              "",
              ...status.commits.map((c) => `- ${c.message} (${c.sha.slice(0, 7)})`),
            ].join("\n"),
          });
      const merged = await github<{ sha: string; merged: boolean; message: string }>(
        token,
        "PUT",
        `/repos/${repo}/pulls/${pr.number}/merge`,
        { merge_method: "merge" },
      ).catch((err: Error & { status?: number }) => {
        throw unprocessable(`GitHub refused the merge of ${pr.html_url}: ${err.message}`);
      });
      const result: ReleaseShipResult = {
        repo,
        pullRequestUrl: pr.html_url,
        mergeCommitSha: merged.sha,
        shippedCommits: status.aheadBy,
      };
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "release.shipped",
        entityType: "company",
        entityId: companyId,
        details: { ...result, commits: status.commits.map((c) => c.sha) },
      });
      return result;
    },
  };
}
