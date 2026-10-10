// Regression tests for the code-review findings on 5a0abb236. Each was written to fail first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleInboxInteraction, pollInbox, rebuildInbox } from "../src/inbox.ts";
import { handleRelayMessage, pollRelay } from "../src/relay.ts";
import { handleCommand } from "../src/commands.ts";
import { inboxMessage, resolvedMessage } from "../src/render.ts";
import { PaperclipError } from "../src/paperclip.ts";
import type { Ctx } from "../src/main.ts";
import type { AttentionItem, Comment, Issue } from "../src/paperclip.ts";
import type { State } from "../src/state.ts";

const emptyState = (): State => ({ inbox: {}, threads: {}, ownComments: [], warned: [], webhooks: {} });
const BOT = "999";

/** A relay context: one tracked CTO thread, a recording webhook, and a fake Paperclip. */
function relayCtx(opts: { issueUpdatedAt: string; comments: () => Comment[]; failPosts?: number }) {
  const posted: string[] = [];
  let failures = opts.failPosts ?? 0;
  const state = emptyState();
  state.threads.i1 = { threadId: "t1", channel: "cto", status: "in_progress", assigneeAgentId: "a-cto" };
  state.webhooks.cto = { id: "w1", token: `tok-${Math.random()}` }; // fresh webhook per context
  const issue: Issue = { id: "i1", identifier: "BOT-1", title: "x", status: "in_progress", assigneeAgentId: "a-cto", updatedAt: opts.issueUpdatedAt };
  const ctx = {
    cfg: { boardUserId: "111", channels: { cto: "c-cto" } },
    state, save: () => undefined,
    agents: async () => [{ id: "a-cto", name: "CTO", status: "idle" }],
    client: {
      channels: { fetch: async () => ({ isThread: () => true, send: async (p: { content: string }) => void posted.push(`bot:${p.content}`) }) },
      fetchWebhook: async () => ({
        send: async (p: { content: string; username: string }) => {
          if (failures > 0) { failures -= 1; throw new Error("Discord 500"); }
          posted.push(`${p.username}:${p.content}`);
        },
      }),
    },
    pc: {
      issues: async (q: { updatedSince?: string }) => (!q.updatedSince || q.updatedSince <= issue.updatedAt ? [issue] : []),
      comments: async (_id: string, after?: string) => {
        const all = opts.comments();
        const at = after ? all.findIndex((c) => c.id === after) : -1;
        return after && at < 0 ? [] : all.slice(at + 1);
      },
      lastComments: async () => [...opts.comments()].reverse(),
    },
  } as unknown as Ctx;
  return { ctx, posted, state };
}

test("bug 1: an agent reply that arrived during a 5-minute outage is relayed after restart", async () => {
  const fiveMinAgo = new Date(Date.now() - 300_000).toISOString();
  const { ctx, posted, state } = relayCtx({ issueUpdatedAt: fiveMinAgo,
    comments: () => [{ id: "c1", body: "Done, merged.", createdAt: fiveMinAgo, authorAgentId: "a-cto" }] });
  state.relayCursor = new Date(Date.now() - 360_000).toISOString(); // saved before the outage
  await pollRelay(ctx);
  assert.deepEqual(posted, ["CTO:Done, merged."]);
});

test("bug 4: a failed post keeps the comment cursor, so the next poll delivers it", async () => {
  const now = new Date().toISOString();
  const { ctx, posted, state } = relayCtx({ issueUpdatedAt: now, failPosts: 1,
    comments: () => [{ id: "c1", body: "Reply", createdAt: now, authorAgentId: "a-cto" }] });
  state.relayCursor = new Date(Date.now() - 60_000).toISOString();
  await assert.rejects(pollRelay(ctx));
  assert.equal(state.threads.i1.lastCommentId, undefined);
  await pollRelay(ctx);
  assert.deepEqual(posted, ["CTO:Reply"]);
  assert.equal(state.threads.i1.lastCommentId, "c1");
});

