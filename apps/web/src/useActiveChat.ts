import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ZetaError, type SessionLease, type ZetaClient } from "@fulcrum/zeta";
import type { Chat } from "./AppShell";
import { supportsFeature } from "./zeta";
import { getSettings } from "./settings";
import { draftStore } from "./draftStore";
import type { SendIntent } from "./composer/useComposerDelivery";
import { MAYBE_SENT, SendRefused } from "./composer/composer-machine";
import { createChatCreationOwner, StaleCreation, type ChatCreationInput, type ChatCreationOwner, type PendingChat } from "./chatCreation";
import { ChatBusyError, creationApprovalMode, loadSession, openHomeSession, pageBinding, runningSession, SessionNotFoundError } from "./zeta/session";
import { createTurnEndOwner, whenTurnEnds } from "./zeta/turnEnd";

export type Page = { id: string; route: string; title: string; zeta_session_id: string | null; workspace: string; create_mode: boolean; approval_mode?: string | null; active_layout_version?: number; layout: { blocks: Array<Record<string, unknown>> } };
type PageAttachment = { page: Page; serverApprovalMode: string | null; credential: string };
// newChat: the user asked for a new chat that zeta refused to start; its first send must create one, never open a chat
type EmptyState = PageAttachment & { phase: "empty"; newChat?: true };
// rebind: attached during a live turn without `resume`, so the page MCP binding must be re-sent once zeta is idle.
type ReadyState = PageAttachment & { phase: "ready"; sessionId: string; lease: SessionLease; pendingApprovalMode: string | null; title: string; autoTitle: string; sent: boolean; rebind: boolean };
type BusyState = PageAttachment & { phase: "busy"; busySessionId: string | null };
type State = { phase: "loading" } | { phase: "error"; error: string } | { phase: "missing" } | EmptyState | ReadyState | BusyState;
type BusyChat = { sessionId: string | null; chat: Chat | null; retry: "attach" | "new" };
const ATTACH_SLOW_MS = 15_000;
type AttachmentClock = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
const attachmentClock: AttachmentClock = globalThis;

function claimComposerFocus() {
  const owner = document.activeElement;
  let moved = false;
  const markMoved = () => { moved = true; };
  addEventListener("pointerdown", markMoved, true);
  addEventListener("focusin", markMoved, true);
  return {
    owns: () => !moved && (document.activeElement === owner || (owner !== null && !owner.isConnected && document.activeElement === document.body)),
    release: () => { removeEventListener("pointerdown", markMoved, true); removeEventListener("focusin", markMoved, true); },
  };
}

export function createAttachmentOwner(release: (lease: SessionLease) => void = (lease) => lease.release()) {
  let attempt = 0;
  let identity: string | null = null;
  let lease: SessionLease | null = null;
  return {
    begin(nextIdentity: string, replace = false) {
      if (!replace && identity === nextIdentity) return attempt;
      identity = nextIdentity; attempt += 1;
      if (lease) { release(lease); lease = null; }
      return attempt;
    },
    accept(token: number, next: SessionLease) { if (token !== attempt) { release(next); return false; } if (lease) release(lease); lease = next; return true; },
    release(token: number) { if (token === attempt && lease) { release(lease); lease = null; } },
    token() { return attempt; },
    current(token: number) { return token === attempt; },
    clear(token?: number) { if (token === undefined || token === attempt) { identity = null; attempt += 1; if (lease) { release(lease); lease = null; } } },
  };
}

// the server stores at most 200 characters; cut by code points so an emoji at the edge never leaves half a surrogate pair
export const cutTitle = (text: string) => Array.from(text.trim()).slice(0, 200).join("");

// the first user message text in a loaded history, or "" when it has none
export function firstUserText(store: SessionLease["store"]): string {
  for (const { id } of store.getState().outline) {
    const item = store.getItem(id);
    if (item?.type === "user" && item.event.type === "user_message" && item.event.text.trim()) return item.event.text;
  }
  return "";
}

// marks the chat sent (it joins the chat list) and stores its first-message title once
export function persistFirstMessage(sessionId: string, firstMessage: string, onSuccess: () => void): void {
  void fetch(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ first_message: firstMessage }) })
    .then((response) => { if (response.ok) onSuccess(); })
    .catch((error) => console.error("could not record the first message", error));
}

export async function persistChatTitle(sessionId: string, title: string | null, titledByUser: boolean, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchFn(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, titled_by_user: titledByUser }) });
    return response.ok;
  } catch { return false; }
}

export async function persistChatState(sessionId: string, lastState: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchFn(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ last_state: lastState }) });
    return true;
  } catch { return false; }
}

function attachmentError(caught: unknown, context: "loading" | "creation" = "loading"): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (message === "Failed to fetch" || message === "Load failed") return `achilles is unavailable while ${context === "creation" ? "creating the chat" : "loading the chat"}.`;
  return message.includes("MCP server is not a trusted global server: achilles")
    ? "achilles is not trusted by zeta. add it to $ZETA_HOME/mcp.json, then restart zeta serve."
    : message;
}

async function findChat(sessionId: string) {
  let before: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "200", include: sessionId });
    if (before) params.set("before", before);
    const response = await fetch(`/api/chats?${params}`, { cache: "no-store" });
    if (!response.ok) return null;
    const result = await response.json() as { chats: Chat[]; next: string | null };
    const found = result.chats.find((chat) => chat.session_id === sessionId);
    if (found) return found;
    if (!result.chats.length) return null;
    before = result.next;
  } while (before);
  return null;
}

