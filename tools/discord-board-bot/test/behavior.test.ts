// Behaviour of the loops and handlers against fakes at the Discord and HTTP boundary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { pollInbox } from "../src/inbox.ts";
import { handleCommandComponent } from "../src/commands.ts";
import type { Ctx } from "../src/main.ts";
import type { AttentionItem } from "../src/paperclip.ts";

function fakeChannel() {
  const messages = new Map<string, { id: string; content?: string; embeds: { toJSON(): unknown }[]; edits: unknown[] }>();
  let next = 1;
  return {
    messages,
    send: async (p: { content?: string; embeds?: unknown[] }) => {
      const id = String(next++);
      messages.set(id, { id, content: p.content, embeds: (p.embeds ?? []).map((e) => ({ toJSON: () => e })), edits: [] });
      return { id };
    },
    messages_: null,
    get messagesApi() { return this; },
  };
}

function inboxCtx(feed: () => AttentionItem[]) {
  const channel = fakeChannel();
  const api = {
    send: channel.send,
    messages: {
      fetch: async (id: string) => {
        const m = channel.messages.get(id);
        return m && { ...m, edit: async (p: unknown) => void m.edits.push(p) };
      },
    },
  };
  const ctx = {
    cfg: { boardUserId: "111" },
    state: { inbox: {}, threads: {}, ownComments: [], warned: [], webhooks: {} },
    save: () => undefined,
    channel: async () => api,
    agents: async () => [],
    pc: {
      attention: async () => ({ items: feed(), nextCursor: null, totalCount: feed().length }),
      approval: async () => ({ id: "ap1", type: "request_board_approval", status: "pending", payload: { summary: "s" } }),
    },
  } as unknown as Ctx;
  return { ctx, channel };
}

const approval: AttentionItem = { id: "approval:approval:ap1", sourceKind: "approval", severity: "medium",
  subject: { kind: "approval", id: "ap1", title: "Ship", metadata: {} } };

test("polling twice posts an item once; when it leaves the feed the message is marked resolved", async () => {
  let feed = [approval];
  const { ctx, channel } = inboxCtx(() => feed);
  await pollInbox(ctx);
  await pollInbox(ctx);
  assert.equal(channel.messages.size, 1);
  feed = [];
  await pollInbox(ctx);
  const edits = channel.messages.get("1")?.edits as { embeds: { title: string }[]; components: unknown[] }[];
  assert.equal(edits.length, 1);
  assert.equal(edits[0].embeds[0].title, "✓ Approval: Ship");
  assert.deepEqual(edits[0].components, []);
});

test("an item still in the feed right after being resolved is not posted again (feed lag)", async () => {
  const { ctx, channel } = inboxCtx(() => [approval]);
  await pollInbox(ctx);
  ctx.state.inbox[approval.id] = { ...ctx.state.inbox[approval.id], resolved: true, resolvedAt: Date.now() };
  await pollInbox(ctx);
  assert.equal(channel.messages.size, 1);
  ctx.state.inbox[approval.id].resolvedAt = Date.now() - 180_000; // came back after a snooze
  await pollInbox(ctx);
  assert.equal(channel.messages.size, 2);
});

test("/agent raise changes only the two limits and keeps every other runtimeConfig key", async () => {
  let patched: unknown;
  const ctx = { pc: {
    agent: async () => ({ id: "a1", name: "Developer 1", status: "idle",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1, maxDailyRuns: 30 }, aiConnection: { id: "x" } } }),
    patchAgent: async (_id: string, body: unknown) => {
      patched = body;
      return { id: "a1", name: "Developer 1", status: "idle", runtimeConfig: (body as { runtimeConfig: unknown }).runtimeConfig };
    },
  } } as unknown as Ctx;
  const replies: unknown[] = [];
  const button = { isButton: () => true, customId: `ag:raise:a1:2:40:${Date.now()}`,
    update: async (p: unknown) => void replies.push(p), editReply: async (p: unknown) => void replies.push(p) };
  await handleCommandComponent(ctx, button as never);
  assert.deepEqual(patched, { runtimeConfig: {
    heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 2, maxDailyRuns: 40 }, aiConnection: { id: "x" } } });
  assert.deepEqual(replies.at(-1), { content: "**Developer 1** now runs 2 at a time, 40 per day." });
});

test("a confirm button older than two minutes does nothing", async () => {
  let called = false;
  const ctx = { pc: { agent: async () => { called = true; } } } as unknown as Ctx;
  const replies: unknown[] = [];
  const button = { isButton: () => true, customId: `ag:pause:a1:${Date.now() - 121_000}`, update: async (p: unknown) => void replies.push(p) };
  await handleCommandComponent(ctx, button as never);
  assert.equal(called, false);
  assert.deepEqual(replies, [{ content: "Expired. Run the command again.", components: [] }]);
});

test("config names the first missing setting and rejects incomplete channel maps", () => {
  assert.throws(() => loadConfig({}), /^Error: DISCORD_TOKEN is required$/);
  const base = { DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "1", DISCORD_BOARD_USER_ID: "2", PAPERCLIP_URL: "http://x", PAPERCLIP_BOARD_KEY: "k", PAPERCLIP_COMPANY_ID: "c" };
  assert.throws(() => loadConfig({ ...base, DISCORD_CHANNELS: '{"status":"1"}' }),
    /DISCORD_CHANNELS is missing channel IDs for: board-inbox, bot-status, cto, senior-dev, validation, release/);
});
