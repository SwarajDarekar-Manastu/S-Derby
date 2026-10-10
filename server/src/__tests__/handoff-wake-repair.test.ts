import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { handoffWakeRepairService } from "../services/handoff-wake-repair.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("handoff wake repair: outage recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-handoff-repair-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBlocked(lastRunError: string, systemComment: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(companies).values({
      id: companyId,
      name: "S-Derby",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Developer 2", role: "engineer", status: "error",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "OCR spike", status: "blocked", assigneeAgentId: agentId, updatedAt: longAgo,
    });
    await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "on_demand", status: "failed", startedAt: longAgo, finishedAt: longAgo,
      error: lastRunError, contextSnapshot: { issueId },
    });
    await db.insert(issueComments).values({ companyId, issueId, body: systemComment, createdAt: longAgo });
    return { issueId, agentId };
  }

  const budgetSpent =
    "Paperclip retried this issue's run after it ended without finishing, but the bounded retry budget is spent and it still has no live execution path.";
  const heartbeat = () => ({ wakeup: vi.fn().mockResolvedValue({ status: "queued" }) });

  it("returns a task blocked by network errors to work once the API answers, once per cooldown", async () => {
    const { issueId, agentId } = await seedBlocked("API Error: Connection refused (ECONNREFUSED)", budgetSpent);
    const hb = heartbeat();
    const repair = handoffWakeRepairService(db, hb as never, { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 405 })) });

    expect(await repair.sweep()).toEqual({ woken: 0, recovered: 1 });
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(row?.status).toBe("in_progress");
    expect(hb.wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: "outage_recovered" }));
    const logged = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.outage_recovered")));
    expect(logged).toHaveLength(1);

    await db.update(issues).set({ status: "blocked", updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(issues.id, issueId));
    expect(await repair.sweep()).toEqual({ woken: 0, recovered: 0 });
  });

  it("leaves the task blocked while the API is still unreachable", async () => {
    const { issueId } = await seedBlocked("API Error: Connection refused (ECONNREFUSED)", budgetSpent);
    const repair = handoffWakeRepairService(db, heartbeat() as never, {
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });

    expect(await repair.sweep()).toEqual({ woken: 0, recovered: 0 });
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(row?.status).toBe("blocked");
  });

  it("does not touch a task blocked for any other reason", async () => {
    await seedBlocked("TypeError: cannot read properties of undefined", budgetSpent);
    await seedBlocked("API Error: Connection refused (ECONNREFUSED)", "Blocked: waiting on the Board's decision.");
    const repair = handoffWakeRepairService(db, heartbeat() as never, { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 405 })) });

    expect(await repair.sweep()).toEqual({ woken: 0, recovered: 0 });
  });
});
