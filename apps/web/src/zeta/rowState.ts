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

function liveState(live: Live): RowState | null {
  switch (live.from) {
    case "attached": return live.state;
    // parked means zeta keeps it for its work (an idle chat with only a background agent too): it always reads running
    case "parked": return live.row.pending_approvals > 0 ? "approval" : "running";
    case "closed": return "idle";
    case "zeta":
      if (live.status === null || live.status === "idle") return "idle";
      return live.status === "running" || live.status === "tool" ? "running" : live.status === "approval" || live.status === "failed" ? live.status : null;
  }
}

/**
 * `stored`: the row's stored last_state (undefined: not known, so any live state is written). Returns the state the row
 * shows and the state to store (null: no write; an unknown live status changes nothing).
 */
export function rowState(stored: RowState | null | undefined, live?: Live): { shown: RowState | null; write: RowState | null } {
  const next = live ? liveState(live) : null;
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
 * overwrites a newer state of the tab that does (achilles answers the row as it is, and nothing changes; the list
 * loads again either way). `keepOrder`: a state re-report, not a new turn, so the row keeps its place in the list.
 */
export async function writeRowState(sessionId: string, state: RowState | null, { expected, keepOrder }: { expected?: { last_state: RowState | null; updated_at: string }; keepOrder?: true } = {}, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (state === null) return false;
  const body = { last_state: state, ...(expected ? { expected_last_state: expected.last_state, expected_updated_at: expected.updated_at } : {}), ...(keepOrder ? { keep_order: true } : {}) };
  try {
    const response = await fetchFn(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) return false;
  } catch { return false; }
  for (const listener of [...written]) listener();
  return true;
}

/** This tab's shown chat changed state (its header): only this tab holds it, so the state is stored as is. */
export const writeShownState = (sessionId: string, state: RowState) => writeRowState(sessionId, rowState(undefined, { from: "attached", state }).write);

type ZetaRead = { session?: { status?: unknown } | null } | null;
const notFound = (caught: unknown) => {
  const error = caught as { code?: unknown; data?: { code?: unknown } | null } | null;
  return error?.code === -32602 && error.data?.code === "session_not_found";
};
// zeta's status of a chat (null: no such session; undefined: the read failed)
async function readStatus(client: ZetaClient, sessionId: string): Promise<unknown> {
  try {
    const read = await client.request("state_session", { session_id: sessionId, collection: "attention", limit: 1 }) as ZetaRead;
    return read?.session?.status;
  } catch (caught) { return notFound(caught) ? null : undefined; }
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
    const status = await readStatus(client, chat.session_id);
    if (status === undefined) return false;
    const stored = chat.last_state ?? null;
    return writeRowState(chat.session_id, rowState(stored, { from: "zeta", status }).write, { expected: chat.updated_at ? { last_state: stored, updated_at: chat.updated_at } : undefined }, fetchFn);
  }));
  return changed.filter(Boolean).length;
}
