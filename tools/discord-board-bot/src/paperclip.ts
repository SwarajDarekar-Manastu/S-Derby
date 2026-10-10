export class PaperclipError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, path: string) {
    const detail = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : String(body);
    super(`Paperclip ${status} on ${path}: ${detail}`);
    this.status = status;
    this.body = body;
  }
  /** Paperclip's own explanation, safe to show to the Board. */
  get reason(): string {
    const body = this.body as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : this.message;
  }
}

/** Network failure or 5xx: Paperclip is down or restarting. */
export class PaperclipUnavailable extends Error {}

export type Paperclip = ReturnType<typeof paperclipClient>;

export function paperclipClient(baseUrl: string, boardKey: string, companyId: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${boardKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new PaperclipUnavailable(`Paperclip unreachable: ${(error as Error).message}`);
    }
    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : null;
    if (res.status >= 500) throw new PaperclipUnavailable(`Paperclip ${res.status} on ${path}`);
    if (!res.ok) throw new PaperclipError(res.status, parsed, path);
    return parsed as T;
  }
  const c = `/companies/${companyId}`;
  const q = (params: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
    const out = s.toString();
    return out ? `?${out}` : "";
  };

  return {
    companyId,
    health: () => call<{ status: string }>("GET", "/health"),
    myKeys: () => call<BoardKey[]>("GET", "/board-api-keys"),

    attention: (cursor?: string) => call<AttentionPage>("GET", `${c}/attention${q({ limit: 100, cursor })}`),
    approval: (id: string) => call<Approval>("GET", `/approvals/${id}`),
    approve: (id: string, decisionNote?: string) => call("POST", `/approvals/${id}/approve`, { decisionNote }),
    reject: (id: string, decisionNote?: string) => call("POST", `/approvals/${id}/reject`, { decisionNote }),
    decision: (id: string) => call<Decision>("GET", `/decisions/${id}`),
    decide: (id: string, optionId: string, inputValues: Record<string, string> | undefined, idempotencyKey: string) =>
      call("POST", `/decisions/${id}/decide`, { optionId, inputValues, idempotencyKey }),
    interactions: (issueId: string) => call<Interaction[]>("GET", `/issues/${issueId}/interactions`),
    respond: (issueId: string, id: string, answers: { questionId: string; optionIds: string[]; otherText?: string }[]) =>
      call("POST", `/issues/${issueId}/interactions/${id}/respond`, { answers }),
    accept: (issueId: string, id: string) => call("POST", `/issues/${issueId}/interactions/${id}/accept`, {}),
    rejectInteraction: (issueId: string, id: string) => call("POST", `/issues/${issueId}/interactions/${id}/reject`, {}),

    agents: () => call<Agent[]>("GET", `${c}/agents`),
    agent: (id: string) => call<Agent>("GET", `/agents/${id}`),
    patchAgent: (id: string, body: Record<string, unknown>) => call<Agent>("PATCH", `/agents/${id}`, body),
    pause: (id: string) => call<Agent>("POST", `/agents/${id}/pause`),
    resume: (id: string) => call<Agent>("POST", `/agents/${id}/resume`),
    wake: (id: string) => call<WakeResult>("POST", `/agents/${id}/wakeup`, { source: "on_demand", reason: "Board via Discord" }),
    liveRuns: () => call<LiveRun[]>("GET", `${c}/live-runs`),
    runs: () => call<{ agentId: string; createdAt: string }[]>("GET", `${c}/heartbeat-runs?limit=500`),

    issues: (params: { status?: string; assigneeAgentId?: string; updatedSince?: string; q?: string; limit?: number }) =>
      call<Issue[]>("GET", `${c}/issues${q({ ...params, limit: params.limit ?? 100 })}`),
    issue: (idOrIdentifier: string) => call<Issue>("GET", `/issues/${encodeURIComponent(idOrIdentifier)}`),
    createIssue: (body: { title: string; description?: string; priority?: string; assigneeAgentId: string }) =>
      call<Issue>("POST", `${c}/issues`, body),
    comments: (issueId: string, after?: string) =>
      call<Comment[]>("GET", `/issues/${issueId}/comments${q({ after, order: "asc", limit: 500 })}`),
    lastComments: (issueId: string, limit: number) =>
      call<Comment[]>("GET", `/issues/${issueId}/comments${q({ order: "desc", limit })}`),
    comment: (issueId: string, body: string) => call<Comment>("POST", `/issues/${issueId}/comments`, { body }),

    dashboard: () => call<Dashboard>("GET", `${c}/dashboard`),
    quotaWindows: () => call<QuotaProvider[]>("GET", `${c}/costs/quota-windows`),
    pacing: () => call<Pacing>("GET", `${c}/costs/subscription-pacing`),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface BoardKey { id: string; name: string; expiresAt: string | null; revokedAt: string | null }

export interface AttentionItem {
  id: string;
  sourceKind: string;
  severity: string;
  whyNow?: string | null;
  decideBy?: string | null;
  subject: { kind: string; id: string; title?: string | null; identifier?: string | null; status?: string | null; metadata?: Record<string, unknown> | null };
  relatedIssue?: { id: string; identifier?: string | null; title?: string | null } | null;
  detail?: Record<string, unknown> | null;
}
export interface AttentionPage { items: AttentionItem[]; nextCursor: string | null; totalCount: number }

export interface Approval { id: string; type: string; status: string; payload: Record<string, unknown> | null; requestedByAgentId?: string | null }
export interface Decision {
  id: string; title: string; body: string; status: string;
  options: { id: string; label: string; description?: string | null }[];
  inputs?: { id: string; label: string; placeholder?: string | null; required?: boolean; maxLength?: number }[] | null;
}
export interface Interaction {
  id: string; kind: string; status: string;
  payload: Record<string, unknown>;
}
export interface Agent {
  id: string; name: string; role?: string; title?: string | null; status: string;
  pauseReason?: string | null; errorReason?: string | null; reportsTo?: string | null;
  runtimeConfig?: Record<string, unknown> | null; avatarUrl?: string | null;
}
export interface LiveRun { id: string; agentId: string; status: string; issueId?: string | null }
export interface WakeResult { status?: string; reason?: string | null; message?: string | null; id?: string }
export interface Issue {
  id: string; identifier: string; title: string; description?: string | null; status: string; priority?: string;
  assigneeAgentId?: string | null; updatedAt: string;
}
export interface Comment {
  id: string; body: string; createdAt: string;
  authorAgentId?: string | null; authorUserId?: string | null; derivedAuthorAgentId?: string | null;
}
export interface Dashboard {
  tasks: { open: number; inProgress: number; blocked: number; done: number };
  pendingApprovals: number;
}
export interface QuotaProvider {
  provider: string; ok: boolean; error?: string;
  windows: { label: string; usedPercent: number | null; resetsAt: string | null; valueLabel?: string | null }[];
}
export interface Pacing {
  policy: { plans: Record<string, { autoPause: boolean; sessionPauseAtPercent: number; weeklyPauseAtPercent: number }> };
  agents: { agentId: string; agentName: string; provider: string | null; status: string; pauseReason: string | null }[];
}