// the newest listed chat (the sidebar's order) that matches
async function findNewestChat(matches: (chat: Chat) => boolean) {
  let before: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "200" });
    if (before) params.set("before", before);
    const response = await fetch(`/api/chats?${params}`, { cache: "no-store" });
    if (!response.ok) return null;
    const result = await response.json() as { chats: Chat[]; next: string | null };
    const found = result.chats.find(matches);
    if (found) return found;
    before = result.next;
  } while (before);
  return null;
}

type AttachmentOwner = ReturnType<typeof createAttachmentOwner>;
class StaleAttachment extends Error {}
const requireCurrent = (owner: AttachmentOwner, token: number) => { if (!owner.current(token)) throw new StaleAttachment(); };

export async function attachPage(
  client: ZetaClient,
  key: string,
  selectedId: string | null,
  owner: AttachmentOwner,
  creation: ChatCreationOwner,
  token: number,
  create = false,
  applyCreateMode?: (ready: ReadyState, enabled: boolean) => Promise<ReadyState>,
  publishReady: (ready: ReadyState) => Promise<void> | void = () => {},
  forceNew = false,
  canMutate = true,
): Promise<EmptyState | ReadyState | BusyState> {
  let ownsLease = false;
  try {
    const loaded = await fetch(`/api/pages/${key}`, { cache: "no-store" }); requireCurrent(owner, token);
    if (!loaded.ok) throw new Error("page not found");
    const page = await loaded.json() as Page; requireCurrent(owner, token);
    if (!supportsFeature(client, "session_mcp_bindings")) throw new Error("this zeta does not support page tools");
    const credentialResponse = await fetch(`/api/pages/${page.id}/credential`, { cache: "no-store" }); requireCurrent(owner, token);
    if (!credentialResponse.ok) throw new Error(`could not load page credential (${credentialResponse.status})`);
    const credential = ((await credentialResponse.json()) as { credential: string }).credential; requireCurrent(owner, token);
    const creationInput = { client, pageId: page.id, credential, cwd: page.workspace, mode: creationApprovalMode(page.approval_mode, getSettings().autoApproveDefault) };
    const selectedChat = selectedId ? await findChat(selectedId) : null; requireCurrent(owner, token);
    if (selectedId && selectedChat?.page_id !== page.id) throw new MissingChatError(creationInput, page.route === "/" ? "/" : page.route);
    const serverApprovalMode = page.approval_mode ?? null;

    const observer = !canMutate;
    const attachSession = async (sessionId: string): Promise<ReadyState> => {
      const session = observer
        ? { id: sessionId, name: selectedChat?.title ?? selectedChat?.first_title ?? null, approvalMode: serverApprovalMode, pending: false, rebind: false }
        : await openHomeSession(client, sessionId, credential, page.workspace, serverApprovalMode, () => owner.current(token));
      requireCurrent(owner, token);
      const lease = await loadSession(client, session.id, () => owner.current(token));
      if (!owner.accept(token, lease)) throw new StaleAttachment();
      ownsLease = true;
      page.approval_mode = session.approvalMode;
      const storedChat = selectedChat ?? (await findChat(session.id)); requireCurrent(owner, token);
      const userTitled = Boolean(storedChat?.titled_by_user);
      // a chat whose first-message record was lost (a failed PATCH, a closed tab) is repaired from its history
      const historyTitle = storedChat && !userTitled && !(storedChat.message_sent && (storedChat.title || storedChat.first_title)) ? cutTitle(firstUserText(lease.store)) : "";
      if (historyTitle && canMutate) persistFirstMessage(session.id, historyTitle, () => {});
      const autoTitle = session.name?.trim() || (userTitled ? "" : storedChat?.title?.trim()) || storedChat?.first_title?.trim() || historyTitle || "new chat";
      const title = userTitled ? (storedChat?.title?.trim() || autoTitle) : autoTitle;
      if (canMutate && !userTitled && session.name?.trim() && session.name.trim() !== storedChat?.title?.trim())
        void fetch(`/api/chats/${encodeURIComponent(session.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
      return { phase: "ready", page, serverApprovalMode, sessionId: session.id, lease, credential, pendingApprovalMode: session.pending ? "ask" : null, title, autoTitle, sent: storedChat?.message_sent ?? false, rebind: session.rebind };
    };
    const busy = (busySessionId: string | null): BusyState => ({ phase: "busy", page, serverApprovalMode, credential, busySessionId });

    const creationStatus = creation.status(page.id);
    const pending = creationStatus.pending;
    if (creationStatus.createMode !== undefined) page.create_mode = creationStatus.createMode;
    // with no chat named, a page opens on its most recent chat (the sidebar's order), then on its home chat (page.zeta_session_id)
    // shortcut: scans the whole chat list for a page with no listed chat; add a page filter to /api/chats if that gets slow
    const newest = forceNew || create || selectedId || pending ? null : await findNewestChat((chat) => chat.page_id === page.id); requireCurrent(owner, token);
    const candidates = forceNew || pending ? [] : selectedId ? [selectedId] : [...new Set([newest?.session_id, page.zeta_session_id])].filter((id): id is string => Boolean(id));
    for (const sessionId of candidates) {
      try { return await attachSession(sessionId); }
      catch (caught) {
        if (caught instanceof ChatBusyError) return busy(caught.sessionId);
        if (!(caught instanceof SessionNotFoundError)) throw caught;
        if (selectedId) throw new MissingChatError(creationInput, page.route === "/" ? "/" : page.route);
        // only a lost home chat is replaced: the replacement moves page.zeta_session_id. a lost newer chat falls back to home
        if (sessionId === page.zeta_session_id) create = true;
      }
    }
    if (!pending && !create) return { phase: "empty", page, serverApprovalMode, credential };

    const mappingInput = forceNew ? creationInput : { ...creationInput, mapExpectedSessionId: page.zeta_session_id };
    try {
      const ready = await creation.ensure({ input: mappingInput, current: () => owner.current(token), attach: attachSession, applyCreateMode, publishReady, create });
      if (!ready) return { phase: "empty", page, serverApprovalMode, credential };
      return ready as ReadyState;
    } catch (caught) {
      // a joined create of an earlier attachment stopped and forgot its record: open this attachment's own choice again.
      // bounded: each re-run follows one stopped create, and a stale attachment can no longer start one
      if (caught instanceof StaleCreation) { if (!owner.current(token)) throw caught; return attachPage(client, key, selectedId, owner, creation, token, create, applyCreateMode, publishReady, forceNew, canMutate); }
      if (caught instanceof ChatBusyError) return busy(caught.sessionId);
      if (errorCode(caught) === TURN_RUNNING && !creation.status(page.id).pending) return busy(await runningSession(client));
      throw new PendingCreationError(caught, mappingInput);
    }
  } catch (caught) {
    if (ownsLease) owner.release(token);
    throw caught;
  }
}

const selectedFromUrl = () => new URLSearchParams(location.search).get("chat");
const keyFromPath = () => location.pathname === "/" ? "home" : location.pathname.slice(1);
const routeWithChat = (route: string, sessionId: string) => {
  const url = new URL(route, location.href);
  url.search = location.search;
  url.searchParams.set("chat", sessionId);
  return `${url.pathname}${url.search}`;
};

class MissingChatError extends Error {
  constructor(readonly input: ChatCreationInput, readonly route: string) { super("this chat no longer exists"); }
}

class PendingCreationError extends Error {
  constructor(caught: unknown, readonly input: ChatCreationInput) { super(attachmentError(caught, "creation")); }
}

const NO_CREATION = { pending: null, error: null };

type DeliveryStatus = { status: "queued" | "delivered" | "dropped" | "evicted" | "unknown"; outcome?: "queued" | "delivered" | "dropped" };

type CreateModeToggleInput = {
  client: Pick<ZetaClient, "features" | "request">;
  pageId: string;
  sessionId: string;
  enabled: boolean;
};
type CreateModeToggleResult = { createMode: boolean | null; error: string | null; blocked: boolean; retryable: boolean };
type CreateModeToggleRun = { generation: number; outcome: CreateModeToggleResult; cancelled: boolean };

function expiredMcpSession(caught: unknown): boolean {
  const error = caught as { code?: unknown; data?: { reason?: unknown } };
  return error.code === -32005 && typeof error.data?.reason === "string" && error.data.reason.includes("MCP HTTP 404: Session not found");
}

function refreshToolsError(caught: unknown): { message: string; blocked: boolean; retryable: boolean } {
  const error = caught as { code?: unknown; message?: unknown; data?: { reason?: unknown } };
  const reason = typeof error.data?.reason === "string" ? error.data.reason : "";
  if (error.code === -32601) return { message: "", blocked: false, retryable: false };
  if (expiredMcpSession(caught)) return { message: "achilles restarted, but zeta kept its expired MCP session. restart zeta serve, then reload this page before using create mode.", blocked: true, retryable: false };
  if (error.code === -32005) return { message: `zeta could not refresh page tools${reason ? `: ${reason}` : ""}. retry the refresh.`, blocked: true, retryable: true };
  if (error.code === -32602) return { message: "zeta could not find the achilles page tools. retry the refresh.", blocked: true, retryable: true };
  if (error.code === -32003) return { message: "zeta is attached to a different chat. retry the refresh.", blocked: true, retryable: true };
  return { message: `could not refresh page tools: ${String(error.message ?? caught)}. retry the refresh.`, blocked: true, retryable: true };
}

// The one rule for the shown create mode: a chat whose tool refresh failed keeps its old mode until a refresh succeeds,
// even though the server already stored the new one.
function shownCreateMode<T extends EmptyState | ReadyState>(toggle: ReturnType<typeof createModeToggleOwner>, next: T): T {
  const stale = toggle.stale();
  return stale && next.phase === "ready" && next.sessionId === stale.sessionId ? { ...next, page: { ...next.page, create_mode: stale.createMode } } : next;
}

export function createModeToggleOwner(fetchFn: typeof fetch = fetch) {
  let generation = 0;
  let pending: Promise<CreateModeToggleRun> | null = null;
  let published: Promise<CreateModeToggleResult> | null = null;
  let active: { generation: number; cancelled: boolean } | null = null;
  let retry: { input: CreateModeToggleInput; refreshOnly: boolean } | null = null;
  const refresh = async (input: CreateModeToggleInput, createMode: boolean, mine: number): Promise<CreateModeToggleResult> => {
    if (!input.client.features.includes("mcp_refresh_tools")) return { createMode, error: null, blocked: false, retryable: false };
    try {
      try {
        await input.client.request("mcp_refresh_tools", { session_id: input.sessionId, server: "achilles" });
      } catch (caught) {
        if (!expiredMcpSession(caught)) throw caught;
        await input.client.request("mcp_refresh_tools", { session_id: input.sessionId, server: "achilles" });
      }
      if (mine === generation) retry = null;
      return { createMode, error: null, blocked: false, retryable: false };
    } catch (caught) {
      const failure = refreshToolsError(caught);
      if (mine === generation) retry = failure.blocked ? { input: { ...input, enabled: createMode }, refreshOnly: true } : null;
      return { createMode: failure.blocked ? null : createMode, error: failure.message || null, blocked: failure.blocked, retryable: failure.retryable };
    }
  };
  return {
    run(input: CreateModeToggleInput) {
      if (published) return published;
      const mine = generation;
      const run = { generation: mine, cancelled: false };
      active = run;
      const target = retry?.input ?? input;
      const task = (async () => {
        if (retry?.refreshOnly) return refresh(target, target.enabled, mine);
        const response = await fetchFn(`/api/pages/${target.pageId}/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: target.enabled }) });
        if (!response.ok) throw new Error(`could not update create mode (${response.status})`);
        const result = await response.json() as { create_mode: boolean };
        return refresh(target, result.create_mode, mine);
      })().catch((caught) => {
        if (mine === generation) retry = { input: target, refreshOnly: false };
        return { createMode: null, error: caught instanceof Error ? caught.message : String(caught), blocked: true, retryable: true };
      });
      pending = task.then((outcome) => ({ generation: run.generation, outcome, cancelled: run.cancelled })).finally(() => {
        if (active === run) { active = null; pending = null; published = null; }
      });
      published = pending.then(({ outcome }) => outcome);
      return published;
    },
    async beforeSend() {
      const mine = generation;
      const awaited = pending;
      const blockedWithoutRun = !awaited && retry !== null;
      const result = awaited ? await awaited : null;
      if (blockedWithoutRun || (result && (result.generation !== mine || result.cancelled || result.outcome.blocked))) throw new Error("send is off until page tools refresh. retry create mode.");
    },
    // The chat whose tools are stale, and the create mode its header keeps until a refresh succeeds.
    stale() { return retry ? { sessionId: retry.input.sessionId, createMode: !retry.input.enabled, idle: !active } : null; },
    reset() {
      generation += 1;
      if (active) active.cancelled = true;
      active = null; pending = null; published = null; retry = null;
    },
  };
}

