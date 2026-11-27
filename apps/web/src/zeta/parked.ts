import type { ZetaClient } from "@fulcrum/zeta";
import { rowState, writeRowState } from "./rowState";
import { CONTROLLED_RETRIES, CONTROLLED_RETRY_MS, controlledRetry, isResidentLimit, rebindPage, type pageBinding } from "./session";

/**
 * The chats this tab keeps running in zeta while it shows another one (`session_park`): one owner per connection, fed by
 * `status.parked_sessions` and the `parked_session_changed` events the transport tee hands over (fulcrum never sees them).
 */
export type ParkedRow = { session_id: string; state: "running" | "tool" | "idle"; pending_approvals: number };
type Binding = ReturnType<typeof pageBinding>;
type Owner = { rows: readonly ParkedRow[]; listeners: Set<() => void> };

const NONE: readonly ParkedRow[] = [];
const owners = new WeakMap<object, Owner>();
const ownerOf = (client: object) => {
  let owner = owners.get(client);
  if (!owner) owners.set(client, owner = { rows: NONE, listeners: new Set() });
  return owner;
};

// the ids this tab holds in zeta, so a reload can take them back from zeta's grace; ids only, never a credential
const HELD_KEY = "achilles:held";
export type Held = { attached: string | null; parked: string[] };
const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
export function readHeld(): Held {
  try {
    const value = JSON.parse(sessionStorage.getItem(HELD_KEY) ?? "null") as { attached?: unknown; parked?: unknown } | null;
    return { attached: typeof value?.attached === "string" ? value.attached : null, parked: ids(value?.parked) };
  } catch { return { attached: null, parked: [] }; }
}
function writeHeld(change: Partial<Held>) {
  try { sessionStorage.setItem(HELD_KEY, JSON.stringify({ ...readHeld(), ...change })); } catch { /* storage off: a reload cannot reclaim */ }
}
/** Records the chat this tab shows (zeta's attached session). */
export const holdAttached = (sessionId: string) => writeHeld({ attached: sessionId });

const STATES = new Set(["running", "tool", "idle"]);
const parseRow = (value: unknown): ParkedRow | null => {
  const row = value as { session_id?: unknown; state?: unknown; pending_approvals?: unknown } | null;
  if (typeof row?.session_id !== "string" || typeof row.state !== "string" || !STATES.has(row.state)) return null;
  const pending = typeof row.pending_approvals === "number" && row.pending_approvals > 0 ? row.pending_approvals : 0;
  return { session_id: row.session_id, state: row.state as ParkedRow["state"], pending_approvals: pending };
};

function publish(client: object, rows: readonly ParkedRow[]) {
  const owner = ownerOf(client);
  owner.rows = rows;
  writeHeld({ parked: rows.map((row) => row.session_id) });
  for (const listener of [...owner.listeners]) listener();
}

