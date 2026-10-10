import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inboxMessage, redact, resolvedMessage, split, statusBoard, statusNotice, taskFromMessage, threadName, warnings, type StatusInput,
} from "../src/render.ts";
import type { Agent, AttentionItem } from "../src/paperclip.ts";

const BOARD = "111";
const names = new Map([["a-cto", "CTO"]]);
const item = (over: Partial<AttentionItem>): AttentionItem => ({
  id: "approval:approval:ap1", sourceKind: "approval", severity: "medium", whyNow: "Approval is pending a board decision.",
  subject: { kind: "approval", id: "ap1", title: "Ship v2", metadata: { type: "request_board_approval", requestedByAgentId: "a-cto" } },
  ...over,
});

test("redacts every known token format and leaves other text alone", () => {
  assert.equal(
    redact("key pcp_board_0123456789abcdef and ghp_abcdefghijklmnopqrstuvwx and sk-ant-abcdefghijklmnop1234 and xoxb-1234567890-abc ok"),
    "key [redacted] and [redacted] and [redacted] and [redacted] ok",
  );
});

test("splits a 3,500-character reply on a paragraph boundary into ordered parts that rebuild the text", () => {
  const first = "a".repeat(1500);
  const second = "b".repeat(1500);
  const third = "c".repeat(400);
  const parts = split(`${first}\n\n${second}\n\n${third}`);
  assert.deepEqual(parts, [first, `${second}\n\n${third}`]);
  assert.ok(parts.every((p) => p.length <= 2000));
});

test("an approval mentions only the Board and offers Approve and Reject", () => {
  const p = inboxMessage(item({}), { agentNames: names, boardUserId: BOARD, approvalPayload: { summary: "Deploy the release." } });
  assert.equal(p.content, "<@111> Approval needs you");
  assert.deepEqual(p.allowed_mentions, { parse: [], users: ["111"] });
  assert.equal(p.embeds?.[0].title, "Approval: Ship v2");
  assert.match(p.embeds?.[0].description ?? "", /Deploy the release\./);
  assert.deepEqual(p.embeds?.[0].fields?.[0], { name: "Requested by", value: "CTO", inline: true });
  assert.deepEqual(p.components?.[0].components.map((c) => c.custom_id), ["ap:ap1:approve", "ap:ap1:reject"]);
  assert.equal(p.embeds?.[0].footer?.text, "desktop: approval · item:approval:approval:ap1");
});

test("a failed run is shown in full without buttons or a ping", () => {
  const p = inboxMessage(item({ id: "failed_run:run:r1", sourceKind: "failed_run", subject: { kind: "run", id: "r1", title: "Run failed" },
    detail: { kind: "run", errorExcerpt: "Adapter failed: exit 1" } }), { agentNames: names, boardUserId: BOARD });
  assert.equal(p.content, "Failed run");
  assert.deepEqual(p.allowed_mentions, { parse: [] });
  assert.deepEqual(p.components, []);
  assert.match(p.embeds?.[0].description ?? "", /Adapter failed: exit 1\n\n\*\*Needs the desktop\.\*\*/);
});

test("a decision with seven options gets two button rows of five and two", () => {
  const options = Array.from({ length: 7 }, (_, n) => ({ id: `o${n}`, label: `Choice ${n}` }));
  const p = inboxMessage(item({ id: "decision:decision:d1", sourceKind: "decision", subject: { kind: "decision", id: "d1", title: "Pick" } }),
    { agentNames: names, boardUserId: BOARD, decision: { id: "d1", title: "Pick", body: "Which?", status: "open", options } });
  assert.deepEqual(p.components?.map((r) => r.components.length), [5, 2]);
  assert.equal(p.components?.[1].components[1].custom_id, "dc:d1:6");
});

test("a two-question card gets one select menu per question, multi-select where allowed", () => {
  const p = inboxMessage(item({ id: "issue_thread_interaction:interaction:i1", sourceKind: "issue_thread_interaction",
    subject: { kind: "interaction", id: "i1", title: "Questions", metadata: { issueId: "is1", kind: "ask_user_questions" } } }), {
    agentNames: names, boardUserId: BOARD,
    interaction: { id: "i1", kind: "ask_user_questions", status: "pending", payload: { questions: [
      { id: "q1", prompt: "Which DB?", selectionMode: "single", options: [{ id: "pg", label: "Postgres" }, { id: "my", label: "MySQL" }] },
      { id: "q2", prompt: "Which regions?", selectionMode: "multiple", options: [{ id: "eu", label: "EU" }, { id: "us", label: "US" }, { id: "in", label: "IN" }] },
    ] } },
  });
  const selects = p.components?.map((r) => r.components[0]) as { custom_id: string; max_values: number }[];
  assert.deepEqual(selects.map((s) => [s.custom_id, s.max_values]), [["qs:is1:i1:0", 1], ["qs:is1:i1:1", 3]]);
});

