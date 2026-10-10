import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { getExecutionBlocker } from "./execution-blocker.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logActivity } from "./activity-log.js";

/** How long the previous run gets to finish exiting before the wake is retried. */
const SETTLE_MS = 20_000;
/** Older skips are left alone; something else has happened to those tasks since. */
const LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** A blocked task is left alone this long, so a short blip settles first. */
const OUTAGE_BLOCKED_MIN_MS = 5 * 60 * 1000;
/** One automatic recovery per task in this window; a lasting failure stays visible. */
const OUTAGE_RECOVERY_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const RETRY_BUDGET_SPENT_TEXT = "bounded retry budget is spent";

interface OutageBlocked {
  issueId: string;
  companyId: string;
  agentId: string;
  inReview: boolean;
  identifier: string;
}

/** Any HTTP answer from the API means the network path works again. */
async function anthropicReachable(fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", { method: "GET", signal: AbortSignal.timeout(8_000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

interface StalledHandoff {
  issueId: string;
  agentId: string;
  status: string;
}

/**
 * A hand-off wakes the next assignee while the previous run's process is
 * still exiting. That wake is skipped with `execution_reconciliation_required`
 * and nothing retries it, so a review or a resubmitted task stalls until
 * someone comments on it. This sweep finds tasks whose assignee's latest wake
 * for the task was skipped that way, that have no run in flight, and whose
 * blocker has since cleared, and wakes the assignee again.
 */
export function handoffWakeRepairService(
  db: Db,
  heartbeat: IssueAssignmentWakeupDeps,
  deps: { fetch?: typeof fetch } = {},
) {
  const fetchImpl = deps.fetch ?? fetch;

  /**
   * Tasks Paperclip moved to `blocked` after spending the retry budget while
   * every Claude call failed on the network (an outage, a dropped connection).
   */
  async function findOutageBlocked(now: Date): Promise<OutageBlocked[]> {
    const blockedBefore = new Date(now.getTime() - OUTAGE_BLOCKED_MIN_MS);
    const cooldownAfter = new Date(now.getTime() - OUTAGE_RECOVERY_COOLDOWN_MS);
    const rows = await db.execute(sql`
      select i.id as "issueId", i.company_id as "companyId", i.assignee_agent_id as "agentId",
             (i.execution_state->>'currentStageType') is not null as "inReview", i.identifier
      from issues i
      join agents a on a.id = i.assignee_agent_id
      where i.status = 'blocked'
        and i.assignee_user_id is null
        and a.status in ('active', 'idle', 'running', 'error')
        and i.updated_at < ${blockedBefore.toISOString()}::timestamptz
        and exists (
          select 1 from issue_comments c
          where c.issue_id = i.id and c.author_agent_id is null and c.body like ${"%" + RETRY_BUDGET_SPENT_TEXT + "%"}
            and c.created_at = (select max(c2.created_at) from issue_comments c2 where c2.issue_id = i.id and c2.author_agent_id is null)
        )
        and (
          select (r.error_code = 'claude_transient_upstream' or r.error ilike '%ECONNREFUSED%' or r.error ilike '%connection refused%')
          from heartbeat_runs r
          where r.agent_id = i.assignee_agent_id and r.context_snapshot->>'issueId' = i.id::text and r.status = 'failed'
          order by r.created_at desc limit 1
        )
        and not exists (
          select 1 from activity_log l
          where l.entity_id = i.id::text and l.action = 'issue.outage_recovered' and l.created_at > ${cooldownAfter.toISOString()}::timestamptz
        )`);
    return (Array.isArray(rows) ? rows : (rows as { rows?: OutageBlocked[] }).rows ?? []) as OutageBlocked[];
  }

  async function recoverOutageBlocked(now: Date): Promise<number> {
    const blocked = await findOutageBlocked(now);
    if (blocked.length === 0 || !(await anthropicReachable(fetchImpl))) return 0;
    for (const task of blocked) {
      const status = task.inReview ? "in_review" : "in_progress";
      await db.execute(sql`update issues set status = ${status}, updated_at = now() where id = ${task.issueId} and status = 'blocked'`);
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "system",
        actorId: "outage_recovery",
        action: "issue.outage_recovered",
        entityType: "issue",
        entityId: task.issueId,
        details: { restoredStatus: status, reason: "retry budget spent on network errors; the Claude API answers again" },
      });
      await queueIssueAssignmentWakeup({
        heartbeat,
        issue: { id: task.issueId, assigneeAgentId: task.agentId, status },
        reason: "outage_recovered",
        mutation: "outage_recovered",
        contextSource: "outage_recovery",
        requestedByActorType: "system",
      });
    }
    return blocked.length;
  }

  async function findStalled(now: Date): Promise<StalledHandoff[]> {
    const settledBefore = new Date(now.getTime() - SETTLE_MS);
    const lookbackAfter = new Date(now.getTime() - LOOKBACK_MS);
    const rows = await db.execute(sql`
      with latest as (
        select distinct on (w.agent_id, w.payload->>'issueId')
          w.agent_id, w.payload->>'issueId' as issue_id, w.status, w.reason, w.created_at
        from agent_wakeup_requests w
        where w.created_at > ${lookbackAfter.toISOString()}::timestamptz and w.payload ? 'issueId'
        order by w.agent_id, w.payload->>'issueId', w.created_at desc
      )
      select i.id as "issueId", i.assignee_agent_id as "agentId", i.status
      from latest l
      join issues i on i.id::text = l.issue_id and i.assignee_agent_id = l.agent_id
      join agents a on a.id = l.agent_id
      where l.status = 'skipped'
        and l.reason = 'execution_reconciliation_required'
        and l.created_at < ${settledBefore.toISOString()}::timestamptz
        and i.status in ('todo', 'in_progress', 'in_review')
        and i.assignee_user_id is null
        and a.status in ('active', 'idle', 'running', 'error')
        and not exists (
          select 1 from heartbeat_runs r
          where r.agent_id = l.agent_id
            and r.context_snapshot->>'issueId' = l.issue_id
            and r.status in ('queued', 'running', 'scheduled_retry')
        )`);
    return (Array.isArray(rows) ? rows : (rows as { rows?: StalledHandoff[] }).rows ?? []) as StalledHandoff[];
  }

  return {
    async sweep(now = new Date()) {
      let woken = 0;
      for (const stalled of await findStalled(now)) {
        const companyRow = await db.execute(sql`select company_id from issues where id = ${stalled.issueId}`);
        const companyId = ((Array.isArray(companyRow) ? companyRow : (companyRow as { rows?: unknown[] }).rows ?? [])[0] as
          | { company_id: string }
          | undefined)?.company_id;
        if (!companyId || (await getExecutionBlocker(db, companyId, stalled.issueId))) continue;
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: { id: stalled.issueId, assigneeAgentId: stalled.agentId, status: stalled.status },
          reason: "handoff_wake_retry",
          mutation: "handoff_wake_retry",
          contextSource: "handoff_wake_repair",
          requestedByActorType: "system",
        });
        woken += 1;
      }
      const recovered = await recoverOutageBlocked(now);
      return { woken, recovered };
    },
  };
}
