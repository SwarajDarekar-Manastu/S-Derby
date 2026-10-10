// Verification harness for the Discord Board bot. Drives an isolated Paperclip
// (never the live board on :3100) and reads Discord with the bot token.
// Usage: verify.sh <command> [args]. Run `verify.sh help` for the list.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO = path.resolve(import.meta.dirname, "../../..");
const BOT_DIR = path.resolve(import.meta.dirname, "..");
const VERIFY_DIR = process.env.VERIFY_DIR ?? path.join(REPO, "tmp/bot-verify");
const DATA_DIR = path.join(VERIFY_DIR, "paperclip");
const RUN_FILE = path.join(VERIFY_DIR, "run.json");
const PAPERCLIP_LOG = path.join(VERIFY_DIR, "paperclip.log");
const BOT_LOG = path.join(VERIFY_DIR, "bot.log");
const BOT_PID = path.join(VERIFY_DIR, "bot.pid");
const BOT_STATE = path.join(VERIFY_DIR, "bot-state.json");
const PAPERCLIP_PID = path.join(VERIFY_DIR, "paperclip.pid");
const PORT = Number(process.env.VERIFY_PORT ?? 3199);
const BASE = `http://127.0.0.1:${PORT}/api`;
const LIVE_PORT = 3100;
const DECISION_AGENTS = ["CTO", "Senior Developer", "Validation Engineer", "Release Manager"];
const AGENTS = [...DECISION_AGENTS, "Developer 1", "Decider"];

if (PORT === LIVE_PORT) die("VERIFY_PORT must not be 3100, the live board");

interface Run {
  companyId: string;
  seedKey: string;
  botKey: { id: string; token: string };
  agents: Record<string, { id: string; key: string }>;
  runId: string;
}

const [command = "help", ...rest] = process.argv.slice(2);
const { values: flags, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    agent: { type: "string" }, title: { type: "string" }, status: { type: "string" },
    issue: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" },
    options: { type: "string" }, input: { type: "boolean" }, approve: { type: "boolean" },
    without: { type: "string" }, limit: { type: "string" }, "count-by-item": { type: "boolean" },
  },
});