/** The tab's parked chats, oldest first; the same array until they change. */
export const parkedRows = (client: object | null) => client ? ownerOf(client).rows : NONE;
export function subscribeParked(client: object, listener: () => void) {
  const { listeners } = ownerOf(client);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Reads zeta's parked list again (oldest first; closing chats are not listed); returns zeta's attached session id. */
export async function refreshParked(client: ZetaClient): Promise<string | null> {
  const status = await client.request("status", {}) as { parked_sessions?: unknown; session?: { session_id?: unknown } | null };
  const rows = Array.isArray(status.parked_sessions) ? status.parked_sessions.map(parseRow).filter((row): row is ParkedRow => row !== null) : [];
  publish(client, rows);
  return typeof status.session?.session_id === "string" ? status.session.session_id : null;
}

/**
 * Takes a `parked_session_changed` frame off the socket: true when `text` is one (the caller then drops it, so it never
 * reaches a fulcrum store as an unknown row), false for any other frame.
 */
export function takeParkedEvent(client: object | null, text: string): boolean {
  if (!text.includes('"parked_session_changed"')) return false;
  let frame: { method?: unknown; params?: { event?: unknown; session_id?: unknown; data?: { state?: unknown } } };
  try { frame = JSON.parse(text); } catch { return false; }
  if (frame.method !== "event" || frame.params?.event !== "parked_session_changed") return false;
  const sessionId = frame.params.session_id;
  if (!client || typeof sessionId !== "string") return true;
  const rows = ownerOf(client).rows;
  const index = rows.findIndex((row) => row.session_id === sessionId);
  // only this tab holds a parked chat, so it stores the chat's state for every tab's sidebar: on a change, and on close
  const before = index < 0 ? undefined : rowState(undefined, { from: "parked", row: rows[index]! }).shown;
  if (frame.params.data?.state === "closed") {
    void writeRowState(sessionId, rowState(before, { from: "closed" }).write);
    if (index >= 0) publish(client, rows.filter((row) => row.session_id !== sessionId));
    return true;
  }
  const row = parseRow({ ...frame.params.data, session_id: sessionId });
  if (!row) return true;
  void writeRowState(sessionId, rowState(before, { from: "parked", row }).write);
  publish(client, index < 0 ? [...rows, row] : rows.map((old, at) => at === index ? row : old));
  return true;
}

const aborted = () => Object.assign(new Error("request aborted"), { name: "AbortError" });
// the chat already closed or left this tab: nothing to stop
const gone = (caught: unknown) => {
  const error = caught as { code?: unknown; data?: { code?: unknown } | null } | null;
  return error?.code === -32003 || error?.data?.code === "session_controlled" || error?.data?.code === "session_not_found";
};
export class StopError extends Error {}

/**
 * Stops one of this tab's parked chats. zeta has no stop for a parked chat, so: `resume` it (one's own parked chat never
 * meets parked_limit; the shown chat parks in its place), then `abort` it (its turn, approvals and background children;
 * not background tasks). The stopped chat is then zeta's attached session; the caller repeats its swap, which closes it.
 * Its row keeps its last state: it may still hold work, and the chat list check corrects it once zeta closed it.
 * `bindingOf` gives the chat's page binding, or null when achilles no longer lists the chat. Returns false when the
 * chat had already left (nothing to abort); throws StopError when abort fails (the parked list is read again first).
 */
export async function stopParked(client: ZetaClient, sessionId: string, bindingOf: (sessionId: string) => Promise<Binding | null>, current: () => boolean): Promise<boolean> {
  const binding = await bindingOf(sessionId);
  if (!current()) throw aborted();
  if (!binding) return false;
  try { await rebindPage(client, sessionId, binding); }
  catch (caught) { if (gone(caught)) return false; throw caught; }
  if (!current()) throw aborted();
  try { await client.request("abort", { session_id: sessionId }); }
  catch (caught) {
    await refreshParked(client).catch(() => null);
    throw new StopError(caught instanceof Error ? caught.message : String(caught));
  }
  await refreshParked(client).catch(() => null);
  return true;
}

type Reclaim = { run: Promise<void>; skipped: string | null };
const reclaims = new WeakMap<object, Reclaim>();
/**
 * After a reload, a cross-page load or a reconnect, takes this tab's held chats back from zeta's grace (90 s), once per
 * connection: zeta knows no tab, so the tab remembers the ids. Each `resume` (exact id, with the page binding) takes one
 * back and parks the one before it (or closes it when it finished). Parked chats go first, oldest first, and the chat
 * that was shown goes last, so the order is as before; `target`, the chat about to open, is left to the caller.
 * When a later attach on the connection opens another chat, the first target is no longer the caller's: it is taken
 * back too, before the later attach goes on (the url is the tab's chat, read at each attach, not once).
 * A chat another client holds (the old socket may not have closed yet) is retried within one shared budget, then
 * dropped; a missing chat or one that is not ours is dropped; resident_limit stops the reclaim.
 */
export function reclaimHeld(client: ZetaClient, target: string | null, bindingOf: (sessionId: string) => Promise<Binding | null>): Promise<void> {
  let reclaim = reclaims.get(client);
  if (!reclaim) {
    const held = readHeld();
    const order = [...new Set([...held.parked, held.attached])].filter((id): id is string => id !== null);
    reclaims.set(client, reclaim = { run: Promise.resolve(), skipped: target !== null && order.includes(target) ? target : null });
    reclaim.run = takeBack(client, order.filter((id) => id !== target), bindingOf);
  } else if (reclaim.skipped !== null && reclaim.skipped !== target) {
    const skipped = reclaim.skipped;
    reclaim.skipped = null;
    reclaim.run = reclaim.run.then(() => takeBack(client, [skipped], bindingOf));
  }
  return reclaim.run;
}

async function takeBack(client: ZetaClient, order: string[], bindingOf: (sessionId: string) => Promise<Binding | null>) {
  if (!order.length) return;
  const budget = { retries: CONTROLLED_RETRIES };
  for (const sessionId of order) if (await resumeHeld(client, sessionId, bindingOf, budget) === "stop") break;
  await refreshParked(client).catch(() => null);
}

// one held chat: "ok" taken back, "drop" not ours any more (gone, unlisted, held elsewhere past the budget), "stop" zeta is full
async function resumeHeld(client: ZetaClient, sessionId: string, bindingOf: (sessionId: string) => Promise<Binding | null>, budget: { retries: number }): Promise<"ok" | "drop" | "stop"> {
  const binding = await bindingOf(sessionId).catch(() => null);
  if (!binding) return "drop";
  for (;;) {
    try { await rebindPage(client, sessionId, binding); return "ok"; }
    catch (caught) {
      if (isResidentLimit(caught)) return "stop";
      const controlled = (caught as { data?: { code?: unknown } | null }).data?.code === "session_controlled";
      if (!controlled || budget.retries-- <= 0) return "drop";
      await controlledRetry.wait(CONTROLLED_RETRY_MS);
    }
  }
}