// Never resend text automatically: zeta (>= 5c517d85) settles every accepted steer as delivered or dropped,
// including one sent while the final reply streams (it starts the next turn).
export class DroppedSteerDeliveryError extends Error {}

const TURN_RUNNING = -32004;
const NO_TURN = -32005;
const ID_EVICTED = -32010;
// zeta sends it with no request id; fulcrum rejects every pending request with it
const OUTPUT_OVERFLOW = -32011;
const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

export function pageDeliverySteer(phase: State["phase"], intent: { steer: boolean }) {
  return phase === "ready" && intent.steer;
}

export async function deliverChatMessage(
  client: Pick<ZetaClient, "request">,
  sessionId: string,
  text: string,
  deliveryId: string,
  steer: boolean,
  track: (id: string) => void,
): Promise<"send" | "steer"> {
  try {
    return await deliverOnce(client, sessionId, text, deliveryId, steer, track);
  } catch (error) {
    const outcome = classify(error);
    if (outcome === "sent") return steer ? "steer" : "send";
    if (outcome !== "resend") throw outcome === "maybe" ? new Error(MAYBE_SENT) : refusal(error);
  }
  try {
    return await deliverOnce(client, sessionId, text, crypto.randomUUID(), steer, track);
  } catch (error) {
    // the one resend: zeta's answer is shown and nothing goes out again by itself
    throw classify(error) === "rethrow" || error instanceof DroppedDuplicateError ? refusal(error) : new Error(MAYBE_SENT);
  }
}