const commands: Record<string, () => Promise<void>> = {
  help: async () => console.log(`commands:
  up | down | doctor | env
  paperclip start|stop
  bot start|stop|status [--without VAR]
  seed approval|question|confirmation|decision|task|agent-comment|board-comment|status|failed-run|pacing-pause|running
  resolve approval <id> --approve
  revoke-key
  api <path>          GET as the Board (seed key)
  activity [--limit n]
  discord <channel>   latest messages via the bot token (channel name from bot config)`),

  up: async () => {
    await startPaperclip();
    if (!existsSync(RUN_FILE)) await bootstrap();
    await commands.doctor();
  },

  down: async () => {
    stopBot();
    await stopPaperclip();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(RUN_FILE, { force: true });
    rmSync(BOT_STATE, { force: true });
    console.log(`down; evidence kept in ${path.join(VERIFY_DIR, "evidence")}`);
  },

  doctor: async () => {
    const health = await get<{ status: string; deploymentMode: string; serverInfo?: { git?: { fullSha?: string } } }>("/health");
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
    const run = loadRun();
    const company = await get<{ name: string }>(`/companies/${run.companyId}`);
    const keyOk = await fetch(`${BASE}/board-api-keys`, { headers: { authorization: `Bearer ${run.botKey.token}` } }).then((r) => r.ok);
    const checks = {
      "paperclip healthy on :3199": health.status === "ok",
      "built from this checkout's HEAD": health.serverInfo?.git?.fullSha === head,
      "company BotVerify": company.name === "BotVerify",
      "bot board key valid": keyOk,
      "database is the isolated one": dbUrl().includes(":54329/") === false,
    };
    for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (Object.values(checks).some((ok) => !ok)) process.exit(1);
  },

  env: async () => {
    const run = loadRun();
    console.log(`export CID=${run.companyId} RUN=${run.runId} VERIFY_DIR=${VERIFY_DIR}`);
  },

  paperclip: async () => {
    if (positionals[0] === "start") await startPaperclip();
    else if (positionals[0] === "stop") await stopPaperclip();
    else die("paperclip start|stop");
  },

  bot: async () => {
    const sub = positionals[0];
    if (sub === "stop") return stopBot();
    if (sub === "status") return console.log(botPid() ? `running pid ${botPid()}` : "stopped");
    if (sub !== "start") die("bot start|stop|status");
    if (botPid()) die(`bot already running (pid ${botPid()})`);
    const run = loadRun();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...botTestEnv(),
      PAPERCLIP_URL: `http://127.0.0.1:${PORT}`,
      PAPERCLIP_BOARD_KEY: run.botKey.token,
      PAPERCLIP_COMPANY_ID: run.companyId,
      BOT_STATE_FILE: BOT_STATE,
    };
    if (flags.without) delete env[flags.without];
    const out = openSync(BOT_LOG, "a");
    const child = spawn(process.execPath, ["src/main.ts"], { cwd: BOT_DIR, env, stdio: ["ignore", out, out], detached: true });
    child.unref();
    writeFileSync(BOT_PID, String(child.pid));
    await sleep(3000);
    if (!botPid()) {
      console.log(readFileSync(BOT_LOG, "utf8").split("\n").slice(-15).join("\n"));
      die("bot exited during startup");
    }
    console.log(`bot started, pid ${child.pid}, log ${BOT_LOG}`);
  },

  seed: async () => {
    const kind = positionals[0];
    const run = loadRun();
    const tag = `[v-${run.runId}]`;
    const agentId = (name = flags.agent ?? "CTO") => run.agents[name]?.id ?? die(`unknown agent ${name}`);
    switch (kind) {
      case "approval": {
        const a = await post<{ id: string }>(`/companies/${run.companyId}/approvals`, {
          type: "request_board_approval",
          requestedByAgentId: agentId(),
          payload: { title: flags.title ?? `Approve probe ${tag}`, summary: flags.body ?? "Ship the probe build to staging." },
        });
        return print({ approvalId: a.id });
      }
      case "task": {
        const issue = await post<{ id: string; identifier: string }>(`/companies/${run.companyId}/issues`, {
          title: flags.title ?? `Probe task ${tag}`, description: flags.body ?? "Seeded by verify.sh",
          assigneeAgentId: agentId(), status: flags.status ?? "todo",
        });
        return print({ issueId: issue.id, identifier: issue.identifier });
      }
      case "question":
      case "confirmation": {
        const issue = flags.issue ?? (await post<{ id: string }>(`/companies/${run.companyId}/issues`, {
          title: flags.title ?? `${kind} probe ${tag}`, assigneeAgentId: agentId(),
        })).id;
        const payload = kind === "question"
          ? { version: 1, title: flags.title ?? `Question probe ${tag}`, questions: [{ id: "q1", prompt: "Which option should we take?", selectionMode: "single",
              options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] }] }
          : { version: 1, prompt: flags.title ?? `Ship the probe? ${tag}` };
        const i = await post<{ id: string }>(`/issues/${issue}/interactions`, {
          kind: kind === "question" ? "ask_user_questions" : "request_confirmation", payload,
        });
        return print({ issueId: issue, interactionId: i.id });
      }
      case "decision": {
        const optionCount = Number(flags.options ?? 2);
        const spec = {
          title: flags.title ?? `Decision probe ${tag} #${Date.now() % 100000}`,
          body: "Pick how the probe should proceed.",
          options: Array.from({ length: optionCount }, (_, n) => ({ id: `opt${n + 1}`, label: `Option ${n + 1}`, effects: [] })),
          ...(flags.input ? { inputs: [{ id: "why", label: "Why", required: true }] } : {}),
        };
        const decider = run.agents.Decider;
        await patch(`/agents/${decider.id}`, { adapterConfig: agentPostConfig(decider.key, `/companies/${run.companyId}/decisions`, spec) });
        // Decisions need an issue-scoped run: assigning a task to the Decider starts one.
        await post(`/companies/${run.companyId}/issues`, { title: `Decision host ${tag}`, assigneeAgentId: decider.id, status: "todo" });
        for (let n = 0; n < 40; n++) {
          await sleep(1000);
          const open = await get<{ id: string; title: string }[]>(`/companies/${run.companyId}/decisions?status=open`);
          const found = open.find((d) => d.title === spec.title);
          if (found) return print({ decisionId: found.id });
        }
        return die("decision was not created within 40 s; see the Decider agent's run log");
      }
      case "agent-comment": {
        // Agent comments must come from the agent's own run on that issue.
        const agent = run.agents[flags.agent ?? "CTO"] ?? die(`unknown agent ${flags.agent}`);
        const issue = await get<{ id: string }>(`/issues/${flags.issue ?? die("--issue required")}`);
        const body = flags["body-file"] ? readFileSync(path.resolve(BOT_DIR, "verify", flags["body-file"]), "utf8") : flags.body ?? `Agent reply ${tag}`;
        const before = await get<{ id: string }[]>(`/issues/${issue.id}/comments`);
        const original = await get<{ runtimeConfig: Record<string, unknown> }>(`/agents/${agent.id}`);
        await patch(`/agents/${agent.id}`, {
          adapterConfig: agentPostConfig(agent.key, `/issues/${issue.id}/comments`, { body }),
          runtimeConfig: { ...original.runtimeConfig, heartbeat: { ...(original.runtimeConfig.heartbeat as object), wakeOnDemand: true } },
        });
        try {
          await post(`/agents/${agent.id}/wakeup`, { source: "on_demand", reason: "verify.sh agent-comment", payload: { issueId: issue.id } });
          for (let n = 0; n < 40; n++) {
            await sleep(1000);
            const after = await get<{ id: string; body: string }[]>(`/issues/${issue.id}/comments`);
            const added = after.find((c) => !before.some((b) => b.id === c.id) && c.body === body);
            if (added) return print({ commentId: added.id });
          }
          return die("agent comment was not created within 40 s; see the agent's run log");
        } finally {
          await patch(`/agents/${agent.id}`, { adapterConfig: { command: "true" }, runtimeConfig: original.runtimeConfig });
        }
      }
      case "board-comment": {
        const c = await post<{ id: string }>(`/issues/${flags.issue ?? die("--issue required")}/comments`, { body: flags.body ?? `Board comment ${tag}` });
        return print({ commentId: c.id });
      }
      case "status": {
        const i = await patch(`/issues/${flags.issue ?? die("--issue required")}`, { status: flags.status ?? die("--status required") });
        return print(i);
      }
      case "failed-run": {
        const id = agentId(flags.agent ?? "Developer 1");
        await patch(`/agents/${id}`, { adapterConfig: { command: "false" } });
        const w = await post(`/agents/${id}/wakeup`, { source: "on_demand", reason: "verify.sh failed-run" });
        await sleep(5000);
        await patch(`/agents/${id}`, { adapterConfig: { command: "true" } });
        return print(w);
      }
      case "running": {
        const id = agentId(flags.agent ?? "Developer 1");
        const issue = await post<{ id: string; identifier: string }>(`/companies/${run.companyId}/issues`, {
          title: `Long run ${tag}`, assigneeAgentId: id, status: "todo" });
        await patch(`/agents/${id}`, { adapterConfig: { command: "sleep", args: ["600"] } });
        await post(`/agents/${id}/wakeup`, { source: "on_demand", reason: "verify.sh running", payload: { issueId: issue.id } });
        return print({ issueId: issue.id, identifier: issue.identifier, note: "reset with: verify.sh seed status --issue <id> --status todo" });
      }
      case "pacing-pause": {
        const id = agentId(flags.agent ?? "Developer 1");
        await sqlExec(`update agents set status = 'paused', pause_reason = 'subscription_pacing', paused_at = now() where id = $1`, [id]);
        return print({ agentId: id, pauseReason: "subscription_pacing" });
      }
      default:
        die("seed approval|question|confirmation|decision|task|agent-comment|board-comment|status|failed-run|pacing-pause|running");
    }
  },

  resolve: async () => {
    const [kind, id] = positionals;
    if (kind !== "approval" || !id) die("resolve approval <id> --approve");
    print(await post(`/approvals/${id}/${flags.approve ? "approve" : "reject"}`, { decisionNote: "verify.sh" }));
  },

  "revoke-key": async () => {
    const run = loadRun();
    await call("DELETE", `/board-api-keys/${run.botKey.id}`);
    console.log(`revoked bot key ${run.botKey.id}`);
  },

  api: async () => print(await get(positionals[0] ?? die("api <path>"))),

  activity: async () => {
    const run = loadRun();
    const rows = await get<{ action: string; actorType: string; actorId: string; entityType: string; entityId: string; createdAt: string }[]>(
      `/companies/${run.companyId}/activity?limit=${flags.limit ?? 20}`);
    for (const r of rows) console.log(`${r.createdAt}  ${r.action.padEnd(36)} ${r.actorType}:${r.actorId}  ${r.entityType}:${r.entityId}`);
  },

  discord: async () => {
    const env = botTestEnv();
    const name = positionals[0] ?? die("discord <channel>");
    const channels = JSON.parse(env.DISCORD_CHANNELS ?? "{}") as Record<string, string>;
    const channelId = channels[name] ?? name;
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${flags.limit ?? 20}`, {
      headers: { authorization: `Bot ${env.DISCORD_TOKEN}` } });
    const messages = await res.json() as { id: string; author: { username: string }; content: string; pinned: boolean;
      embeds: unknown[]; components: unknown[]; webhook_id?: string }[];
    if (!res.ok) die(`Discord ${res.status}: ${JSON.stringify(messages)}`);
    if (flags["count-by-item"]) {
      const counts: Record<string, number> = {};
      for (const m of messages) for (const id of JSON.stringify(m.components).match(/item:[^"|]+/g) ?? []) counts[id] = (counts[id] ?? 0) + 1;
      return print(counts);
    }
    print(messages.map((m) => ({ id: m.id, author: m.author.username, webhook: Boolean(m.webhook_id), pinned: m.pinned,
      content: m.content, embeds: m.embeds, components: m.components })));
  },

  // Runs the bot's status and inbox code against the isolated Paperclip with Discord replaced by a recorder.
  preview: async () => {
    const run = loadRun();
    const { paperclipClient } = await import("../src/paperclip.ts");
    const { refreshStatus } = await import("../src/status.ts");
    const { pollInbox } = await import("../src/inbox.ts");
    const sent: { channel: string; payload: unknown }[] = [];
    const recorder = (name: string) => ({
      send: async (payload: unknown) => { sent.push({ channel: name, payload }); return { id: String(sent.length), pin: async () => undefined }; },
      messages: { edit: async () => undefined, fetch: async () => null },
    });
    const pc = paperclipClient(`http://127.0.0.1:${PORT}`, run.botKey.token, run.companyId);
    const ctx = {
      cfg: { boardUserId: "100000000000000001" }, pc,
      state: { inbox: {}, threads: {}, ownComments: [], warned: [], webhooks: {} }, save: () => undefined,
      channel: async (name: string) => recorder(name),
      agents: () => pc.agents(),
      agentByName: async (n: string) => (await pc.agents()).find((a) => a.name === n),
    } as never;
    await refreshStatus(ctx);
    await pollInbox(ctx);
    print(positionals[0] ? sent.filter((s) => s.channel === positionals[0]) : sent);
  },

  // Runs inside an agent's process run: posts VERIFY_BODY to VERIFY_PATH with that run's context.
  "agent-post": async () => {
    const api = process.env.PAPERCLIP_API_URL ?? "";
    if (!api.includes(`:${PORT}`)) die(`refusing: PAPERCLIP_API_URL ${api} is not the isolated instance`);
    const res = await fetch(`${api}/api${process.env.VERIFY_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.VERIFY_AGENT_KEY}`, "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID ?? "",
        "content-type": "application/json" },
      body: process.env.VERIFY_BODY,
    });
    console.log(res.status, (await res.text()).slice(0, 500));
  },
};

