import type { ZetaClient } from "@fulcrum/zeta";

/**
 * The one owner of a chat row's state in the sidebar: what the row shows, and the `last_state` achilles stores for every
 * tab. Fed by this tab's shown chat (its header state), this tab's parked chats (`parked_session_changed`: a change, or
 * closed), and the check of a stale row this tab does not hold (zeta's `state_session`).
 */
export type RowState = "idle" | "running" | "approval" | "failed";
export type Live =
  // this tab's shown chat: the header state
  | { from: "attached"; state: RowState }
  // one of this tab's parked chats
  | { from: "parked"; row: { state: string; pending_approvals: number } }
  // this tab's parked chat closed in zeta (it finished, or zeta stopped it)
  | { from: "closed" }
  // zeta's status of a chat this tab does not hold; null: zeta has no such session
  | { from: "zeta"; status: unknown };

// a chat that does no work: idle, unless its last turn failed
const settled = (stored: RowState | null) => stored === "failed" ? "failed" : "idle";
function liveState(stored: RowState | null, live: Live): RowState | null {
  switch (live.from) {
    case "attached": return live.state;
    case "parked": return live.row.pending_approvals > 0 ? "approval" : live.row.state === "idle" ? settled(stored) : "running";
    case "closed": return settled(stored);
    case "zeta":
      if (live.status === null || live.status === "idle") return settled(stored);
      return live.status === "running" || live.status === "tool" ? "running" : live.status === "approval" || live.status === "failed" ? live.status : null;
  }
}

/**
 * `stored`: the row's stored last_state (undefined: not known, so any live state is written). Returns the state the row
 * shows and the state to store (null: no write; an unknown live status changes nothing).
 */
export function rowState(stored: RowState | null | undefined, live?: Live): { shown: RowState | null; write: RowState | null } {
  const next = live ? liveState(stored ?? null, live) : null;
  return { shown: next ?? stored ?? null, write: next !== null && next !== stored ? next : null };
}

const written = new Set<() => void>();
/** Called after each stored write, so the chat list loads again. */
export function subscribeRowWrites(listener: () => void) {
  written.add(listener);
  return () => { written.delete(listener); };
}

/**
 * Stores a row's state. `expected` (the row as read) makes it a compare-and-set: a tab that does not hold the chat never
 * overwrites a newer state of the tab that does (achilles answers 409, and nothing changes).
 */
export async function writeRowState(sessionId: string, state: RowState | null, expected?: { last_state: RowState | null; updated_at: string }, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (state === null) return false;
  const body = { last_state: state, ...(expected ? { expected_last_state: expected.last_state, expected_updated_at: expected.updated_at } : {}) };
  try {
    const response = await fetchFn(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) return false;
  } catch { return false; }
  for (const listener of [...written]) listener();
  return true;
}

/** This tab's shown chat changed state (its header): only this tab holds it, so the state is stored as is. */
export const writeShownState = (sessionId: string, state: RowState) => writeRowState(sessionId, rowState(undefined, { from: "attached", state }).write);

type ZetaRead = { session?: { status?: unknown } | null; items?: Array<{ status?: unknown }> } | null;
const notFound = (caught: unknown) => {
  const error = caught as { code?: unknown; data?: { code?: unknown } | null } | null;
  return error?.code === -32602 && error.data?.code === "session_not_found";
};
// zeta's status of a chat (null: no such session; undefined: the read failed) and the items of one collection
async function readChat(client: ZetaClient, sessionId: string, collection: string, limit = 200): Promise<{ status: unknown; items: Array<{ status?: unknown }> }> {
  try {
    const read = await client.request("state_session", { session_id: sessionId, collection, limit }) as ZetaRead;
    return { status: read?.session?.status, items: Array.isArray(read?.items) ? read.items : [] };
  } catch (caught) { return { status: notFound(caught) ? null : undefined, items: [] }; }
}

type ListedChat = { session_id: string; last_state?: RowState | null; updated_at?: string };
/**
 * A tab that closed (or a zeta restart) leaves "running" or "needs you" behind. Once per chat list load, this checks
 * each such row this tab does not hold with zeta (a read that attaches nothing) and stores zeta's state as a
 * compare-and-set. Returns how many rows changed.
 */
export async function verifyChatStates(client: ZetaClient, chats: readonly ListedChat[], held: ReadonlySet<string>, fetchFn: typeof fetch = fetch): Promise<number> {
  const stale = chats.filter((chat) => (chat.last_state === "running" || chat.last_state === "approval") && !held.has(chat.session_id));
  const changed = await Promise.all(stale.map(async (chat) => {
    const { status } = await readChat(client, chat.session_id, "attention", 1);
    if (status === undefined) return false;
    const stored = chat.last_state ?? null;
    return writeRowState(chat.session_id, rowState(stored, { from: "zeta", status }).write, chat.updated_at ? { last_state: stored, updated_at: chat.updated_at } : undefined, fetchFn);
  }));
  return changed.filter(Boolean).length;
}

/**
 * A chat this tab just stopped: does zeta still show it holding work (its turn or an approval, a running or finishing
 * child, a running background task)? Stores the state zeta shows for its row (this tab holds it). null: unknown.
 */
export async function stoppedChatWork(client: ZetaClient, sessionId: string, stored: RowState | null | undefined): Promise<boolean | null> {
  const [agents, tasks] = await Promise.all([readChat(client, sessionId, "agents"), readChat(client, sessionId, "background_tasks")]);
  if (agents.status === undefined) return null;
  const work = agents.status === "running" || agents.status === "approval" || agents.status === "tool"
    || agents.items.some((item) => item.status === "running" || item.status === "waiting")
    || tasks.items.some((item) => item.status === "running");
  // a chat that still holds work reads "running" (as a parked one does), even when its own turn ended
  const status = work && agents.status !== "approval" ? "running" : agents.status;
  void writeRowState(sessionId, rowState(stored, { from: "zeta", status }).write);
  return work;
}