// zeta's answer, so the row's composer knows zeta holds nothing under the refused id
const refusal = (error: unknown) => new SendRefused(error instanceof Error ? error.message : String(error), { cause: error });

/**
 * What a failed delivery means:
 * - "sent": a reused id zeta took and then forgot (-32010 queued/delivered): it holds the text.
 * - "resend": zeta dropped the reused id (terminal, never delivered): it holds nothing, so one send with a fresh id.
 * - "maybe": no answer from zeta (a timeout, a closed socket, an id-less error fulcrum rejects every pending request
 *   with, an id forgotten without a known outcome): it may hold the text, so the row says so and is never resent.
 * - "rethrow": zeta answered with a refusal (a drop, an error code, a reply it never sends): it holds nothing new.
 */
function classify(error: unknown): "sent" | "resend" | "maybe" | "rethrow" {
  if (error instanceof DroppedDuplicateError) return "resend";
  if (error instanceof DroppedSteerDeliveryError || error instanceof RefusedError) return "rethrow";
  const code = errorCode(error);
  if (code === ID_EVICTED) {
    const outcome = (error as { data?: { outcome?: unknown } }).data?.outcome;
    return outcome === "queued" || outcome === "delivered" ? "sent" : outcome === "dropped" ? "resend" : "maybe";
  }
  // a ZetaError's code is the websocket close code, not zeta's answer
  return typeof code === "number" && code !== OUTPUT_OVERFLOW && !(error instanceof ZetaError) ? "rethrow" : "maybe";
}

async function deliverOnce(
  client: Pick<ZetaClient, "request">,
  sessionId: string,
  text: string,
  deliveryId: string,
  steer: boolean,
  track: (id: string) => void,
): Promise<"send" | "steer"> {
  const first: "send" | "steer" = steer ? "steer" : "send";
  let used = first;
  // tracked before the request: zeta echoes an accepted message before it answers
  track(deliveryId);
  try {
    accepted(await client.request(first, { session_id: sessionId, text, delivery_id: deliveryId }));
  } catch (error) {
    if (error instanceof DroppedDuplicateError) throw error;
    // zeta serve-protocol: "A `send` that arrives right after `turn_end` either starts the turn that carries the steer,
    // or gets `-32004` because that turn has already started; the client should then retry the text as a `steer`."
    // A refused request records no delivery ID, so the one retry reuses it; a second refusal is shown, not retried.
    if (errorCode(error) !== (steer ? NO_TURN : TURN_RUNNING)) throw error;
    used = steer ? "send" : "steer";
    accepted(await client.request(used, { session_id: sessionId, text, delivery_id: deliveryId }));
  }
  if (used === "steer") await confirmSteerDelivery(client, deliveryId);
  return used;
}