function agentPostConfig(agentKey: string, apiPath: string, body: unknown) {
  return { command: process.execPath, args: [path.join(BOT_DIR, "verify/harness.ts"), "agent-post"],
    env: { VERIFY_AGENT_KEY: agentKey, VERIFY_PATH: apiPath, VERIFY_BODY: JSON.stringify(body) } };
}

async function startPaperclip() {
  mkdirSync(VERIFY_DIR, { recursive: true });
  if (await get("/health").then(() => true, () => false)) return;
  const env: Record<string, string | undefined> = {
    ...process.env, PORT: String(PORT), HOST: "127.0.0.1",
    PAPERCLIP_RUNNER_BINARY: "/bin/false", // no native runner; verification agents use the process adapter
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted", PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    PAPERCLIP_OPEN_ON_LISTEN: "false", PAPERCLIP_DISABLE_CWD_ENV_FILE: "true",
  };
  for (const key of Object.keys(env)) if (key.startsWith("DATABASE_")) delete env[key];
  const out = openSync(PAPERCLIP_LOG, "a");
  const child = spawn("pnpm", ["dev:once", "--data-dir", DATA_DIR], { cwd: REPO, env, stdio: ["ignore", out, out], detached: true });
  child.unref();
  writeFileSync(PAPERCLIP_PID, String(child.pid));
  for (let n = 0; n < 150; n++) {
    await sleep(2000);
    if (await get("/health").then(() => true, () => false)) return console.log(`paperclip ready on :${PORT}`);
  }
  die(`paperclip did not become healthy; see ${PAPERCLIP_LOG}`);
}

