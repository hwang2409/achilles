import { fromZetaEvent, fromZetaHistory, statusTurnOutcome, type SessionLease, type ZetaClient } from "@fulcrum/zeta";
import type { RunEvent } from "@fulcrum/core";
import { supportsFeature } from "./connection";

type Status = { session?: { session_id: string } | null; state: "idle" | "running" | "tool"; pending_approvals?: Array<{ request_id: string; tool_call: unknown; delegated: boolean; resolution_pending?: string }>; last_turn_outcome?: { turn_id?: unknown; reason?: unknown } | null };

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
  constructor(readonly sessionId: string | null) { super(sessionId ? "another chat is still running" : "zeta was busy a moment ago and is ready now"); }
}

/**
 * Calls `ended` once when zeta stops running `sessionId`'s turn: on that session's `agent_end`, never by polling.
 * A store that joined mid-turn missed `agent_start`, so it is marked running first; one status check after the mark
 * covers an end that arrived before it. Returns a cancel function.
 */
export function watchTurnEnd(client: ZetaClient, sessionId: string, ended: () => void): () => void {
  const lease = client.forSession(sessionId);
  const { store } = lease;
  let done = false;
  let unsubscribe = () => {};
  const stop = () => { if (done) return false; done = true; unsubscribe(); lease.release(); return true; };
  const finish = () => { if (stop()) ended(); };
  const { agent, endOutcome } = store.getState();
  const marked = agent !== "running";
  try { if (marked) store.dispatch({ type: "run_start" }); }
  catch { stop(); return () => {}; } // a store under replay refuses events: the notice keeps its "try again"
  unsubscribe = store.subscribe(() => { if (store.getState().agent !== "running") finish(); });
  void runningSession(client).then((running) => {
    if (done || running === sessionId) return;
    try { if (marked) store.dispatch({ type: "run_end", ...(endOutcome ? { outcome: endOutcome } : {}) }); } catch { /* evicted store: nothing to undo */ }
    finish();
  }, () => {});
  return () => { stop(); };
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
  // With `resume_attach`, `resume` of this chat during its live turn (for example an approval wait after a reload)
  // attaches and re-binds the page tools at once. Without it zeta refuses that `resume`, so attach without it: the
  // transcript and pending approval come from status and history, and `rebind` re-sends the page binding when idle.
  // With `turn_reconnect`, a running turn kept after a reload reattaches through this same `resume`.
  let rebind = !supportsFeature(client, "resume_attach") && await runningSession(client) === id;
  for (let retried = false; !rebind; retried = true) {
    try {
      const resumed = await rebindPage(client, id, pageBinding(credential, cwd)) as { session?: { name?: string | null } };
      name = resumed.session?.name ?? null;
      break;
    } catch (caught) {
      if ((caught as { data?: { code?: string } }).data?.code === "session_not_found") throw new SessionNotFoundError("this chat no longer exists");
      if ((caught as { code?: unknown }).code !== -32004) throw caught;
      const running = await runningSession(client);
      rebind = running === id;
      // null: the other turn ended between `resume` and `status`, so zeta is idle now and one more `resume` works
      if (!rebind && (running !== null || retried)) throw new ChatBusyError(running);
    }
  }
  if (serverMode === "ask") return { id, name, rebind, ...await applyApprovalMode(client, id, "ask") };
  const settings = await client.request("session_settings", { session_id: id }) as SessionSettings;
  return { id, name, rebind, approvalMode: settings.approval_mode, pending: false };
}

const statusEvents = (id: string, status: Status): RunEvent[] => (status.pending_approvals ?? []).flatMap((item) => fromZetaEvent({ event: "approval_request", session_id: id, ...item, ...(item.resolution_pending ? { state: "resolving", status: "resolving…" } : {}) }));
// A kept running turn (a reload during it) needs `turn_start` too: the composer stop control and header read `turn`.
// An idle chat whose last turn zeta stopped (user stop, or no client back within the grace) says so in its outcome.
const terminal = (id: string, status: Status): RunEvent[] => {
  if (status.state !== "idle") return [{ type: "run_start" }, { type: "turn_start" }];
  const outcome = status.session?.session_id === id ? statusTurnOutcome(status.last_turn_outcome) : undefined;
  return [{ type: "run_end", ...(outcome === "cancelled" || outcome === "disconnected" ? { outcome } : {}) }];
};

type Joined = { messages?: unknown[]; next_before: number | null; history_validator: unknown; status: Status };

/**
 * Opens `id` on a fresh store from one `session_history_and_subscribe` join (`session_replay_seq`). zeta streams every
 * event after the join, including a reply published before its history row was written, so nothing between the
 * snapshot and live events is lost. The snapshot is installed in the same task as the join reply when nothing else is
 * read; reads after the join (older pages, the idle outcome) are kept only when no event arrived during them.
 */
export async function loadSession(client: ZetaClient, id: string): Promise<SessionLease> {
  const load = async (): Promise<RunEvent[]> => {
    for (;;) {
      try {
        const joined = await client.request("session_history_and_subscribe", { session_id: id }) as Joined;
        const revision = client.replayRevision(id);
        const pages = [joined.messages ?? []];
        for (let before = joined.next_before; before !== null;) {
          const older = await client.request("session_history", { session_id: id, before, history_validator: joined.history_validator }) as Joined;
          pages.unshift(older.messages ?? []);
          before = older.next_before;
        }
        // the join's status has no last turn outcome; an idle chat reads it, a running one has none to show
        let status = joined.status;
        if (status.state === "idle") { const current = await client.request("status", {}) as Status; status = { ...status, session: current.session, last_turn_outcome: current.last_turn_outcome }; }
        if (client.replayRevision(id) === revision) return [...fromZetaHistory(pages.flat()), ...statusEvents(id, status), ...terminal(id, status)];
      } catch (caught) {
        if ((caught as { code?: unknown }).code !== -32009) throw caught; // stale join or history cursor: join again
      }
    }
  };
  return client.replay(id, load);
}