class RefusedError extends Error {}
class DroppedDuplicateError extends RefusedError {}

// zeta (delivery.py `_duplicate`) answers a new or reused id with `accepted: true` (a reused id it holds, queued or
// delivered, adds `duplicate: true`), and a reused id it dropped with `{ accepted: false, duplicate: true, status: "dropped" }`
function accepted(result: unknown) {
  const reply = (result ?? {}) as { accepted?: unknown; duplicate?: unknown; status?: unknown };
  if (reply.accepted === true) return;
  if (reply.accepted === false && reply.duplicate === true && reply.status === "dropped") throw new DroppedDuplicateError("zeta dropped this message before reading it.");
  throw new RefusedError(`zeta did not accept this message (${JSON.stringify(result) ?? "no reply"}).`);
}

// marks a steer as queued from the moment its delivery id is tracked until the send settles (resolve or reject);
// zeta has no live "delivered" event, so this settle is the only thing that un-hides the delivered steer
export async function trackQueuedSteer<T>(
  send: (track: (id: string) => void) => Promise<T>,
  add: (id: string) => void,
  remove: (id: string) => void,
): Promise<T> {
  let tracked: string | undefined;
  try {
    return await send((id) => { tracked = id; add(id); });
  } finally {
    if (tracked !== undefined) remove(tracked);
  }
}