test("bug 6: the Board's own Discord reply is not echoed back while its comment request is in flight", async () => {
  const now = new Date().toISOString();
  const stored: Comment[] = [];
  const { ctx, posted } = relayCtx({ issueUpdatedAt: now, comments: () => stored });
  ctx.state.relayCursor = new Date(Date.now() - 60_000).toISOString();
  let release!: () => void;
  (ctx.pc as unknown as { comment: unknown }).comment = async () => {
    stored.push({ id: "c-board", body: "Use 30 seconds", createdAt: now, authorUserId: "u1" });
    await pollRelay(ctx); // the server committed; the relay poll runs before the 201 arrives
    await new Promise<void>((r) => { release = r; r(); });
    return stored[0];
  };
  const message = { system: false, webhookId: null, author: { id: "111", bot: false }, content: "Use 30 seconds",
    channelId: "t1", channel: { isThread: () => true, parentId: "c-cto", send: async () => undefined }, react: async () => undefined };
  await handleRelayMessage(ctx, message as never);
  void release;
  assert.deepEqual(posted, []);
});

test("bug 9: Discord system messages in an agent channel never create tasks", async () => {
  let created = false;
  const ctx = { cfg: { boardUserId: "111", channels: { cto: "c-cto" } }, pc: { createIssue: async () => { created = true; } } } as unknown as Ctx;
  const message = { system: true, webhookId: null, author: { id: "111", bot: false }, content: "SDEA-9 thread name",
    channelId: "c-cto", channel: { isThread: () => false }, reply: async () => undefined, react: async () => undefined };
  await handleRelayMessage(ctx, message as never);
  assert.equal(created, false);
});

const failedRun: AttentionItem = { id: "failed_run:run:r1", sourceKind: "failed_run", severity: "high",
  subject: { kind: "run", id: "r1", title: "Run failed" }, detail: { errorExcerpt: "exit 1" } };

function inboxCtx(items: AttentionItem[], existing: { id: string; embedTitle: string; footer: string; components: unknown[] }[] = []) {
  const sent: unknown[] = [];
  const ctx = {
    cfg: { boardUserId: "111" }, state: emptyState(), save: () => undefined,
    client: { user: { id: BOT } },
    agents: async () => [],
    channel: async () => ({
      send: async (p: unknown) => { sent.push(p); return { id: `m${sent.length}` }; },
      messages: {
        fetch: async (arg: unknown) => typeof arg === "object"
          ? new Map(existing.map((m) => [m.id, { id: m.id, author: { id: BOT }, components: m.components,
              embeds: [{ title: m.embedTitle, footer: { text: m.footer } }] }]))
          : null,
      },
    }),
    pc: {
      attention: async () => ({ items, nextCursor: null, totalCount: items.length }),
      approval: async (id: string) => { if (id === "bad") throw new PaperclipError(404, { error: "gone" }, "/approvals/bad"); return { payload: {} }; },
    },
  } as unknown as Ctx;
  return { ctx, sent };
}

test("bug 2: after losing the state file, a still-open item without buttons is not posted again", async () => {
  const { ctx, sent } = inboxCtx([failedRun], [{ id: "m-old", embedTitle: "Failed run: Run failed", footer: "desktop: run · item:failed_run:run:r1", components: [] }]);
  await rebuildInbox(ctx);
  await pollInbox(ctx);
  assert.deepEqual(sent, []);
});

test("bug 3: one item that cannot be rendered does not block the items after it", async () => {
  const broken: AttentionItem = { id: "approval:approval:bad", sourceKind: "approval", severity: "medium", subject: { kind: "approval", id: "bad", title: "Gone" } };
  const { ctx, sent } = inboxCtx([broken, failedRun]);
  await pollInbox(ctx);
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0]), /Failed run: Run failed/);
});