test("a resolved message loses its buttons and its ping and states the outcome", () => {
  const before = inboxMessage(item({}), { agentNames: names, boardUserId: BOARD, approvalPayload: {} });
  const after = resolvedMessage(before, "Approved by the Board via Discord");
  assert.equal(after.content, "Approval needs you");
  assert.deepEqual(after.components, []);
  assert.equal(after.embeds?.[0].title, "✓ Approval: Ship v2");
  assert.match(after.embeds?.[0].description ?? "", /^\*\*Approved by the Board via Discord\*\*/);
});

const agent = (name: string, over: Partial<Agent> = {}): Agent => ({ id: `id-${name}`, name, status: "idle",
  runtimeConfig: { heartbeat: { maxDailyRuns: 20, maxConcurrentRuns: 1 } }, ...over });

const statusInput = (over: Partial<StatusInput> = {}): StatusInput => ({
  agents: [
    { agent: agent("CTO", { status: "running" }), running: true, runsToday: 3,
      task: { id: "t1", identifier: "SDEA-61", title: "Discord inbox", status: "in_progress", updatedAt: "2026-10-10T09:00:00Z" },
      statement: { id: "c1", body: "Planning the inbox  layout", createdAt: "2026-10-10T09:00:00Z" } },
    { agent: agent("Developer 1", { status: "paused", pauseReason: "subscription_pacing" }), running: false, runsToday: 0, task: null, statement: null },
  ],
  quota: [{ provider: "anthropic", ok: true, windows: [
    { label: "Current session", usedPercent: 91, resetsAt: "2026-10-10T09:50:00Z" },
    { label: "Current week (all models)", usedPercent: 11, resetsAt: "2026-10-15T23:00:00Z" },
  ] }, { provider: "openai", ok: false, windows: [] }],
  pacing: { policy: { plans: { anthropic: { autoPause: true, sessionPauseAtPercent: 90, weeklyPauseAtPercent: 95 } } },
    agents: [{ agentId: "id-Developer 1", agentName: "Developer 1", provider: "anthropic", status: "paused", pauseReason: "subscription_pacing" }] },
  counts: { open: 4, inProgress: 1, blocked: 0, done: 21, pendingApprovals: 2 },
  usedProviders: ["anthropic"],
  now: "2026-10-10T09:30:00Z",
  ...over,
});

test("the status board shows the CTO card, the team, the subscription windows and the counts", () => {
  const p = statusBoard(statusInput());
  assert.deepEqual(p.embeds?.map((e) => e.title), ["CTO", "Team", "Subscription and tasks"]);
  assert.equal(p.embeds?.[0].description,
    "**▶ running** · runs today 3/20\nTask: `SDEA-61` Discord inbox · in progress\n> Planning the inbox layout\n<t:1791622800:R>");
  assert.equal(p.embeds?.[1].description, "**Developer 1** · ⏸ paused (subscription pacing)");
  assert.equal(p.embeds?.[2].description, [
    "**anthropic · Current session**: 91% · resets <t:1791625800:R>",
    "**anthropic · Current week (all models)**: 11% · resets <t:1792105200:R>",
    "Pacing pauses agents at 90% of the session and 95% of the week",
    "Paused by pacing: Developer 1",
    "",
    "Tasks: 4 open · 1 in progress · 0 blocked · 21 done",
    "Pending approvals: 2",
  ].join("\n"));
  assert.deepEqual(p.allowed_mentions, { parse: [] });
});

test("warnings: session over 75% without a ping, a pacing pause with a ping, keys stable per window", () => {
  const w = warnings(statusInput());
  assert.deepEqual(w.map((x) => [x.key, x.ping]), [
    ["quota:anthropic:Current session:2026-10-10T09:50:00Z", false],
    ["paced:id-Developer 1", true],
  ]);
});

test("relay helpers: thread names fit Discord, first line becomes the title, notices name what changed", () => {
  assert.equal(threadName({ identifier: "SDEA-9", title: "x".repeat(200) }).length, 100);
  assert.deepEqual(taskFromMessage("Fix login\nIt times out after 5s"), { title: "Fix login", description: "Fix login\nIt times out after 5s" });
  assert.equal(statusNotice({ identifier: "SDEA-9", status: "done" }, "CTO", { status: "in_progress", assignee: "CTO" }), "`SDEA-9` status → **done**");
  assert.equal(statusNotice({ identifier: "SDEA-9", status: "todo" }, "Senior Developer", { status: "todo", assignee: "CTO" }), "`SDEA-9` reassigned to **Senior Developer**");
  assert.equal(statusNotice({ identifier: "SDEA-9", status: "todo" }, "CTO", { status: "todo", assignee: "CTO" }), null);
});