export async function confirmSteerDelivery(
  client: Pick<ZetaClient, "request">,
  deliveryId: string,
): Promise<string> {
  for (;;) {
    const result: unknown = await client.request("delivery_status", { delivery_id: deliveryId }, { timeoutMs: 1_000 });
    if (!result || typeof result !== "object") throw new Error("invalid steer delivery status");
    const status = result as DeliveryStatus;
    const outcome = status.status === "evicted" ? status.outcome : status.status;
    if (outcome === "delivered") return deliveryId;
    if (outcome === "dropped") throw new DroppedSteerDeliveryError("zeta dropped this message before reading it.");
    if (outcome !== "queued") throw new Error(`steer delivery status: ${status.status}`);
    // a steer waits for the next model step, which can follow a long tool run or an approval
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function useActiveChat(client: ZetaClient | null, connected: boolean, clock: AttachmentClock = attachmentClock, canMutate = true) {
  const [selectedId, setSelectedId] = useState(selectedFromUrl);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attachSlow, setAttachSlow] = useState(false);
  const [creationPageId, setCreationPageId] = useState<string | null>(null);
  // "new chat" is creating a chat: the page keeps its header and a read-only composer, and the pane says "creating chat…"
  const [creatingChat, setCreatingChat] = useState(false);
  const newChatRun = useRef(0);
  // "retry creating chat" re-runs the attach: the failed-create screen and its header stay until the retry settles
  const retryingCreation = useRef(false);
  const [listRefresh, setListRefresh] = useState(0);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleBlocked, setToggleBlocked] = useState(false);
  const [toggleRetryable, setToggleRetryable] = useState(false);
  const modeToggle = useRef(createModeToggleOwner());
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [routeRefresh, setRouteRefresh] = useState(0);
  const owner = useRef(createAttachmentOwner());
  const creation = useRef(createChatCreationOwner());
  const status = useSyncExternalStore(creation.current.subscribe, () => creationPageId ? creation.current.status(creationPageId) : NO_CREATION);
  const creationError = status.error ? attachmentError(status.error, "creation") : null;
  const missingCreation = useRef<{ input: ChatCreationInput; route: string } | null>(null);
  const createAfterLoad = useRef(false);
  const pendingSelection = useRef<{ sessionId: string; sawRunning: boolean } | null>(null);
  const [busy, setBusy] = useState<BusyChat | null>(null);
  const showBusy = useCallback(async (sessionId: string | null, retry: BusyChat["retry"]) => {
    const chat = sessionId ? await findChat(sessionId).catch(() => null) : null;
    setBusy({ sessionId, chat, retry });
  }, []);

  const applyPendingCreateMode = useCallback(async (ready: ReadyState, enabled: boolean) => {
    if (!client) throw new Error("zeta is not connected");
    const result = await modeToggle.current.run({ client, pageId: ready.page.id, sessionId: ready.sessionId, enabled });
    // A failed tool refresh keeps the new chat: the inline notice offers retry instead of a full-page error.
    if (result.blocked && modeToggle.current.stale()?.sessionId === ready.sessionId) { setToggleError(result.error); setToggleBlocked(true); setToggleRetryable(result.retryable); }
    return { ...ready, page: { ...ready.page, create_mode: result.createMode ?? !enabled } };
  }, [client]);

  const publishReady = useCallback((ready: ReadyState, token: number, replace = false, focus = false, select = true) => {
    requireCurrent(owner.current, token);
    missingCreation.current = null;
    setCreationPageId(ready.page.id);
    setListRefresh((value) => value + 1);
    const route = routeWithChat(ready.page.route === "/" ? "/" : ready.page.route, ready.sessionId);
    if (replace) history.replaceState({}, "", route); else history.pushState({}, "", route);
    if (focus) setFocusSessionId(ready.sessionId);
    if (select) setSelectedId(ready.sessionId);
    setState(ready);
  }, []);

  useEffect(() => {
    // read before the offline return: a retry clicked while offline must not stay set for a later, unrelated attach
    const retrying = retryingCreation.current; retryingCreation.current = false;
    if (!client || !connected) return;
    const token = owner.current.begin(`${keyFromPath()}:${selectedId ?? "default"}`, true);
    // Selecting a chat whose tool refresh failed re-attaches it; its retry notice stays until a refresh succeeds.
    const stale = modeToggle.current.stale();
    const keepStale = stale?.idle && stale.sessionId === selectedId ? stale : null;
    if (!keepStale) { modeToggle.current.reset(); setToggleError(null); setToggling(false); setToggleBlocked(false); setToggleRetryable(false); }
    if (!retrying) setCreationPageId(null);
    setCreatingChat(false);
    setAttachSlow(false);
    setState((current) => current.phase === "ready" || (retrying && current.phase === "empty") ? current : { phase: "loading" });
    const slowTimer = clock.setTimeout(() => { if (owner.current.current(token)) setAttachSlow(true); }, ATTACH_SLOW_MS);
    void attachPage(client, keyFromPath(), selectedId, owner.current, creation.current, token, false, canMutate ? applyPendingCreateMode : undefined, async (next) => {
      if (!owner.current.current(token)) throw new StaleAttachment();
      if (creation.current.status(next.page.id).pending) publishReady(next, token);
      else setState(shownCreateMode(modeToggle.current, next));
    }, canMutate).then((next) => {
      if (!owner.current.current(token)) return;
      setCreationPageId(next.page.id);
      if (next.phase === "busy") void showBusy(next.busySessionId, "attach");
      setState(next.phase === "busy" ? next : shownCreateMode(modeToggle.current, next));
    }).catch((caught) => {
      if (caught instanceof PendingCreationError && owner.current.current(token)) {
        setCreationPageId(caught.input.pageId);
      } else if (caught instanceof MissingChatError && owner.current.current(token)) {
        missingCreation.current = { input: caught.input, route: caught.route };
        setState({ phase: "missing" });
      } else if (!(caught instanceof StaleAttachment) && owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught) });
    }).finally(() => {
      clock.clearTimeout(slowTimer);
      if (owner.current.current(token)) setAttachSlow(false);
    });
    return () => { clock.clearTimeout(slowTimer); owner.current.clear(token); };
  }, [applyPendingCreateMode, client, clock, connected, publishReady, routeRefresh, selectedId, showBusy]);

  useEffect(() => {
    const pop = () => { owner.current.clear(); setState({ phase: "loading" }); setSelectedId(selectedFromUrl()); };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => () => owner.current.clear(), []);

  const selectChat = useCallback((chat: Chat) => {
    setBusy(null);
    const route = chat.page_route === "/" ? "/" : chat.page_route;
    const target = routeWithChat(route, chat.session_id);
    if (route !== location.pathname) { location.assign(target); return; }
    // the chat named in the url but not shown (a refused new chat shows the new chat's box): open it again
    if (chat.session_id === selectedId) {
      if (state.phase !== "ready") { if (`${location.pathname}${location.search}` !== target) history.pushState({}, "", target); setRouteRefresh((value) => value + 1); }
      return;
    }
    owner.current.begin(`${keyFromPath()}:${chat.session_id}`);
    setState({ phase: "loading" });
    history.pushState({}, "", target);
    setFocusSessionId(null);
    setSelectedId(chat.session_id);
  }, [selectedId, state.phase]);

  const continueWaitingChat = useCallback(async () => {
    if (!canMutate) return;
    const waiting = await findNewestChat((chat) => chat.last_state === "approval");
    if (waiting) selectChat(waiting);
  }, [canMutate, selectChat]);

  const newChat = useCallback(async () => {
    if (!canMutate || !client) return;
    if (state.phase === "error" && state.error === "page not found") {
      createAfterLoad.current = true;
      owner.current.clear();
      history.pushState({}, "", "/");
      setState({ phase: "loading" });
      setSelectedId(null);
      setRouteRefresh((value) => value + 1);
      return;
    }
    setBusy(null);
    const context = state.phase === "ready" || state.phase === "empty" || state.phase === "busy"
      ? { route: state.page.route, pageId: state.page.id }
      : state.phase === "missing" && missingCreation.current ? { route: missingCreation.current.route, pageId: missingCreation.current.input.pageId } : null;
    if (!context) return;
    const key = context.route === "/" ? "home" : context.route.slice(1);
    const token = owner.current.begin(`new:${key}`, true);
    const focusClaim = claimComposerFocus();
    const run = ++newChatRun.current;
    // the page stays (header, new-chat box) while the chat is created; it can wait for an earlier create of the page
    setState(state.phase !== "ready" && state.phase !== "empty" && state.phase !== "busy" ? { phase: "loading" } : { phase: "empty", page: state.page, serverApprovalMode: state.serverApprovalMode, credential: state.credential, newChat: true });
    setCreatingChat(true);
    try {
      const next = await attachPage(client, key, null, owner.current, creation.current, token, true, canMutate ? applyPendingCreateMode : undefined, (ready) => publishReady(ready, token, false, focusClaim.owns()), true, canMutate);
      // zeta cannot start a chat while another turn runs: say which chat runs and keep the new chat's box. text typed
      // there was written for a new chat, so it must never go to the running chat.
      if (next.phase === "busy" && owner.current.current(token)) {
        void showBusy(next.busySessionId, "new");
        // the address names no chat while the new chat's box shows (a reload opens the page's latest chat and its unsent note)
        if (new URLSearchParams(location.search).has("chat")) { const url = new URL(location.href); url.searchParams.delete("chat"); history.pushState({}, "", `${url.pathname}${url.search}`); }
        setState({ phase: "empty", page: next.page, serverApprovalMode: next.serverApprovalMode, credential: next.credential, newChat: true });
      }
    } catch (caught) {
      if (!creation.current.status(context.pageId).pending && owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught, "creation") });
    } finally {
      focusClaim.release();
      if (newChatRun.current === run) setCreatingChat(false);
    }
  }, [applyPendingCreateMode, client, publishReady, showBusy, state]);

  // the unsent-rows notice: show the page's new-chat box with its rows; the chat is made only when one of them is sent
  const openNewChat = useCallback(() => {
    if (state.phase !== "ready") return;
    owner.current.begin(`new:${state.page.route === "/" ? "home" : state.page.route.slice(1)}`, true);
    setState({ phase: "empty", page: state.page, serverApprovalMode: state.serverApprovalMode, credential: state.credential, newChat: true });
  }, [state]);

  const retrySaving = useCallback(() => { if (!canMutate) return; retryingCreation.current = true; setRouteRefresh((value) => value + 1); }, [canMutate]);
  const retryAttachment = useCallback(() => {
    owner.current.clear();
    setAttachSlow(false);
    setRouteRefresh((value) => value + 1);
  }, []);
  // a create that keeps failing is never a dead end: drop it and open the page again (its empty state keeps the new-chat draft)
  const discardCreation = useCallback(() => {
    if (!canMutate) return;
    if (creationPageId) creation.current.discard(creationPageId);
    retryAttachment();
  }, [canMutate, creationPageId, retryAttachment]);
  const retryBusy = useCallback(() => {
    if (!canMutate) return;
    const retry = busy?.retry; setBusy(null);
    if (retry === "new") void newChat(); else retryAttachment();
  }, [busy, canMutate, newChat, retryAttachment]);
  const openBusyChat = useCallback(() => { if (busy?.chat) selectChat(busy.chat); }, [busy, selectChat]);

  useEffect(() => {
    if (!createAfterLoad.current || (state.phase !== "ready" && state.phase !== "empty")) return;
    createAfterLoad.current = false;
    void newChat();
  }, [newChat, state]);

  const updateReady = useCallback((token: number, update: (current: ReadyState) => ReadyState) => {
    if (!owner.current.current(token)) return;
    setState((current) => current.phase === "ready" ? update(current) : current);
  }, []);

  const createFirstChat = useCallback(async (empty: EmptyState, token: number, text: string) => {
    if (!client) throw new Error("zeta is not connected");
    const focusClaim = claimComposerFocus();
    setCreationPageId(empty.page.id);
    try {
      let handedOff = null as ReadyState | null;
      const attached = await attachPage(
        client,
        keyFromPath(),
        null,
        owner.current,
        creation.current,
        token,
        true,
        canMutate ? applyPendingCreateMode : undefined,
        async (ready) => { handedOff = ready; },
        empty.newChat,
        canMutate,
      );
      if (attached.phase === "busy") { void showBusy(attached.busySessionId, empty.newChat ? "new" : "attach"); throw new ChatBusyError(attached.busySessionId); }
      if (attached.phase !== "ready" || handedOff !== attached) throw new Error("created chat did not attach");
      if (modeToggle.current.stale()?.sessionId === attached.sessionId) { // clear the composer draft only when it was the sent text; a starter button must not erase typed text
        draftStore.set(attached.sessionId, text); if (draftStore.get(`new:${empty.page.id}`) === text) draftStore.set(`new:${empty.page.id}`, ""); }
      publishReady(attached, token, true, focusClaim.owns(), false);
      return attached;
    } finally {
      focusClaim.release();
    }
  }, [applyPendingCreateMode, client, publishReady, showBusy]);

  // the open chat's work for when zeta is idle (re-send the page binding, apply a pending mode); see createTurnEndOwner
  const turnEnd = useRef<ReturnType<typeof createTurnEndOwner> | null>(null);
  const ready = state.phase === "ready" ? state : null;
  const workSessionId = ready && (ready.rebind || ready.pendingApprovalMode) ? ready.sessionId : null;
  useEffect(() => {
    if (!client || !ready || !workSessionId) return;
    const token = owner.current.token();
    const turn = createTurnEndOwner({
      client, sessionId: ready.sessionId, binding: pageBinding(ready.credential, ready.page.workspace), clock,
      work: { rebind: ready.rebind, approvalMode: ready.pendingApprovalMode },
      settled: (update) => updateReady(token, (value) => value.sessionId !== ready.sessionId ? value
        : "rebind" in update ? { ...value, rebind: false }
        : { ...value, page: { ...value.page, approval_mode: update.approvalMode }, pendingApprovalMode: update.pendingApprovalMode }),
      failed: (caught) => { if (owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught) }); },
    });
    turnEnd.current = turn;
    return () => { turn.dispose(); if (turnEnd.current === turn) turnEnd.current = null; };
  }, [client, workSessionId, ready?.lease, ready?.rebind, ready?.pendingApprovalMode]); // a new attach (lease) gets a new owner and token

  const send = useCallback(async (text: string, intent: SendIntent, track: (id: string) => void) => {
    if (!canMutate) throw new Error("this tab is read-only; take control to make changes");
    if (!client || (state.phase !== "ready" && state.phase !== "empty")) throw new Error("zeta is not connected");
    await modeToggle.current.beforeSend();
    const token = owner.current.token();
    const steer = pageDeliverySteer(state.phase, intent);
    if (state.phase === "ready") await turnEnd.current?.settle();
    const current = state.phase === "ready" ? state : await createFirstChat(state, token, text);
    if (state.phase === "empty") await modeToggle.current.beforeSend();
    const delivery_id = intent.deliveryId ?? crypto.randomUUID();
    if (state.phase === "empty") pendingSelection.current = { sessionId: current.sessionId, sawRunning: false };
    try {
      await deliverChatMessage(client, current.sessionId, text, delivery_id, steer, track);
    } catch (error) {
      if (pendingSelection.current?.sessionId === current.sessionId) pendingSelection.current = null;
      throw error;
    }
    // not gated on the owner token: a chat switch mid-send must still record the send
    if (current.sent) return;
    const firstTitle = cutTitle(text);
    persistFirstMessage(current.sessionId, firstTitle, () => {
      updateReady(token, (value) => value.sessionId !== current.sessionId ? value : {
        ...value, sent: true,
        autoTitle: value.autoTitle === "new chat" ? firstTitle : value.autoTitle,
        title: value.title === "new chat" ? firstTitle : value.title,
      });
      setListRefresh((value) => value + 1);
    });
  }, [canMutate, client, createFirstChat, state, updateReady]);

  const setPendingCreateMode = useCallback((current: EmptyState, enabled: boolean) => {
    creation.current.setCreateMode(current.page.id, enabled);
    setCreationPageId(current.page.id);
    setState({ ...current, page: { ...current.page, create_mode: enabled } });
  }, []);

  const toggle = useCallback(async () => {
    if (!canMutate) return;
    if (!client || (state.phase !== "ready" && state.phase !== "empty") || (toggleBlocked && !toggleRetryable)) return;
    const current = state; const token = owner.current.token();
    const enabled = !current.page.create_mode;
    if (current.phase === "empty") { setPendingCreateMode(current, enabled); return; }
    setToggling(true); // a shown refresh notice stays until the retry settles, so a second failure never flickers or stacks
    const result = await modeToggle.current.run({ client, pageId: current.page.id, sessionId: current.sessionId, enabled });
    if (!owner.current.current(token)) return;
    if (result.createMode !== null) updateReady(token, (value) => ({ ...value, page: { ...value.page, create_mode: result.createMode! } }));
    setToggleError(result.error); setToggleBlocked(result.blocked); setToggleRetryable(result.retryable); setToggling(false);
  }, [canMutate, client, setPendingCreateMode, state, toggleBlocked, toggleRetryable, updateReady]);

  const rename = useCallback(async (sessionId: string, nextTitle: string): Promise<boolean> => {
    if (!canMutate) return false;
    const token = owner.current.token();
    const trimmed = cutTitle(nextTitle);
    const titledByUser = trimmed.length > 0;
    // clearing the open chat stores its zeta name, so the sidebar and the header show the same title
    const fallback = state.phase === "ready" && state.sessionId === sessionId && state.autoTitle !== "new chat" ? state.autoTitle : null;
    const saved = await persistChatTitle(sessionId, titledByUser ? trimmed : fallback, titledByUser);
    if (!saved) return false;
    updateReady(token, (value) => value.sessionId !== sessionId ? value : { ...value, title: titledByUser ? trimmed : value.autoTitle });
    setListRefresh((value) => value + 1);
    return true;
  }, [canMutate, state, updateReady]);

  const refreshPage = useCallback(async () => {
    // Runs for a page with no chat started yet (phase "empty") as well as a ready chat, so a
    // form write refreshes computed layout values (count metrics) even before the first message.
    if (state.phase !== "ready" && state.phase !== "empty") return;
    const current = state; const token = owner.current.token();
    try {
      const response = await fetch(`/api/pages/${current.page.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`could not refresh page (${response.status})`);
      const page = await response.json() as Page;
      if (!owner.current.current(token)) return;
      setState((value) => (value.phase === "ready" || value.phase === "empty") && value.page.id === page.id ? shownCreateMode(modeToggle.current, { ...value, page: { ...page, approval_mode: value.page.approval_mode } }) : value);
    } catch (caught) {
      if (owner.current.current(token)) console.error("could not refresh page", caught);
    }
  }, [state]);

  // The notice for a running chat clears itself when that turn ends; a blocked attach of another chat then retries.
  const openSessionId = state.phase === "ready" ? state.sessionId : null;
  useEffect(() => {
    if (!client || !busy?.sessionId) return;
    const { sessionId, retry } = busy;
    return whenTurnEnds(client, sessionId, () => { setBusy(null); if (retry === "attach" && sessionId !== openSessionId) retryAttachment(); });
  }, [busy, client, openSessionId, retryAttachment]);

  const recordLastState = useCallback((lastState: string) => {
    // the one owner of the pending selection: a state counts only while its chat is the shown chat. a user who moved
    // away (new chat, another chat, back/forward) shows another view, so that chat's turn end cannot take the view back.
    const pending = pendingSelection.current;
    if (pending && state.phase === "ready" && state.sessionId === pending.sessionId) {
      if (lastState === "running") pending.sawRunning = true;
      if (lastState === "idle" && pending.sawRunning) { setSelectedId(pending.sessionId); pendingSelection.current = null; }
    }
    if (state.phase !== "ready" || !canMutate) return;
    const token = owner.current.token();
    void persistChatState(state.sessionId, lastState)
      .then((saved) => { if (saved && owner.current.current(token)) setListRefresh((value) => value + 1); });
  }, [canMutate, state]);

  return { state, attachSlow, selectedId, listRefresh, toggleError, toggling, toggleBlocked, toggleRetryable, creationError, creationPageId, creatingChat, focusSessionId, retrySaving, discardCreation, retryAttachment, selectChat, continueWaitingChat, newChat, openNewChat, send, toggle, refreshPage, recordLastState, rename, busy, retryBusy, openBusyChat };
}
