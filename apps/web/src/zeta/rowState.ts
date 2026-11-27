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

// the state this tab last wrote for each chat it holds: forgotten when another tab writes the chat, a list load shows
// another, a write fails, or the chat leaves this tab
const lastWritten = new Map<string, RowState>();
/** Each test case is a fresh tab. */
export const forgetRowWrites = () => lastWritten.clear();
/** The chats this tab holds now: a chat released, taken by another tab or device, or closed is forgotten. */
export const keepRowWrites = (held: ReadonlySet<string>) => { for (const id of lastWritten.keys()) if (!held.has(id)) lastWritten.delete(id); };
const written = new Set<(remote: boolean) => void>();
const notify = (remote: boolean) => { for (const listener of [...written]) listener(remote); };
// the other tabs of this browser hear each chat write here (a post never reaches its own sender); other browsers and
// devices load the list again when they come back (focus, visibility). open only while a list listens: an open channel
// keeps a non-browser process (a bun script importing this module) alive
let channel: BroadcastChannel | null = null;
/**
 * Called after each chat write, so the chat list loads again. `remote`: another tab of this browser wrote; that tab
 * holds the chat and just stored its state, so a reload it caused must not check the rows with zeta (verifyChatStates).
 */
export function subscribeRowWrites(listener: (remote: boolean) => void) {
  written.add(listener);
  if (!channel && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("achilles:chats");
    channel.addEventListener("message", (event: MessageEvent) => { if (typeof event.data === "string") lastWritten.delete(event.data); notify(true); });
  }
  return () => {
    written.delete(listener);
    if (written.size === 0) { channel?.close(); channel = null; }
  };
}

/** Every chat PATCH: an answered write loads the list again here and in the other tabs of this browser. */
export async function patchChat(sessionId: string, body: object, fetchFn: typeof fetch = fetch): Promise<Response> {
  const response = await fetchFn(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.ok) { notify(false); channel?.postMessage(sessionId); }
  return response;
}

/**
 * Stores a row's state. `expected` (the row as read) makes it a compare-and-set: a tab that does not hold the chat never
 * overwrites a newer state of the tab that does (achilles answers the row as it is, and nothing changes; the list
 * loads again either way).
 */
export async function writeRowState(sessionId: string, state: RowState | null, { expected }: { expected?: { last_state: RowState | null; state_version: number } } = {}, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (state === null) return false;
  // a holder's write of the state it last wrote, with no write by anyone else seen since, changes nothing: skip it
  // (each write reloads the list in every tab)
  if (!expected && lastWritten.get(sessionId) === state) return false;
  if (expected) lastWritten.delete(sessionId); else lastWritten.set(sessionId, state);
  const body = { last_state: state, ...(expected ? { expected_last_state: expected.last_state, expected_state_version: expected.state_version } : {}) };
  let ok = false;
  try { ok = (await patchChat(sessionId, body, fetchFn)).ok; } catch { /* not stored */ }
  if (!ok && lastWritten.get(sessionId) === state) lastWritten.delete(sessionId);
  return ok;
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

type ListedChat = { session_id: string; last_state?: RowState | null; state_version: number };
/**
 * A tab that closed (or a zeta restart) leaves "running" or "needs you" behind. Once per chat list load, this checks
 * each such row this tab does not hold with zeta (a read that attaches nothing) and stores zeta's state as a
 * compare-and-set. Returns how many rows changed.
 */
export async function verifyChatStates(client: ZetaClient, chats: readonly ListedChat[], held: ReadonlySet<string>, fetchFn: typeof fetch = fetch): Promise<number> {
  for (const chat of chats) if (lastWritten.has(chat.session_id) && lastWritten.get(chat.session_id) !== chat.last_state) lastWritten.delete(chat.session_id);
  const stale = chats.filter((chat) => (chat.last_state === "running" || chat.last_state === "approval") && !held.has(chat.session_id));
  const changed = await Promise.all(stale.map(async (chat) => {
    const status = await readStatus(client, chat.session_id);
    if (status === undefined) return false;
    const stored = chat.last_state ?? null;
    return writeRowState(chat.session_id, rowState(stored, { from: "zeta", status }).write, { expected: { last_state: stored, state_version: chat.state_version } }, fetchFn);
  }));
  return changed.filter(Boolean).length;
}
