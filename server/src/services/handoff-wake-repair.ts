import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { getExecutionBlocker } from "./execution-blocker.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

/** How long the previous run gets to finish exiting before the wake is retried. */
const SETTLE_MS = 20_000;
/** Older skips are left alone; something else has happened to those tasks since. */
const LOOKBACK_MS = 2 * 60 * 60 * 1000;

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
export function handoffWakeRepairService(db: Db, heartbeat: IssueAssignmentWakeupDeps) {
  async function findStalled(now: Date): Promise<StalledHandoff[]> {
    const settledBefore = new Date(now.getTime() - SETTLE_MS);
    const lookbackAfter = new Date(now.getTime() - LOOKBACK_MS);
    const rows = await db.execute(sql`
      with latest as (
        select distinct on (w.agent_id, w.payload->>'issueId')
          w.agent_id, w.payload->>'issueId' as issue_id, w.status, w.reason, w.created_at
        from agent_wakeup_requests w
        where w.created_at > ${lookbackAfter} and w.payload ? 'issueId'
        order by w.agent_id, w.payload->>'issueId', w.created_at desc
      )
      select i.id as "issueId", i.assignee_agent_id as "agentId", i.status
      from latest l
      join issues i on i.id::text = l.issue_id and i.assignee_agent_id = l.agent_id
      join agents a on a.id = l.agent_id
      where l.status = 'skipped'
        and l.reason = 'execution_reconciliation_required'
        and l.created_at < ${settledBefore}
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
      return { woken };
    },
  };
}
