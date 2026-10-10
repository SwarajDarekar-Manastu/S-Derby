import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface State {
  statusMessageId?: string;
  statusPinned?: boolean;
  aliveMessageId?: string;
  /** attention item id -> the Discord message that shows it */
  inbox: Record<string, { messageId: string; resolved?: boolean; resolvedAt?: number }>;
  /** issue id -> the Discord thread relaying it */
  threads: Record<string, { threadId: string; channel: string; lastCommentId?: string; status: string; assigneeAgentId: string | null }>;
  /** comment ids the bot itself created, never relayed back */
  ownComments: string[];
  /** warning keys already sent */
  warned: string[];
  /** relay poll position, kept across restarts */
  relayCursor?: string;
  /** webhook per agent channel */
  webhooks: Record<string, { id: string; token: string }>;
}

const empty = (): State => ({ inbox: {}, threads: {}, ownComments: [], warned: [], webhooks: {} });

export function loadState(file: string): State {
  try {
    return { ...empty(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<State>) };
  } catch {
    return empty();
  }
}

/** Atomic write: a crash mid-write never leaves a half file. */
export function saveState(file: string, state: State): void {
  state.ownComments = state.ownComments.slice(-500);
  state.warned = state.warned.slice(-500);
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
