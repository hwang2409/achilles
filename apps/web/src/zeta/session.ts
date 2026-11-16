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

type Joined = { messages?: unknown[]; next_before: number | null; history_validator: { repair_generation?: string | null }; status: Status };

// each older-rows read and each stale join (-32009) is one restart; a chat that keeps changing this often fails clearly
const RESTART_LIMIT = 5;
// an idle chat's busy background child can send an event during every status read; after this many, skip the outcome
const STATUS_READ_LIMIT = 3;
const aborted = () => Object.assign(new Error("request aborted"), { name: "AbortError" });

/**
 * Opens `id` on a fresh store from one `session_history_and_subscribe` join (`session_replay_seq`). zeta streams every
 * event after the join, including a reply published before its history row was written and, with `in_flight_replay`,
 * the reply text and tool output streamed before the join. fulcrum drops events while the store loads, so the snapshot
 * is installed in the same task as the join reply: rows older than the join's page are read first by an earlier join
 * (they never change while the cursor and repair generation stay), and the join that finds them already read is used.
 * `current` is false once the page no longer wants this chat (a chat switch or unmount): the load then stops.
 */
export async function loadSession(client: ZetaClient, id: string, current: () => boolean = () => true): Promise<SessionLease> {
  if (!supportsFeature(client, "session_replay_seq")) throw new Error("this zeta is too old to open chats. update zeta, then restart zeta serve.");
  const load = async (signal?: AbortSignal): Promise<RunEvent[]> => {
    let older: { cursor: number; repair: string | null; rows: unknown[] } | null = null;
    const request = async (method: string, params: Record<string, unknown>) => {
      if (signal?.aborted || !current()) throw aborted();
      return client.request(method, params, { signal });
    };
    const readOlder = async (cursor: number, validator: unknown) => {
      const pages: unknown[][] = [];
      for (let before: number | null = cursor; before !== null;) {
        const page = await request("session_history", { session_id: id, before, history_validator: validator }) as Joined;
        pages.unshift(page.messages ?? []);
        before = page.next_before;
      }
      return pages.flat();
    };
    // the join's status has no last turn outcome; null when an event arrived during the read (it was dropped)
    const idleOutcome = async (revision: number) => {
      const status = await request("status", {}) as Status;
      return client.replayRevision(id) === revision ? status : null;
    };
    let restarts = 0;
    let statusReads = 0;
    const restart = () => { if (++restarts > RESTART_LIMIT) throw new Error("this chat kept changing while it loaded. reload the page to try again."); };
    // one join; null when it must join again because events of this join were dropped
    const attempt = async (): Promise<RunEvent[] | null> => {
      const joined = await request("session_history_and_subscribe", { session_id: id }) as Joined;
      const revision = client.replayRevision(id);
      const cursor = joined.next_before;
      const repair = cursor === null ? null : joined.history_validator.repair_generation ?? null;
      if (cursor !== null && (older?.cursor !== cursor || older.repair !== repair)) {
        restart();
        older = { cursor, repair, rows: await readOlder(cursor, joined.history_validator) };
        return null;
      }
      let status = joined.status;
      if (status.state === "idle" && statusReads < STATUS_READ_LIMIT) {
        statusReads += 1;
        const read = await idleOutcome(revision);
        if (!read) return null;
        status = { ...status, session: read.session, last_turn_outcome: read.last_turn_outcome };
      }
      const rows = [...(cursor === null ? [] : older!.rows), ...(joined.messages ?? [])];
      return [...fromZetaHistory(rows), ...statusEvents(id, status), ...terminal(id, status)];
    };
    for (;;) {
      try {
        const events = await attempt();
        if (events) return events;
      } catch (caught) {
        if ((caught as { code?: unknown }).code !== -32009) throw caught; // stale join or history cursor: start again
        older = null;
        restart();
      }
    }
  };
  return client.replay(id, load);
}
