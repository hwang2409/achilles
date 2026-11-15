import { fromZetaEvent, fromZetaHistory, type SessionLease, type ZetaClient } from "@fulcrum/zeta";
import type { RunEvent } from "@fulcrum/core";

type Status = { session?: { session_id: string } | null; state: "idle" | "running" | "tool"; pending_approvals?: Array<{ request_id: string; tool_call: unknown; delegated: boolean; resolution_pending?: string }>; last_turn_outcome?: { turn_id?: unknown; reason?: unknown } | null };
type HistoryPage = { messages?: unknown[]; next_offset?: number | null };
type LoadedPage = { offset: number; rows: unknown[]; nextOffset: number | null };

export const pageBinding = (credential: string, cwd: string) => ({ cwd, mcp_bindings: [{ server: "achilles", headers: { Authorization: `Bearer ${credential}` } }] });

export async function rebindPage(client: ZetaClient, sessionId: string, binding: ReturnType<typeof pageBinding>) {
  return client.request("resume", { session_id: sessionId, ...binding });
}

/** The session whose turn is still running, or null when zeta is idle. */
export async function runningSession(client: ZetaClient): Promise<string | null> {
  const status = await client.request("status", {}) as Status;
  return status.state === "idle" ? null : status.session?.session_id ?? null;
}

/** zeta refuses `resume` and `new_session` (-32004) while a turn runs; sessionId names the running chat. */
export class ChatBusyError extends Error {
  constructor(readonly sessionId: string | null) { super("another chat is still running"); }
}

type SessionSettings = { model: string; approval_mode?: string | null };
type ApprovalModeResult = { approvalMode?: string | null; pending: boolean };

export async function applyApprovalMode(client: ZetaClient, sessionId: string, mode: string): Promise<ApprovalModeResult> {
  let settings = await client.request("session_settings", { session_id: sessionId }) as SessionSettings;
  if (settings.approval_mode === mode) return { approvalMode: settings.approval_mode, pending: false };
  const status = await client.request("status", { session_id: sessionId }) as Status;
  if (status.state !== "idle") return { approvalMode: settings.approval_mode, pending: true };
  try {
    settings = await client.request("set_settings", { session_id: sessionId, model: settings.model, approval_mode: mode }) as SessionSettings;
    return { approvalMode: settings.approval_mode, pending: false };
  } catch (caught) {
    if ((caught as { code?: unknown }).code !== -32004) throw caught;
    settings = await client.request("session_settings", { session_id: sessionId }) as SessionSettings;
    return { approvalMode: settings.approval_mode, pending: true };
  }
}

export function creationApprovalMode(serverMode: string | null | undefined, autoApproveDefault = true): "ask" | "allow" {
  return serverMode === "ask" || !autoApproveDefault ? "ask" : "allow";
}

export class SessionNotFoundError extends Error {}

export async function openHomeSession(client: ZetaClient, id: string, credential: string, cwd: string, serverMode?: string | null) {
  let name: string | null = null;
  // A live turn on this chat (for example one waiting for approval after a reload) blocks `resume`, so attach without
  // it: the transcript and pending approval come from status and history. `rebind` re-sends the page binding later.
  let rebind = await runningSession(client) === id;
  if (!rebind) {
    try {
      const resumed = await rebindPage(client, id, pageBinding(credential, cwd)) as { session?: { name?: string | null } };
      name = resumed.session?.name ?? null;
    } catch (caught) {
      if ((caught as { data?: { code?: string } }).data?.code === "session_not_found") throw new SessionNotFoundError("this chat no longer exists");
      if ((caught as { code?: unknown }).code !== -32004) throw caught;
      const running = await runningSession(client);
      if (running !== id) throw new ChatBusyError(running);
      rebind = true;
    }
  }
  if (serverMode === "ask") return { id, name, rebind, ...await applyApprovalMode(client, id, "ask") };
  const settings = await client.request("session_settings", { session_id: id }) as SessionSettings;
  return { id, name, rebind, approvalMode: settings.approval_mode, pending: false };
}

const statusEvents = (id: string, status: Status): RunEvent[] => (status.pending_approvals ?? []).flatMap((item) => fromZetaEvent({ event: "approval_request", session_id: id, ...item, ...(item.resolution_pending ? { state: "resolving", status: "resolving…" } : {}) }));
const terminal = (status: Status): RunEvent[] => status.state === "idle" ? [{ type: "run_end" }] : [{ type: "run_start" }];

export async function loadSession(client: ZetaClient, id: string): Promise<SessionLease> {
  let pages: LoadedPage[] = []; let lease!: SessionLease;
  const page = async (offset: number): Promise<LoadedPage> => { const value = await client.request("session_history", { session_id: id, offset }) as HistoryPage; return { offset, rows: value.messages ?? [], nextOffset: value.next_offset ?? null }; };
  const allRows = () => pages.flatMap((item) => item.rows);
  const snapshot = (rows: unknown[], status: Status) => [...fromZetaHistory(rows), ...statusEvents(id, status), ...terminal(status)];
  const loadAll = async () => { pages = []; for (let offset: number | null = 0; offset !== null;) { const next = await page(offset); pages.push(next); offset = next.nextOffset; } };
  const initial = await client.request("status", {}) as Status;
  try {
    lease = await client.replay(id, async () => { await loadAll(); const status = initial.session?.session_id === id ? initial : await client.request("status", {}) as Status; return snapshot(allRows(), status); }, true);
    const revision = client.replayRevision(id); const tail = pages.at(-1);
    if (tail) { const refreshed: LoadedPage[] = []; for (let offset: number | null = tail.offset; offset !== null;) { const next = await page(offset); refreshed.push(next); offset = next.nextOffset; } pages.splice(pages.length - 1, 1, ...refreshed); }
    let status = await client.request("status", {}) as Status;
    while (!client.finishReplay(id, revision)) { const nextRevision = client.replayRevision(id); const tailPage = pages.at(-1); if (tailPage) { const refreshed: LoadedPage[] = []; for (let offset: number | null = tailPage.offset; offset !== null;) { const next = await page(offset); refreshed.push(next); offset = next.nextOffset; } pages.splice(pages.length - 1, 1, ...refreshed); } status = await client.request("status", {}) as Status; if (client.finishReplay(id, nextRevision)) break; }
    lease.store.resync(snapshot(allRows(), status)); return lease;
  } catch (caught) {
    lease?.release();
    throw caught;
  }
}