test("bug 3: titles stay within Discord's 256 characters, also after the resolved mark is added", () => {
  const item: AttentionItem = { id: "productivity_review:x:1", sourceKind: "productivity_review", severity: "low",
    subject: { kind: "x", id: "1", title: "t".repeat(400) } };
  const posted = inboxMessage(item, { agentNames: new Map(), boardUserId: "111" });
  assert.ok((posted.embeds?.[0].title ?? "").length <= 256);
  assert.ok((resolvedMessage(posted, "Resolved in Paperclip").embeds?.[0].title ?? "").length <= 256);
});

function buttonInteraction(customId: string) {
  const replies: { content: string }[] = [];
  return {
    replies,
    interaction: {
      customId, message: { id: "m1" }, deferred: false, replied: false,
      isButton: () => true, isModalSubmit: () => false, isStringSelectMenu: () => false,
      deferUpdate: async function (this: { deferred: boolean }) { this.deferred = true; },
      reply: async (p: { content: string }) => void replies.push(p),
      followUp: async (p: { content: string }) => void replies.push(p),
      showModal: async () => undefined,
    },
  };
}

test("bug 7: a decision button answers within Discord's 3 seconds even when Paperclip hangs", async () => {
  const ctx = { state: emptyState(), pc: { decision: () => new Promise(() => undefined) } } as unknown as Ctx;
  const { interaction, replies } = buttonInteraction("dc:d1:0");
  const started = Date.now();
  await handleInboxInteraction(ctx, interaction as never).catch((e) => replies.push({ content: String(e) }));
  assert.ok(Date.now() - started < 3000, "answered in time");
  assert.match(replies[0]?.content ?? "", /unavailable/i);
});

test("bug 8: a 422 validation error is shown to the Board and the card stays open", async () => {
  const state = emptyState();
  state.inbox["approval:approval:a1"] = { messageId: "m1" };
  const ctx = { state, save: () => undefined,
    pc: { approve: async () => { throw new PaperclipError(422, { error: "Approval needs a note" }, "/approvals/a1/approve"); } } } as unknown as Ctx;
  const { interaction, replies } = buttonInteraction("ap:a1:approve");
  await handleInboxInteraction(ctx, interaction as never);
  assert.equal(replies[0]?.content, "Paperclip said: Approval needs a note");
  assert.equal(state.inbox["approval:approval:a1"].resolved, undefined);
});

test("bug 10: /agent raise with only a new concurrency does not invent a daily cap", async () => {
  const agent = { id: "a1", name: "Developer 2", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } };
  let content = "";
  let customId = "";
  const ctx = { cfg: { boardUserId: "111" }, agentByName: async () => agent } as unknown as Ctx;
  const interaction = {
    isAutocomplete: () => false, commandName: "agent", user: { id: "111" },
    deferReply: async () => undefined,
    options: { getSubcommand: () => "raise", getString: () => "Developer 2", getInteger: (n: string) => (n === "concurrent" ? 2 : null) },
    editReply: async (p: { content: string; components?: { components: { custom_id: string }[] }[] }) => {
      content = p.content;
      customId = p.components?.[0].components[0].custom_id ?? "";
    },
  };
  await handleCommand(ctx, interaction as never);
  assert.match(content, /Runs per day: none → \*\*none\*\*/);
  assert.match(customId, /^ag:raise:a1:2:-:\d+$/);
});

test("bug 11: a cursor comment that Paperclip returns again is not reposted", async () => {
  const now = new Date().toISOString();
  const all: Comment[] = [{ id: "c1", body: "Reply", createdAt: now, authorAgentId: "a-cto" }];
  const { ctx, posted, state } = relayCtx({ issueUpdatedAt: now, comments: () => all });
  // Paperclip before c-fix returns the anchor itself after a cursor (millisecond rounding).
  (ctx.pc as unknown as { comments: unknown }).comments = async () => all;
  state.relayCursor = new Date(Date.now() - 60_000).toISOString();
  await pollRelay(ctx);
  await pollRelay(ctx);
  assert.deepEqual(posted, ["CTO:Reply"]);
});
