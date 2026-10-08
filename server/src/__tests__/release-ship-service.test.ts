import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, projects, projectWorkspaces } from "@paperclipai/db";
import { githubRepoFromUrl, releaseShipService } from "../services/release-ship.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("githubRepoFromUrl", () => {
  it("reads owner/name from github.com URLs and ignores other hosts", () => {
    expect(githubRepoFromUrl("https://github.com/Acme/Rocket")).toBe("Acme/Rocket");
    expect(githubRepoFromUrl("https://github.com/Acme/Rocket.git")).toBe("Acme/Rocket");
    expect(githubRepoFromUrl("git@github.com:Acme/Rocket.git")).toBe("Acme/Rocket");
    expect(githubRepoFromUrl("https://gitlab.com/Acme/Rocket")).toBeNull();
    expect(githubRepoFromUrl(null)).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describeEmbeddedPostgres("release ship service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-release-ship-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "S-Derby",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Platform" });
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "repo",
      sourceType: "git_repo",
      repoUrl: "https://github.com/Acme/Rocket",
    });
    return companyId;
  }

  it("lists what release would ship to main", async () => {
    const companyId = await seed();
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/compare/main...release")
        ? jsonResponse({
            ahead_by: 2,
            commits: [
              { sha: "aaaaaaa1", html_url: "https://github.com/Acme/Rocket/commit/aaaaaaa1", commit: { message: "docs: one\n\nbody", author: { name: "agent" } } },
              { sha: "bbbbbbb2", html_url: "https://github.com/Acme/Rocket/commit/bbbbbbb2", commit: { message: "docs: two", author: null } },
            ],
          })
        : jsonResponse([]),
    );

    const status = await releaseShipService(db, { fetch: fetchMock as unknown as typeof fetch }).status(companyId);

    expect(status).toEqual({
      tokenConfigured: false,
      repos: [
        {
          repo: "Acme/Rocket",
          aheadBy: 2,
          commits: [
            { sha: "aaaaaaa1", message: "docs: one", author: "agent", url: "https://github.com/Acme/Rocket/commit/aaaaaaa1" },
            { sha: "bbbbbbb2", message: "docs: two", author: null, url: "https://github.com/Acme/Rocket/commit/bbbbbbb2" },
          ],
          openPullRequestUrl: null,
          error: null,
        },
      ],
    });
  });

  it("refuses to ship without the Board's token and never calls GitHub to merge", async () => {
    const companyId = await seed();
    const fetchMock = vi.fn(async () => jsonResponse({}));

    await expect(
      releaseShipService(db, { fetch: fetchMock as unknown as typeof fetch }).ship(companyId, "Acme/Rocket", "user-1"),
    ).rejects.toThrow("BOARD_SHIP_GITHUB_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a repository that is not the company's", async () => {
    const companyId = await seed();
    await expect(releaseShipService(db).ship(companyId, "Someone/Else", "user-1")).rejects.toThrow("not a repository of this company");
  });
});