// Stop only the process group this harness started, and wait until the port is free.
async function stopPaperclip() {
  if (!existsSync(PAPERCLIP_PID)) return console.log("no paperclip started by this harness");
  const pgid = Number(readFileSync(PAPERCLIP_PID, "utf8"));
  const signal = (s: NodeJS.Signals | 0) => { try { process.kill(-pgid, s); return true; } catch { return false; } };
  if (signal("SIGTERM")) {
    for (let n = 0; n < 30 && (await get("/health").then(() => true, () => false)); n++) await sleep(1000);
    for (let n = 0; n < 10 && signal(0); n++) await sleep(1000);
    signal("SIGKILL");
  }
  rmSync(PAPERCLIP_PID, { force: true });
  console.log(`stopped paperclip process group ${pgid}`);
}

async function bootstrap() {
  const company = await post<{ id: string }>("/companies", { name: "BotVerify" });
  const mint = (name: string) => post<{ id: string; token: string }>("/board-api-keys",
    { name, expiresAt: null, requestedCompanyId: company.id });
  const seedKey = await mint("verify-seed");
  const botKey = await mint("verify-bot");
  const run: Run = { companyId: company.id, seedKey: seedKey.token, botKey: { id: botKey.id, token: botKey.token }, agents: {},
    runId: Date.now().toString(36) };
  writeFileSync(RUN_FILE, JSON.stringify(run, null, 2), { mode: 0o600 });
  for (const name of AGENTS) {
    const agent = await post<{ id: string }>(`/companies/${company.id}/agents`, {
      name, role: name === "CTO" ? "cto" : "engineer", adapterType: "process", adapterConfig: { command: "true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: name === "Decider", maxConcurrentRuns: 1, maxDailyRuns: 30 } },
    });
    const key = await post<{ token: string }>(`/agents/${agent.id}/keys`, { name: "verify" });
    run.agents[name] = { id: agent.id, key: key.token };
  }
  writeFileSync(RUN_FILE, JSON.stringify(run, null, 2), { mode: 0o600 });
  // Pacing would undo seeded pacing pauses within a minute; verification seeds them by hand instead.
  const pacing = await get<{ policy: { plans: Record<string, { autoPause: boolean }> } }>(`/companies/${company.id}/costs/subscription-pacing`);
  for (const plan of Object.values(pacing.policy.plans)) plan.autoPause = false;
  await call("PUT", `/companies/${company.id}/costs/subscription-pacing`, pacing.policy);
  console.log(`bootstrapped company ${company.id} with ${AGENTS.length} agents`);
}

function botTestEnv(): Record<string, string> {
  const file = process.env.BOT_TEST_ENV ?? path.join(process.env.HOME ?? "", ".config/sderby-discord-bot/test.env");
  if (!existsSync(file)) die(`missing ${file}: DISCORD_TOKEN, DISCORD_GUILD_ID, DISCORD_BOARD_USER_ID, DISCORD_CHANNELS for S-Derby Test`);
  return Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

function dbUrl() {
  const line = readFileSync(PAPERCLIP_LOG, "utf8").split("\n").reverse().find((l) => l.includes("Using embedded PostgreSQL"));
  const port = line?.match(/port=(\d+)/)?.[1];
  const dataDir = line?.match(/dataDir=([^,]+)/)?.[1];
  if (!port || !dataDir?.startsWith(VERIFY_DIR)) die("cannot find the isolated embedded Postgres in the log");
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

async function sqlExec(text: string, params: unknown[]) {
  const requireFromDb = createRequire(path.join(REPO, "packages/db/package.json"));
  const postgres = requireFromDb("postgres") as (url: string, o: object) => { unsafe: (q: string, p: unknown[]) => Promise<unknown>; end: () => Promise<void> };
  const sql = postgres(dbUrl(), { max: 1 });
  try { await sql.unsafe(text, params); } finally { await sql.end(); }
}

function loadRun(): Run {
  if (!existsSync(RUN_FILE)) die("no run.json; run `verify.sh up` first");
  return JSON.parse(readFileSync(RUN_FILE, "utf8")) as Run;
}

async function call<T>(method: string, p: string, body?: unknown, key?: string): Promise<T> {
  const token = key ?? (existsSync(RUN_FILE) ? loadRun().seedKey : undefined);
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : null) as T;
}
const get = <T = unknown>(p: string) => call<T>("GET", p);
const post = <T = unknown>(p: string, body: unknown) => call<T>("POST", p, body);
const patch = <T = unknown>(p: string, body: unknown) => call<T>("PATCH", p, body);

function botPid(): number | null {
  if (!existsSync(BOT_PID)) return null;
  const pid = Number(readFileSync(BOT_PID, "utf8"));
  try { process.kill(pid, 0); return pid; } catch { return null; }
}
function stopBot() {
  const pid = botPid();
  if (pid) { process.kill(pid, "SIGTERM"); console.log(`stopped bot pid ${pid}`); }
  rmSync(BOT_PID, { force: true });
}
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function die(message: string): never { console.error(message); process.exit(1); }

const handler = commands[command] ?? (() => die(`unknown command ${command}; try help`));
await handler().catch((error: Error) => die(error.message));
