import { fromZetaEvent, fromZetaHistory, type SessionLease, type ZetaClient } from "@fulcrum/zeta";
import type { RunEvent } from "@fulcrum/core";

type Status = {
  session?: { session_id: string } | null;
  state: "idle" | "running" | "tool";
  pending_approvals?: Array<{ request_id: string; tool_call: unknown; delegated: boolean; resolution_pending?: string }>;
  last_turn_outcome?: { turn_id?: unknown; reason?: unknown } | null;
};
type HistoryPage = { messages?: unknown[]; next_offset?: number | null };
type LoadedPage = { offset: number; rows: unknown[]; nextOffset: number | null };

export async function openHomeSession(client: ZetaClient, storedId: string | null) {
  let id = storedId;
  if (id) {
    try { await client.request("resume", { session_id: id }); }
    catch (error) {
      if ((error as { data?: { code?: unknown } }).data?.code !== "session_not_found") throw error;
      id = null;
    }
  }
  if (!id) {
    const created = await client.request("new_session", {}) as { session?: { session_id?: string } };
    id = created.session?.session_id ?? null;
    if (!id) throw new Error("zeta did not return a session id");
  }
  return id;
}

const approval = (event: RunEvent) => event.type === "approval_request" || event.type === "approval_end";
const statusEvents = (id: string, status: Status): RunEvent[] => (status.pending_approvals ?? []).flatMap((item) => fromZetaEvent({
  event: "approval_request", session_id: id, ...item,
  ...(item.resolution_pending ? { state: "resolving", status: "resolving…" } : {}),
}));
const terminal = (status: Status): RunEvent[] => status.state === "idle" ? [{ type: "run_end" }] : [{ type: "run_start" }];

export async function loadSession(client: ZetaClient, id: string): Promise<SessionLease> {
  let pages: LoadedPage[] = [];
  let lease!: SessionLease;
  let signal!: AbortSignal;
  const page = async (offset: number): Promise<LoadedPage> => {
    const value = await client.request("session_history", { session_id: id, offset }) as HistoryPage;
    return { offset, rows: value.messages ?? [], nextOffset: value.next_offset ?? null };
  };
  const allRows = () => pages.flatMap((item) => item.rows);
  const snapshot = (rows: unknown[], status: Status) => [
    ...fromZetaHistory(rows), ...statusEvents(id, status), ...terminal(status),
  ];
  const loadAll = async () => {
    pages = [];
    for (let offset: number | null = 0; offset !== null;) {
      const next = await page(offset);
      pages.push(next);
      offset = next.nextOffset;
    }
  };
  const initial = await client.request("status", {}) as Status;
  lease = await client.replay(id, async (replaySignal) => {
    signal = replaySignal;
    await loadAll();
    const status = initial.session?.session_id === id ? initial : await client.request("status", {}) as Status;
    return snapshot(allRows(), status);
  }, true);
  const revision = client.replayRevision(id);
  const tail = pages.at(-1);
  if (tail) {
    const refreshed: LoadedPage[] = [];
    for (let offset: number | null = tail.offset; offset !== null;) {
      const next = await page(offset);
      refreshed.push(next);
      offset = next.nextOffset;
    }
    pages.splice(pages.length - 1, 1, ...refreshed);
  }
  const status = await client.request("status", {}) as Status;
  if (client.finishReplay(id, revision)) lease.store.resync(snapshot(allRows(), status));
  void signal;
  return lease;
}
