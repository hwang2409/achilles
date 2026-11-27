import { continueChatIntent, newChatIntent } from "./surface/routes";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ZetaError, type SessionLease, type ZetaClient } from "@fulcrum/zeta";
import { findChat, titleOf, type Chat } from "./surface/AgentNavAdapter";
import { continuationNotification, sessionMissing } from "./chat/continuation";
import { supportsFeature } from "./zeta";
import { getSettings, useSettings } from "./settings";
import { draftStore } from "./draftStore";
import type { SendIntent } from "./composer/useComposerDelivery";
import { MAYBE_SENT, SendRefused } from "./composer/composer-machine";
import { createChatCreationOwner, StaleCreation, type ChatCreationInput, type ChatCreationOwner, type PendingChat } from "./chatCreation";
import { applyApprovalMode, ChatBusyError, CONTROLLED_RETRIES, creationApprovalMode, loadSession, openHomeSession, pageBinding, ParkedLimitError, runningSession, SessionControlledError, SessionNotFoundError, TOO_MANY_CHATS } from "./zeta/session";
import { holdAttached, parkedRows, reclaimHeld, refreshParked, stopParked, watchClosed } from "./zeta/parked";
import { patchChat, writeShownState, type RowState } from "./zeta/rowState";
import { createTurnEndOwner, whenTurnEnds } from "./zeta/turnEnd";

export type Page = { id: string; route: string; title: string; zeta_session_id: string | null; workspace: string; create_mode: boolean; approval_mode?: string | null; active_layout_version?: number; layout: { blocks: Array<Record<string, unknown>> } };
type PageAttachment = { page: Page; serverApprovalMode: string | null; credential: string };
// newChat: the user asked for a new chat that zeta refused to start; its first send must create one, never open a chat
type EmptyState = PageAttachment & { phase: "empty"; newChat?: true };
// rebind: attached during a live turn without `resume`, so the page MCP binding must be re-sent once zeta is idle.
// controlledElsewhere: another tab controls this chat, so this tab reads it live and cannot write to it.
type ReadyState = PageAttachment & { phase: "ready"; sessionId: string; lease: SessionLease; continued?: true; controlledElsewhere?: true; pendingApprovalMode: string | null; title: string; autoTitle: string; sent: boolean; rebind: boolean; cwd: string | null; model: string | null };
// parked: zeta refused to park one more chat (parked_limit); the ids of the chats this tab keeps running
type BusyState = PageAttachment & { phase: "busy"; busySessionId: string | null; parked?: string[] };
type State = { phase: "loading" } | { phase: "error"; error: string } | { phase: "missing" } | EmptyState | ReadyState | BusyState;
export type ParkedChat = { sessionId: string; chat: Chat | null; finishing: boolean };
// limit: zeta refused the swap (parked_limit: this tab keeps 3 chats running; resident_limit: zeta is full); parked: this
// tab's parked chats, oldest first (zeta's status order); target: the chat the refused switch opens
type BusyChat = { sessionId: string | null; chat: Chat | null; retry: "attach" | "new"; limit?: "parked" | "resident"; parked?: ParkedChat[]; target?: Chat | null };
/**
 * "stop the oldest parked chat, then the refused swap again" (parked_limit or resident_limit), one at a time:
 * stopping (the stop, then, while the chat is parked again, a wait of up to STOP_WAIT_MS for zeta's "closed"), then retrying until the swap's
 * answer settles it. A switch clears it; a refusal while the stopped chat may still be zeta's (attached, listed, or any
 * resident_limit: zeta counts a closing chat that status does not show) is still_stopping: the chat the user was on
 * opens again and the notice offers "try again" (no automatic retry); working: it is still parked, so it holds work.
 * Another refusal clears it (the notice lists the chats again); failed: the stop itself failed. A user's swap ends the
 * run (see beginSwap). from: the chat the user was on ("stay").
 */
export type StopState = { sessionId: string; from: string | null } & ({ phase: "stopping" } | { phase: "retrying" } | { phase: "still_stopping"; working: boolean } | { phase: "failed"; error: string });
const STOP_WAIT_MS = 30_000;
// the one swap attempt (select a chat, new chat, try again); kept: the chat shown when it began
type Swap = { retry: "attach" | "new"; target: Chat | null; replace: boolean; kept: string | null };
type Refusal = { kind: "busy"; sessionId: string | null } | { kind: "parked"; parked: string[] } | { kind: "resident" };
// a send while a swap is pending stays in the draft: it was meant for the chat being opened, not the kept one
export const SWAP_SEND_OFF = "opening chat… send it once the chat opens";
const tooMany = (caught: unknown) => caught instanceof Error && caught.message === TOO_MANY_CHATS;
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

// marks the chat sent (it joins the chat list) and stores its first-message title once; it never moves the chat in Recent
export function persistFirstMessage(sessionId: string, firstMessage: string, onSuccess: () => void): void {
  void patchChat(sessionId, { first_message: firstMessage })
    .then((response) => { if (response.ok) onSuccess(); })
    .catch((error) => console.error("could not record the first message", error));
}

export async function persistChatTitle(sessionId: string, title: string | null, titledByUser: boolean, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    return (await patchChat(sessionId, { title, titled_by_user: titledByUser }, fetchFn)).ok;
  } catch { return false; }
}

function attachmentError(caught: unknown, context: "loading" | "creation" = "loading", canWrite = true): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (message === "Failed to fetch" || message === "Load failed") return `achilles is unavailable while ${context === "creation" ? "creating the chat" : "loading the chat"}.`;
  // only an observer (zeta was full) reads a chat without resuming it, and zeta refuses that when no tab has the chat open
  if (!canWrite && message.includes("server has no active session")) return "this chat is not open in any tab. take control to open it here.";
  return message.includes("MCP server is not a trusted global server: achilles")
    ? "achilles is not trusted by zeta. add it to $ZETA_HOME/mcp.json, then restart zeta serve."
    : message;
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
// the page binding of a listed chat, as attachPage builds it; null when achilles no longer lists the chat or its page
async function chatBinding(sessionId: string) {
  const chat = await findChat(sessionId);
  if (!chat) return null;
  const loaded = await fetch(`/api/pages/${chat.page_id}`, { cache: "no-store" });
  if (!loaded.ok) return null;
  const page = await loaded.json() as Page;
  const credential = await fetch(`/api/pages/${page.id}/credential`, { cache: "no-store" });
  if (!credential.ok) throw new Error(`could not load page credential (${credential.status})`);
  return pageBinding(((await credential.json()) as { credential: string }).credential, page.workspace);
}
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
  canWrite = false,
  purpose?: ChatCreationInput["purpose"],
  continuing = false,
): Promise<EmptyState | ReadyState | BusyState> {
  let ownsLease = false;
  try {
    // a new connection first takes back the chats this tab kept running before a reload (each attach waits for it)
    if (canWrite) { await reclaimHeld(client, selectedId, chatBinding); requireCurrent(owner, token); }
    const loaded = await fetch(`/api/pages/${key}`, { cache: "no-store" }); requireCurrent(owner, token);
    if (!loaded.ok) throw new Error("page not found");
    const page = await loaded.json() as Page; requireCurrent(owner, token);
    if (!supportsFeature(client, "session_mcp_bindings")) throw new Error("this zeta does not support page tools");
    const credentialResponse = await fetch(`/api/pages/${page.id}/credential`, { cache: "no-store" }); requireCurrent(owner, token);
    if (!credentialResponse.ok) throw new Error(`could not load page credential (${credentialResponse.status})`);
    const credential = ((await credentialResponse.json()) as { credential: string }).credential; requireCurrent(owner, token);
    const creationInput = { client, pageId: page.id, credential, cwd: page.workspace, purpose, mode: creationApprovalMode(page.approval_mode, getSettings().autoApproveDefault) };
    const selectedChat = selectedId ? await findChat(selectedId) : null; requireCurrent(owner, token);
    if (selectedId && selectedChat?.page_id !== page.id) {
      if (continuing) throw new Error(sessionMissing);
      throw new MissingChatError(creationInput, page.route === "/" ? "/" : page.route);
    }
    const serverApprovalMode = page.approval_mode ?? null;

    const observer = !canWrite;

    const attachSession = async (sessionId: string): Promise<ReadyState> => {
      const unresumed = { id: sessionId, name: selectedChat?.title ?? selectedChat?.first_title ?? null, approvalMode: serverApprovalMode, model: null, pending: false, rebind: false, cwd: null };
      // another tab controls this chat: zeta has no handoff, so read it here with no `resume` and no page binding
      let controlledElsewhere = false;
      let session: { id: string; name: string | null; approvalMode?: string | null; model: string | null; pending: boolean; rebind: boolean; cwd: string | null } = unresumed;
      if (!observer) {
        // only a url-named chat can meet its own reload, so only it waits out the reload race; a default attach falls back at once
        try { session = await openHomeSession(client, sessionId, credential, page.workspace, serverApprovalMode, () => owner.current(token), selectedId ? CONTROLLED_RETRIES : 0); }
        // only a chat the url names opens read-only; a default attach held elsewhere is the caller's (it starts a new chat)
        catch (caught) { if (!(caught instanceof SessionControlledError) || !selectedId) throw caught; controlledElsewhere = true; }
      }
      const reader = observer || controlledElsewhere;
      requireCurrent(owner, token);
      const lease = await loadSession(client, session.id, () => owner.current(token));
      const continued = continuing && !reader && owner.current(token);
      if (continued) lease.store.dispatch({ type: "notification", notification_id: continuationNotification, data: { text: `today · continuing session ${session.id}. zeta keeps the full history; new messages append to it.` } });
      if (!owner.accept(token, lease)) throw new StaleAttachment();
      ownsLease = true;
      // An observer reads the true per-session mode and model without resuming the session or writing settings.
      // After the join: zeta answers an observer's session_settings only for a session it joined. zeta answers it for
      // a controller only for the session that controller holds (-32003 otherwise), so a chat held elsewhere shows no model.
      if (observer) {
        const observed = await client.request("session_settings", { session_id: sessionId }).catch(() => null) as { model?: string; approval_mode?: string | null } | null;
        requireCurrent(owner, token);
        session = { ...session, approvalMode: serverApprovalMode === "ask" ? "ask" : observed?.approval_mode ?? serverApprovalMode, model: observed?.model ?? null };
      }
      page.approval_mode = session.approvalMode;
      const storedChat = selectedChat ?? (await findChat(session.id)); requireCurrent(owner, token);
      const userTitled = Boolean(storedChat?.titled_by_user);
      // a chat whose first-message record was lost (a failed PATCH, a closed tab) is repaired from its history
      const historyTitle = storedChat && !userTitled && !(storedChat.message_sent && (storedChat.title || storedChat.first_title)) ? cutTitle(firstUserText(lease.store)) : "";
      if (historyTitle && !reader) persistFirstMessage(session.id, historyTitle, () => {});
      const autoTitle = session.name?.trim() || (userTitled ? "" : storedChat?.title?.trim()) || storedChat?.first_title?.trim() || historyTitle || "new chat";
      const title = userTitled ? (storedChat?.title?.trim() || autoTitle) : autoTitle;
      if (!reader && !userTitled && session.name?.trim() && session.name.trim() !== storedChat?.title?.trim())
        void patchChat(session.id, { title }).catch(() => {});
      return { phase: "ready", page, serverApprovalMode, sessionId: session.id, lease, ...(continued ? { continued: true } as const : {}), credential, pendingApprovalMode: session.pending ? "ask" : null, title, autoTitle, sent: storedChat?.message_sent ?? false, rebind: session.rebind, cwd: session.cwd, model: session.model, ...(controlledElsewhere ? { controlledElsewhere: true } as const : {}) };
    };
    const busy = (busySessionId: string | null, parked?: string[]): BusyState => ({ phase: "busy", page, serverApprovalMode, credential, busySessionId, ...(parked ? { parked } : {}) });

    // An explicit build attachment must not resume a pending ordinary create.
    const creationStatus = canWrite && !continuing && selectedChat?.purpose !== "page_build" ? creation.status(page.id, purpose) : undefined;
    const pending = creationStatus?.pending;
    if (creationStatus?.createMode !== undefined) page.create_mode = creationStatus.createMode;
    // with no chat named, a page opens on its most recent chat (the sidebar's order), then on its home chat (page.zeta_session_id)
    // shortcut: scans the whole chat list for a page with no listed chat; add a page filter to /api/chats if that gets slow
    const newest = forceNew || create || selectedId || pending ? null : await findNewestChat((chat) => chat.page_id === page.id); requireCurrent(owner, token);
    const candidates = forceNew || pending ? [] : selectedId ? [selectedId] : [...new Set([newest?.session_id, page.zeta_session_id])].filter((id): id is string => Boolean(id));
    for (const sessionId of candidates) {
      try { return await attachSession(sessionId); }
      catch (caught) {
        if (caught instanceof ChatBusyError) return busy(caught.sessionId);
        if (caught instanceof ParkedLimitError) return busy(null, caught.parked);
        if (!(caught instanceof SessionNotFoundError)) throw caught;
        if (continuing) throw new Error(sessionMissing);
        if (selectedId) throw new MissingChatError(creationInput, page.route === "/" ? "/" : page.route);
        // only a lost home chat is replaced: the replacement moves page.zeta_session_id. a lost newer chat falls back to home
        if (sessionId === page.zeta_session_id) create = true;
      }
    }
    if (!canWrite || (!pending && !create)) return { phase: "empty", page, serverApprovalMode, credential };

    const mappingInput = forceNew ? creationInput : { ...creationInput, mapExpectedSessionId: page.zeta_session_id };
    try {
      const ready = await creation.ensure({ input: mappingInput, current: () => owner.current(token), attach: attachSession, applyCreateMode, publishReady, create });
      if (!ready) return { phase: "empty", page, serverApprovalMode, credential };
      return ready as ReadyState;
    } catch (caught) {
      // a joined create of an earlier attachment stopped and forgot its record: open this attachment's own choice again.
      // bounded: each re-run follows one stopped create, and a stale attachment can no longer start one
      if (caught instanceof StaleCreation) { if (!owner.current(token)) throw caught; return attachPage(client, key, selectedId, owner, creation, token, create, applyCreateMode, publishReady, forceNew, canWrite, purpose); }
      if (caught instanceof ChatBusyError) return busy(caught.sessionId);
      if (caught instanceof ParkedLimitError) return busy(null, caught.parked);
      if (errorCode(caught) === TURN_RUNNING && !creation.status(page.id, purpose).pending) return busy(await runningSession(client));
      throw new PendingCreationError(caught, mappingInput);
    }
  } catch (caught) {
    if (ownsLease) owner.release(token);
    throw caught;
  }
}

const selectedFromUrl = () => new URLSearchParams(location.search).get("chat");
const keyFromPath = (homeAlias?: string) => location.pathname === "/" || location.pathname === homeAlias ? "home" : location.pathname.slice(1);
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

// zeta (>= 5c517d85) settles every accepted steer as delivered or dropped; one sent while the final reply streams
// starts the next turn. The one automatic resend is a steer its turn ended without reading (see `deliverChatMessage`).
export class DroppedSteerDeliveryError extends Error {}

export const TURN_ENDED_UNREAD = "the turn ended before zeta read it.";
class TurnEndedUnreadError extends SendRefused {}
// drops that mean "the turn ended before zeta read it": `turn_end`, and `disconnect` while this connection still answers
// (zeta found no controller to start the next turn). A stop, a clear, a failed turn, or a restart is never resent.
const UNREAD_DROPS = new Set(["turn_end", "disconnect"]);

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
  dropReason: (deliveryId: string) => Promise<string | undefined>,
): Promise<"send" | "steer"> {
  // the delivery id is the message's intent: a resend with a fresh id takes over its row instead of adding one
  const intent = deliveryId;
  try {
    return await deliverOnce(client, sessionId, text, deliveryId, steer, track, intent);
  } catch (error) {
    if (error instanceof DroppedSteerDeliveryError && UNREAD_DROPS.has(await dropReason(deliveryId) ?? "")) return await sendUnreadSteer(client, sessionId, text, track, intent);
    const outcome = classify(error);
    if (outcome === "sent") return steer ? "steer" : "send";
    if (outcome !== "resend") throw outcome === "maybe" ? new Error(MAYBE_SENT) : refusal(error);
  }
  try {
    return await deliverOnce(client, sessionId, text, crypto.randomUUID(), steer, track, intent);
  } catch (error) {
    // the one resend: zeta's answer is shown and nothing goes out again by itself
    throw classify(error) === "rethrow" || error instanceof DroppedDuplicateError ? refusal(error) : new Error(MAYBE_SENT);
  }
}

// a dropped steer was never read, so zeta holds nothing: one `send` with a fresh id starts the turn that carries it.
// If zeta refuses (another turn already started), the row stays unsent with the true reason and its retry.
async function sendUnreadSteer(client: Pick<ZetaClient, "request">, sessionId: string, text: string, track: (id: string) => void, intent: string): Promise<"send"> {
  const deliveryId = crypto.randomUUID();
  track(deliveryId);
  try {
    accepted(await client.request("send", { session_id: sessionId, text, delivery_id: deliveryId }, { intent }));
    return "send";
  } catch (error) {
    if (classify(error) !== "rethrow") throw new Error(MAYBE_SENT);
    if (errorCode(error) === TURN_RUNNING) throw new TurnEndedUnreadError(TURN_ENDED_UNREAD, { cause: error });
    throw refusal(error);
  }
}

// zeta names a drop's reason only in its live `delivery_status` event, which the poll's answer can overtake: wait briefly
export function steerDropReason(store: SessionLease["store"], deliveryId: string, waitMs = 1_000): Promise<string | undefined> {
  const read = () => {
    for (const { id } of store.getState().outline) {
      const item = store.getItem(id);
      if (item?.type === "user" && item.event.type === "user_message" && item.event.delivery_id === deliveryId) return item.event.delivery_reason;
    }
  };
  return new Promise((resolve) => {
    const known = read();
    if (known !== undefined) return resolve(known);
    const done = (reason: string | undefined) => { clearTimeout(timer); unsubscribe(); resolve(reason); };
    const timer = setTimeout(() => done(undefined), waitMs);
    const unsubscribe = store.subscribe(() => { const reason = read(); if (reason !== undefined) done(reason); });
  });
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
  intent: string,
): Promise<"send" | "steer"> {
  const first: "send" | "steer" = steer ? "steer" : "send";
  let used = first;
  // tracked before the request: zeta echoes an accepted message before it answers
  track(deliveryId);
  try {
    accepted(await client.request(first, { session_id: sessionId, text, delivery_id: deliveryId }, { intent }));
  } catch (error) {
    if (error instanceof DroppedDuplicateError) throw error;
    // zeta serve-protocol: "A `send` that arrives right after `turn_end` either starts the turn that carries the steer,
    // or gets `-32004` because that turn has already started; the client should then retry the text as a `steer`."
    // A refused request records no delivery ID, so the one retry reuses it; a second refusal is shown, not retried.
    if (errorCode(error) !== (steer ? NO_TURN : TURN_RUNNING)) throw error;
    used = steer ? "send" : "steer";
    accepted(await client.request(used, { session_id: sessionId, text, delivery_id: deliveryId }, { intent }));
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
  const tracked: string[] = [];
  try {
    return await send((id) => { tracked.push(id); add(id); });
  } finally {
    for (const id of tracked) remove(id);
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

type ActiveResult =
  | { kind: "state"; update: State | ((current: State) => State) }
  | { kind: "snapshot"; state: EmptyState | ReadyState | BusyState; readAt: number }
  | { kind: "busy"; busy: BusyChat }
  | { kind: "rename"; sessionId: string; request: number; title: string | null };

export function useActiveChat(client: ZetaClient | null, connected: boolean, clock: AttachmentClock = attachmentClock, canWrite = false, homeAlias?: string, createPath?: string) {
  const [selectedId, setSelectedId] = useState(selectedFromUrl);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attachSlow, setAttachSlow] = useState(false);
  const [creationPageId, setCreationPageId] = useState<string | null>(null);
  // "new chat" is creating a chat: the page keeps its header and a read-only composer, and the pane says "creating chat…"
  const chatStart = useRef<"new" | "build" | null>(null);
  const [startingChat, setStartingChat] = useState<typeof chatStart.current>(null);
  const startChat = useCallback(async (kind: NonNullable<typeof chatStart.current>, start: () => Promise<void>) => {
    if (chatStart.current) return;
    chatStart.current = kind;
    setStartingChat(kind);
    try { await start(); }
    finally { chatStart.current = null; setStartingChat(null); }
  }, []);
  const [buildDraft, setBuildDraft] = useState("");
  const [buildError, setBuildError] = useState<string | null>(null);
  const buildTarget = useRef<{ ready: ReadyState; token: number; deliveryId?: string } | null>(null);
  // "retry creating chat" re-runs the attach: the failed-create screen and its header stay until the retry settles
  const retryingCreation = useRef(false);
  const [listRefresh, setListRefresh] = useState(0);
  const [approvalChange, setApprovalChange] = useState<{ pending: boolean; error?: string } | null>(null);
  const approvalRequest = useRef<number | null>(null);
  const authority = useRef(canWrite);
  authority.current = canWrite;
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
  const createAfterLoad = useRef(location.hash === newChatIntent);
  // set when zeta refused a new chat (its `replace`): "try again" must make the new chat, not attach the page's newest
  const refusedCreate = useRef<boolean | null>(null);
  const { autoApproveDefault } = useSettings();
  const pendingSelection = useRef<{ sessionId: string; sawRunning: boolean } | null>(null);
  const [busy, setBusy] = useState<BusyChat | null>(null);
  const [stop, setStopState] = useState<StopState | null>(null);
  const stopRef = useRef<StopState | null>(null);
  const setStop = useCallback((next: StopState | null) => { stopRef.current = next; setStopState(next); }, []);
  const titleClock = useRef(0);
  const renamed = useRef(new Map<string, { request: number; committedAt: number; title: string | null }>());
  const lastSnapshot = useRef<{ token: number; ready: ReadyState } | null>(null);
  const applyActive = useCallback((token: number, result: ActiveResult) => {
    if (result.kind === "rename") {
      const { sessionId, request, title } = result;
      if ((renamed.current.get(sessionId)?.request ?? 0) > request) return false;
      // The save belongs to this chat even if the user moved; a ready snapshot already in flight must see it.
      renamed.current.set(sessionId, { request, committedAt: ++titleClock.current, title });
    }
    if (!owner.current.current(token)) return false;
    switch (result.kind) {
      case "state": setState(result.update); break;
      case "busy": setBusy(result.busy); break;
      case "rename":
        setState((value) => value.phase === "ready" && value.sessionId === result.sessionId
          ? { ...value, title: result.title ?? value.autoTitle } : value);
        break;
      case "snapshot": {
        let next = result.state;
        if (next.phase === "ready") {
          if (lastSnapshot.current?.token === token && lastSnapshot.current.ready === next) return false;
          lastSnapshot.current = { token, ready: next };
          const edit = renamed.current.get(next.sessionId);
          if (edit && edit.committedAt > result.readAt) next = { ...next, title: edit.title ?? next.autoTitle };
        }
        setState(next.phase === "busy" ? next : shownCreateMode(modeToggle.current, next));
        // a stop's repeated swap landed: its run and its notice end
        if (next.phase === "ready" && stopRef.current?.phase === "retrying") { setStop(null); setBusy(null); }
        break;
      }
    }
    return true;
  }, [setStop]);
  // the too-many-chats screen stays while a stop's repeated swap runs (its notice still says "stopping …")
  const stopRetryView = (current: State) => current.phase === "error" && current.error === TOO_MANY_CHATS && stopRef.current?.phase === "retrying";
  // the /#new-chat path: this tab opens the page fresh and creates a chat once the page loads
  const openFresh = useCallback((route: string, replace: boolean) => {
    createAfterLoad.current = true;
    owner.current.clear();
    if (replace) history.replaceState({}, "", route + newChatIntent); else history.pushState({}, "", route + newChatIntent);
    applyActive(owner.current.token(), { kind: "state", update: (current) => stopRetryView(current) ? current : { phase: "loading" } });
    setSelectedId(null);
    setRouteRefresh((value) => value + 1);
  }, [applyActive]);

  // the answer to a swap repeated after a stop (see StopState): still_stopping while the stopped chat is still zeta's (attached, or listed)
  const settleStop = useCallback((attached: string | null, listed: readonly string[], resident: boolean) => {
    const run = stopRef.current;
    if (run?.phase !== "retrying") return;
    const still = resident || attached === run.sessionId || listed.includes(run.sessionId);
    // zeta keeps a chat parked only while it holds work (a turn, an approval, a background agent or task)
    const working = parkedRows(client).some((row) => row.session_id === run.sessionId);
    setStop(still ? { sessionId: run.sessionId, from: run.from, phase: "still_stopping", working } : null);
  }, [client, setStop]);
  // a stop's repeated swap that ends in an error: resident_limit asks whether the stopped chat is still zeta's; any other ends the run
  const stopRetryFailed = useCallback((resident: boolean) => {
    if (!client || stopRef.current?.phase !== "retrying") return;
    if (!resident) return setStop(null);
    void refreshParked(client).catch(() => null).then((attached) => { if (stopRef.current?.phase === "retrying") settleStop(attached, parkedRows(client).map((row) => row.session_id), true); });
  }, [client, setStop, settleStop]);

  // The one owner of a swap attempt (select a chat, new chat, try again, stay): the shown chat, its composer and draft
  // stay until zeta answers. A switch then takes the url (pushed once, so Back works); a refusal leaves the url and the
  // sidebar as they were and shows its notice above the kept chat.
  const swap = useRef<Swap | null>(null);
  // a swap with a chat on screen is pending: that chat's composer takes typing but never sends (a send meant for the
  // chat the user is opening must not reach the kept one); a refusal or a landing ends it
  const [swapping, setSwapping] = useState(false);
  const setSwap = useCallback((next: Swap | null) => { swap.current = next; setSwapping(Boolean(next?.kept)); }, []);
  // a user's swap (select a chat, new chat, Back) ends any stop run and clears the notice
  const leaveNotice = useCallback(() => { setBusy(null); setStop(null); }, [setStop]);
  const beginSwap = useCallback((token: number, attempt: Omit<Swap, "kept">, fallback: State) => {
    setSwap({ ...attempt, kept: state.phase === "ready" ? state.sessionId : null });
    // a stop's own repeated swap keeps its run and notice ("stopping …") until zeta answers
    if (stopRef.current?.phase !== "retrying") leaveNotice();
    applyActive(token, { kind: "state", update: (current) => current.phase === "ready" ? current : fallback });
  }, [applyActive, leaveNotice, setSwap, state]);
  const refused = useCallback(async (token: number, retry: BusyChat["retry"], refusal: Refusal) => {
    const attempt = swap.current?.retry === retry ? swap.current : null;
    if (attempt) setSwap(null);
    if (refusal.kind === "busy") {
      const chat = refusal.sessionId ? await findChat(refusal.sessionId).catch(() => null) : null;
      if (!owner.current.current(token)) return;
      applyActive(token, { kind: "busy", busy: { sessionId: refusal.sessionId, chat, retry } });
    } else {
      const attached = client ? await refreshParked(client).catch(() => null) : null;
      // status lists the parked chats oldest first; a parked_limit refusal's list has no set order and adds the closing ones
      const rows = parkedRows(client).map((row) => row.session_id);
      const listed = refusal.kind === "parked" ? refusal.parked : rows;
      const order = [...rows.filter((id) => listed.includes(id)), ...listed.filter((id) => !rows.includes(id))];
      const targetId = attempt ? null : retry === "attach" ? selectedFromUrl() : null;
      const [target, ...chats] = await Promise.all([targetId ? findChat(targetId).catch(() => null) : attempt?.target ?? null, ...order.map((id) => findChat(id).catch(() => null))]);
      if (!owner.current.current(token)) return;
      settleStop(attached, order, refusal.kind === "resident");
      applyActive(token, { kind: "busy", busy: { sessionId: null, chat: null, retry, limit: refusal.kind, target, parked: order.map((id, at) => ({ sessionId: id, chat: chats[at] ?? null, finishing: !rows.includes(id) })) } });
    }
    // the kept chat stays on screen; its lease went with the attempt (and a stop may have left zeta another chat
    // attached), so it is opened again: zeta takes back its own parked chat, never refused
    if (attempt?.kept) { setSelectedId(attempt.kept); setRouteRefresh((value) => value + 1); }
  }, [applyActive, client, setSwap, settleStop]);

  const applyPendingCreateMode = useCallback(async (ready: ReadyState, enabled: boolean) => {
    if (!client) throw new Error("zeta is not connected");
    const result = await modeToggle.current.run({ client, pageId: ready.page.id, sessionId: ready.sessionId, enabled });
    // A failed tool refresh keeps the new chat: the inline notice offers retry instead of a full-page error.
    if (result.blocked && modeToggle.current.stale()?.sessionId === ready.sessionId) { setToggleError(result.error); setToggleBlocked(true); setToggleRetryable(result.retryable); }
    return { ...ready, page: { ...ready.page, create_mode: result.createMode ?? !enabled } };
  }, [client]);

  const attachedSelection = useRef<string | null>(null);
  // select "attached": the chat is attached under its own attempt (new chat), so the attach effect skips the selection
  const publishReady = useCallback((ready: ReadyState, token: number, readAt: number, replace = false, focus = false, select: boolean | "attached" = true) => {
    requireCurrent(owner.current, token);
    if (!applyActive(token, { kind: "snapshot", state: ready, readAt })) return;
    missingCreation.current = null;
    setCreationPageId(ready.page.id);
    setListRefresh((value) => value + 1);
    const route = routeWithChat(ready.page.route === "/" ? "/" : ready.page.route, ready.sessionId);
    if (replace) history.replaceState({}, "", route); else history.pushState({}, "", route);
    if (focus) setFocusSessionId(ready.sessionId);
    // one resume per new chat: the attach effect skips the selection it causes
    if (select) setSelectedId((current) => { if (select === "attached" && current !== ready.sessionId) attachedSelection.current = ready.sessionId; return ready.sessionId; });
  }, [applyActive]);

  useEffect(() => {
    // read before the offline return: a retry clicked while offline must not stay set for a later, unrelated attach
    const retrying = retryingCreation.current; retryingCreation.current = false;
    refusedCreate.current = null;
    const justPublished = attachedSelection.current; attachedSelection.current = null;
    if (!client || !connected) return;
    if (justPublished !== null && justPublished === selectedId && lastSnapshot.current?.ready.sessionId === selectedId) return;
    const landing = location.pathname === createPath;
    const continuing = !landing && !!selectedId && location.hash === continueChatIntent;
    const startFresh = !landing && createAfterLoad.current && location.hash === newChatIntent;
    const key = landing ? "home" : keyFromPath(homeAlias);
    const token = owner.current.begin(`${key}:${landing ? "build" : selectedId ?? "default"}`, true);
    const readAt = titleClock.current;
    // Selecting a chat whose tool refresh failed re-attaches it; its retry notice stays until a refresh succeeds.
    setApprovalChange(null);
    const stale = modeToggle.current.stale();
    const keepStale = stale?.idle && stale.sessionId === selectedId ? stale : null;
    if (!keepStale) { modeToggle.current.reset(); setToggleError(null); setToggling(false); setToggleBlocked(false); setToggleRetryable(false); }
    if (!retrying) setCreationPageId(null);
    setAttachSlow(false);
    applyActive(token, { kind: "state", update: (current) => current.phase === "ready" || (retrying && current.phase === "empty") || stopRetryView(current) ? current : { phase: "loading" } });
    const slowTimer = clock.setTimeout(() => { if (owner.current.current(token)) setAttachSlow(true); }, ATTACH_SLOW_MS);
    // the url is the tab's chat: a default attach wrote ?chat= without selecting it, and a reconnect must reattach that chat
    void attachPage(client, key, landing || startFresh ? null : selectedId ?? selectedFromUrl(), owner.current, creation.current, token, false, !landing && canWrite ? applyPendingCreateMode : undefined, async (next) => {
      if (!owner.current.current(token)) throw new StaleAttachment();
      if (creation.current.status(next.page.id).pending) publishReady(next, token, readAt);
      else applyActive(token, { kind: "snapshot", state: next, readAt });
    }, landing || startFresh, !landing && !startFresh && canWrite, undefined, continuing).then((next) => {
      if (!owner.current.current(token)) return;
      // a switch landed: it takes the url now (a refused one never touched it)
      const attempt = swap.current;
      if (next.phase === "ready" && attempt?.retry === "attach" && attempt.target?.session_id === next.sessionId) {
        setSwap(null);
        const url = routeWithChat(location.pathname, next.sessionId);
        if (attempt.replace) history.replaceState({}, "", url); else history.pushState({}, "", url);
      }
      if (next.phase === "ready" && next.continued && location.hash === continueChatIntent) {
        history.replaceState(history.state, "", location.pathname + location.search);
        setFocusSessionId(next.sessionId);
      }
      // name the default chat in the url, so a reload reclaims this tab's chat instead of the page's newest one
      if (next.phase === "ready" && !landing && !selectedFromUrl()) history.replaceState(history.state, "", routeWithChat(location.pathname, next.sessionId));
      setCreationPageId(next.page.id);
      if (next.phase === "busy") void refused(token, "attach", next.parked ? { kind: "parked", parked: next.parked } : { kind: "busy", sessionId: next.busySessionId });
      // a refused switch keeps the chat on screen (header, transcript, composer) under the notice
      applyActive(token, next.phase === "busy" ? { kind: "state", update: (current) => current.phase === "ready" ? current : next } : { kind: "snapshot", state: next, readAt });
    }).catch((caught) => {
      if (caught instanceof StaleAttachment || !owner.current.current(token)) return;
      // zeta is full: a switch keeps the shown chat under the notice
      if (tooMany(caught) && swap.current?.retry === "attach" && swap.current.kept) return void refused(token, "attach", { kind: "resident" });
      // the screen shows this attach's error: the url names its chat, so a reload opens the same one
      const attempt = swap.current;
      setSwap(null);
      if (attempt?.retry === "attach" && attempt.target) {
        const url = routeWithChat(location.pathname, attempt.target.session_id);
        if (attempt.replace) history.replaceState({}, "", url); else history.pushState({}, "", url);
      }
      stopRetryFailed(tooMany(caught));
      if (caught instanceof PendingCreationError && owner.current.current(token)) {
        setCreationPageId(caught.input.pageId);
      } else if (caught instanceof MissingChatError && owner.current.current(token)) {
        missingCreation.current = { input: caught.input, route: caught.route };
        applyActive(token, { kind: "state", update: { phase: "missing" } });
      } else if (caught instanceof SessionControlledError && canWrite && !selectedId && !selectedFromUrl() && owner.current.current(token)) {
        // a default attach met the page's newest chat open in another tab: this tab gets its own new chat instead
        openFresh(location.pathname, true);
      } else if (!(caught instanceof StaleAttachment) && owner.current.current(token)) applyActive(token, { kind: "state", update: { phase: "error", error: attachmentError(caught, "loading", canWrite) } });
    }).finally(() => {
      clock.clearTimeout(slowTimer);
      if (owner.current.current(token)) setAttachSlow(false);
    });
    return () => { clock.clearTimeout(slowTimer); owner.current.clear(token); };
  }, [applyActive, applyPendingCreateMode, canWrite, client, clock, connected, createPath, homeAlias, openFresh, publishReady, refused, routeRefresh, selectedId, stopRetryFailed]);

  useEffect(() => {
    const pop = () => { setSwap(null); leaveNotice(); owner.current.clear(); applyActive(owner.current.token(), { kind: "state", update: { phase: "loading" } }); setSelectedId(selectedFromUrl()); setRouteRefresh((value) => value + 1); };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, [applyActive, leaveNotice, setSwap]);
  useEffect(() => () => owner.current.clear(), []);

  // replace: the chat takes the current history entry. goTo keeps a stop run (its repeated swap); a choice of the user
  // (selectChat) ends it
  const goTo = useCallback((chat: Chat, replace = false) => {
    if (stopRef.current?.phase !== "retrying") setBusy(null);
    createAfterLoad.current = false;
    const route = chat.page_route === "/" ? "/" : chat.page_route;
    const target = routeWithChat(route, chat.session_id);
    if (route !== location.pathname) { if (replace) location.replace(target); else location.assign(target); return; }
    // the chat named in the url but not shown (an error screen): open it again
    if (chat.session_id === selectedId) {
      if (state.phase !== "ready") {
        if (`${location.pathname}${location.search}` !== target) { if (replace) history.replaceState({}, "", target); else history.pushState({}, "", target); }
        setRouteRefresh((value) => value + 1);
      }
      return;
    }
    const token = owner.current.begin(`${keyFromPath(homeAlias)}:${chat.session_id}`);
    beginSwap(token, { retry: "attach", target: chat, replace }, { phase: "loading" });
    setFocusSessionId(null);
    setSelectedId(chat.session_id);
  }, [beginSwap, homeAlias, selectedId, state.phase]);
  const selectChat = useCallback((chat: Chat, replace = false) => { setStop(null); goTo(chat, replace); }, [goTo, setStop]);

  const continueWaitingChat = useCallback(async () => {
    if (!canWrite) return;
    const waiting = await findNewestChat((chat) => chat.last_state === "approval" && chat.purpose !== "page_build");
    if (waiting) selectChat(waiting);
  }, [canWrite, selectChat]);

  // replace: the create belongs to a /#new-chat entry already in history, so its chat takes that entry and Back leaves
  const createChat = useCallback((replace: boolean) => startChat("new", async () => {
    if (!canWrite || !client) return;
    const context = state.phase === "ready" || state.phase === "empty" || state.phase === "busy"
      ? { route: state.page.route, pageId: state.page.id }
      : state.phase === "missing" && missingCreation.current ? { route: missingCreation.current.route, pageId: missingCreation.current.input.pageId } : null;
    // still loading: create once the page loads. an error: open the page fresh. either way "new chat" never does nothing
    if (!context && state.phase === "loading") { createAfterLoad.current = true; return; }
    if (!context) return openFresh(state.phase === "error" && state.error === "page not found" ? "/" : location.pathname, false);
    const key = context.route === "/" ? "home" : context.route.slice(1);
    const token = owner.current.begin(`new:${key}`, true);
    const readAt = titleClock.current;
    setApprovalChange(null);
    const focusClaim = claimComposerFocus();
    // a shown chat stays while the chat is created (see beginSwap); else the page shows its new-chat box (it can wait for an
    // earlier create of the page)
    beginSwap(token, { retry: "new", target: null, replace }, state.phase !== "empty" && state.phase !== "busy" ? { phase: "loading" } : { phase: "empty", page: state.page, serverApprovalMode: state.serverApprovalMode, credential: state.credential, newChat: true });
    const kept = swap.current?.kept;
    try {
      const next = await attachPage(client, key, null, owner.current, creation.current, token, true, canWrite ? applyPendingCreateMode : undefined, (ready) => publishReady(ready, token, readAt, replace, focusClaim.owns(), "attached"), true, canWrite);
      if (swap.current?.retry === "new" && next.phase === "ready") setSwap(null);
      // zeta refused the new chat: say why. with no chat shown, the new chat's box stays; text typed there was written
      // for a new chat, so it must never go to the running chat
      if (next.phase === "busy" && owner.current.current(token)) {
        void refused(token, "new", next.parked ? { kind: "parked", parked: next.parked } : { kind: "busy", sessionId: next.busySessionId });
        if (!kept) {
          // the address names no chat while the new chat's box shows (a reload opens the page's latest chat and its unsent note)
          if (new URLSearchParams(location.search).has("chat")) { const url = new URL(location.href); url.searchParams.delete("chat"); history.pushState({}, "", `${url.pathname}${url.search}`); }
          applyActive(token, { kind: "state", update: { phase: "empty", page: next.page, serverApprovalMode: next.serverApprovalMode, credential: next.credential, newChat: true } });
        }
      }
    } catch (caught) {
      if (!owner.current.current(token)) return;
      if (kept && tooMany(caught)) return void refused(token, "new", { kind: "resident" });
      if (swap.current?.retry === "new") setSwap(null);
      stopRetryFailed(tooMany(caught));
      if (!creation.current.status(context.pageId).pending && applyActive(token, { kind: "state", update: { phase: "error", error: attachmentError(caught, "creation") } })) refusedCreate.current = replace;
    } finally {
      focusClaim.release();
    }
  }), [applyActive, applyPendingCreateMode, beginSwap, canWrite, client, openFresh, publishReady, refused, startChat, state, stopRetryFailed]);
  const newChat = useCallback(() => createChat(false), [createChat]);

  // the unsent-rows notice: show the page's new-chat box with its rows; the chat is made only when one of them is sent
  const openNewChat = useCallback(() => {
    if (state.phase !== "ready") return;
    const token = owner.current.begin(`new:${state.page.route === "/" ? "home" : state.page.route.slice(1)}`, true);
    applyActive(token, { kind: "state", update: { phase: "empty", page: state.page, serverApprovalMode: state.serverApprovalMode, credential: state.credential, newChat: true } });
  }, [applyActive, state]);

  const retrySaving = useCallback(() => { if (!canWrite) return; retryingCreation.current = true; setRouteRefresh((value) => value + 1); }, [canWrite]);
  const retryAttachment = useCallback(() => {
    // the attach again replaces any pending swap (its token is dropped): the kept chat's composer is no longer held
    setSwap(null);
    owner.current.clear();
    setAttachSlow(false);
    setRouteRefresh((value) => value + 1);
  }, [setSwap]);
  // "try again" on the too-many-chats screen repeats what failed: the new chat, or the attach of the url's chat
  const retryLimit = useCallback(() => {
    const replace = refusedCreate.current;
    if (replace !== null && canWrite) openFresh(location.pathname, replace); else retryAttachment();
  }, [canWrite, openFresh, retryAttachment]);
  // a create that keeps failing is never a dead end: drop it and open the page again (its empty state keeps the new-chat draft)
  const discardCreation = useCallback(() => {
    if (!canWrite) return;
    if (creationPageId) creation.current.discard(creationPageId);
    retryAttachment();
  }, [canWrite, creationPageId, retryAttachment]);
  // the refused swap again: the new chat, or the chat the refused switch opens (the shown chat stayed)
  const retryBusy = useCallback(() => {
    if (!canWrite) return;
    const retry = busy?.retry, target = busy?.target;
    if (stopRef.current?.phase !== "retrying") setBusy(null);
    if (retry === "new") void newChat(); else if (target) goTo(target); else retryAttachment();
  }, [busy, canWrite, goTo, newChat, retryAttachment]);
  const openBusyChat = useCallback(() => { if (busy?.chat) selectChat(busy.chat); }, [busy, selectChat]);
  // "stay" after a refused swap: the shown chat stayed (and zeta has it back: `refused` opened it again). with none shown
  // (zeta was full), open the chat the user was on before a stop, else the chat zeta has attached (after a reload too)
  const stay = useCallback(async () => {
    const from = stopRef.current?.from ?? null;
    setBusy(null);
    setStop(null);
    if (!client || state.phase === "ready") return;
    const status = from ? null : await client.request("status", {}).catch(() => null) as { session?: { session_id?: unknown } | null } | null;
    const id = from ?? status?.session?.session_id;
    const chat = typeof id === "string" ? await findChat(id).catch(() => null) : null;
    if (chat) selectChat(chat, true);
  }, [client, selectChat, setStop, state.phase]);
  // the one owner of "stop the oldest parked chat and try again" (both notices; see StopState). the oldest is the first
  // of zeta's status order. a second click while one runs does nothing; there is no automatic loop
  const repeatSwap = useCallback(() => { if (busy?.limit) retryBusy(); else retryLimit(); }, [busy, retryBusy, retryLimit]);
  const stopAndRetry = useCallback(async () => {
    const oldest = client ? parkedRows(client)[0]?.session_id : undefined;
    const running = stopRef.current?.phase;
    if (!client || !canWrite || !oldest || running === "stopping" || running === "retrying") return;
    const token = owner.current.token();
    // the chat the user is on: the shown one, else (zeta was full) the one zeta has attached before the stop
    const shownId = state.phase === "ready" ? state.sessionId : null;
    const started: StopState = { sessionId: oldest, from: shownId, phase: "stopping" };
    setStop(started);
    // false when the user moved on (the stop checks the attachment before each step): the run ends without a word
    const stillMine = () => { if (stopRef.current !== started) return false; if (owner.current.current(token)) return true; setStop(null); return false; };
    const from = shownId ?? await refreshParked(client).catch(() => null);
    const closed = watchClosed(client, oldest, clock);
    try { await stopParked(client, oldest, chatBinding, () => owner.current.current(token), from); }
    catch (caught) {
      closed.stop();
      if (!stillMine()) return;
      const title = await findChat(oldest).then((chat) => chat ? `"${titleOf(chat)}"` : "the chat", () => "the chat");
      if (stillMine()) setStop({ sessionId: oldest, from, phase: "failed", error: `could not stop ${title}: ${caught instanceof Error ? caught.message : String(caught)}` });
      return;
    }
    // the chat still holds work, so zeta parked it again: its "closed" comes once its work ended and its slot is free.
    // a chat that closed at once was never parked again and gets no event; the swap again, once
    if (parkedRows(client).some((row) => row.session_id === oldest) && stillMine()) await closed.wait(STOP_WAIT_MS);
    closed.stop();
    if (!stillMine()) return;
    setStop({ sessionId: oldest, from, phase: "retrying" });
    repeatSwap();
  }, [canWrite, client, clock, repeatSwap, setStop, state]);
  // "try again" while the stopped chat is still stopping: the swap again, answered as that stop's retry
  const retryStopped = useCallback(() => {
    const run = stopRef.current;
    if (run?.phase !== "still_stopping") return;
    setStop({ sessionId: run.sessionId, from: run.from, phase: "retrying" });
    repeatSwap();
  }, [repeatSwap, setStop]);
  useEffect(() => {
    if (!canWrite || !createAfterLoad.current) return;
    // "new chat" clicked while a missing page loaded: make the chat on home instead
    if (state.phase === "error" && state.error === "page not found") return openFresh("/", false);
    if (state.phase === "loading") return;
    createAfterLoad.current = false;
    // missing, busy or another error: drop the click, so a later ready state never creates a chat nobody asked for
    if (state.phase !== "ready" && state.phase !== "empty") return;
    const replace = location.hash === newChatIntent;
    if (replace) history.replaceState({}, "", location.pathname + location.search);
    void createChat(replace);
  }, [canWrite, createChat, openFresh, state]);

  const updateReady = useCallback((token: number, update: (current: ReadyState) => ReadyState) => {
    applyActive(token, { kind: "state", update: (current) => current.phase === "ready" ? update(current) : current });
  }, [applyActive]);

  const createFirstChat = useCallback(async (empty: EmptyState, token: number, text: string) => {
    if (!client) throw new Error("zeta is not connected");
    const readAt = titleClock.current;
    const focusClaim = claimComposerFocus();
    setCreationPageId(empty.page.id);
    try {
      let handedOff = null as ReadyState | null;
      const attached = await attachPage(
        client,
        keyFromPath(homeAlias),
        null,
        owner.current,
        creation.current,
        token,
        true,
        canWrite ? applyPendingCreateMode : undefined,
        async (ready) => { handedOff = ready; },
        empty.newChat,
        canWrite,
      );
      if (attached.phase === "busy") { void refused(token, empty.newChat ? "new" : "attach", attached.parked ? { kind: "parked", parked: attached.parked } : { kind: "busy", sessionId: attached.busySessionId }); throw attached.parked ? new ParkedLimitError(attached.parked) : new ChatBusyError(attached.busySessionId); }
      if (attached.phase !== "ready" || handedOff !== attached) throw new Error("created chat did not attach");
      if (modeToggle.current.stale()?.sessionId === attached.sessionId) { // clear the composer draft only when it was the sent text; a starter button must not erase typed text
        draftStore.set(attached.sessionId, text); if (draftStore.get(`new:${empty.page.id}`) === text) draftStore.set(`new:${empty.page.id}`, ""); }
      publishReady(attached, token, readAt, true, focusClaim.owns(), false);
      return attached;
    } finally {
      focusClaim.release();
    }
  }, [applyPendingCreateMode, client, homeAlias, publishReady, refused]);

  // the open chat's work for when zeta is idle (re-send the page binding, apply a pending mode); see createTurnEndOwner
  const turnEnd = useRef<ReturnType<typeof createTurnEndOwner> | null>(null);
  const ready = state.phase === "ready" ? state : null;
  const workSessionId = ready && (ready.rebind || ready.pendingApprovalMode) ? ready.sessionId : null;
  useEffect(() => {
    if (!canWrite || !client || !ready || !workSessionId) return;
    const token = owner.current.token();
    const turn = createTurnEndOwner({
      client, sessionId: ready.sessionId, binding: pageBinding(ready.credential, ready.page.workspace), clock,
      work: { rebind: ready.rebind, approvalMode: ready.pendingApprovalMode },
      settled: (update) => {
        if (!owner.current.current(token)) return;
        updateReady(token, (value) => value.sessionId !== ready.sessionId ? value
          : "rebind" in update ? { ...value, rebind: false }
          : { ...value, page: { ...value.page, approval_mode: update.approvalMode }, pendingApprovalMode: update.pendingApprovalMode });
        if (!("rebind" in update) && !update.pendingApprovalMode) {
          setApprovalChange((change) => change?.pending ? { pending: false } : change);
        }
      },
      failed: (caught) => {
        if (!owner.current.current(token)) return;
        if (ready.rebind || ready.serverApprovalMode === "ask") applyActive(token, { kind: "state", update: { phase: "error", error: attachmentError(caught) } });
        else {
          updateReady(token, (value) => ({ ...value, pendingApprovalMode: null }));
          setApprovalChange({ pending: false, error: "could not change tool approval; try again" });
        }
      },
    });
    turnEnd.current = turn;
    return () => { turn.dispose(); if (turnEnd.current === turn) turnEnd.current = null; };
  }, [applyActive, canWrite, client, workSessionId, ready?.lease, ready?.rebind, ready?.pendingApprovalMode]); // a new attach (lease) gets a new owner and token

  const sendReady = useCallback(async (client: ZetaClient, target: ReadyState, token: number, text: string, deliveryId: string, steer: boolean, track: (id: string) => void) => {
    requireCurrent(owner.current, token);
    try {
      await deliverChatMessage(client, target.sessionId, text, deliveryId, steer, track, (id) => steerDropReason(target.lease.store, id));
    } catch (error) {
      if (pendingSelection.current?.sessionId === target.sessionId) pendingSelection.current = null;
      // the bubble says why too: zeta may have named the drop `disconnect` although this connection still answers
      if (error instanceof TurnEndedUnreadError) target.lease.store.dispatch({ type: "delivery_status", delivery_id: deliveryId, method: "steer", status: "dropped", content: "", reason: "turn_end" });
      throw error;
    }
    // not gated on the owner token: a chat switch mid-send must still record the send. each user send (a message or a
    // steer) moves the chat to the top of Recent; the first one also marks it sent and keeps its title
    const firstTitle = target.sent ? null : cutTitle(text);
    void patchChat(target.sessionId, firstTitle === null ? { message: true } : { message: true, first_message: firstTitle })
      .then((response) => {
        if (!response.ok || firstTitle === null) return;
        updateReady(token, (value) => value.sessionId !== target.sessionId ? value : {
          ...value, sent: true,
          autoTitle: value.autoTitle === "new chat" ? firstTitle : value.autoTitle,
          title: value.title === "new chat" ? firstTitle : value.title,
        });
      })
      .catch((error) => console.error("could not record the message", error));
  }, [updateReady]);

  const send = useCallback(async (text: string, intent: SendIntent, track: (id: string) => void) => {
    if (!canWrite) throw new Error("this tab is read-only; take control to make changes");
    if (!client || (state.phase !== "ready" && state.phase !== "empty")) throw new Error("zeta is not connected");
    if (swap.current?.kept && state.phase === "ready" && state.sessionId === swap.current.kept) throw new Error(SWAP_SEND_OFF);
    await modeToggle.current.beforeSend();
    const token = owner.current.token();
    const steer = pageDeliverySteer(state.phase, intent);
    if (state.phase === "ready") await turnEnd.current?.settle();
    const current = state.phase === "ready" ? state : await createFirstChat(state, token, text);
    if (state.phase === "empty") await modeToggle.current.beforeSend();
    const delivery_id = intent.deliveryId ?? crypto.randomUUID();
    if (state.phase === "empty") pendingSelection.current = { sessionId: current.sessionId, sawRunning: false };
    await sendReady(client, current, token, text, delivery_id, steer, track);
  }, [canWrite, client, createFirstChat, sendReady, state]);

  const setPendingCreateMode = useCallback((current: EmptyState, enabled: boolean) => {
    creation.current.setCreateMode(current.page.id, enabled);
    setCreationPageId(current.page.id);
    applyActive(owner.current.token(), { kind: "state", update: { ...current, page: { ...current.page, create_mode: enabled } } });
  }, [applyActive]);

  const toggleReady = useCallback(async (current: ReadyState, token: number, enabled: boolean) => {
    if (!client) return;
    setToggling(true); // a shown refresh notice stays until the retry settles
    const result = await modeToggle.current.run({ client, pageId: current.page.id, sessionId: current.sessionId, enabled });
    if (!owner.current.current(token)) return;
    if (result.createMode !== null) updateReady(token, (value) => value.sessionId === current.sessionId ? { ...value, page: { ...value.page, create_mode: result.createMode! } } : value);
    setToggleError(result.error); setToggleBlocked(result.blocked); setToggleRetryable(result.retryable); setToggling(false);
    return result;
  }, [client, updateReady]);

  const toggle = useCallback(async () => {
    if (!canWrite || !client || (state.phase !== "ready" && state.phase !== "empty") || (toggleBlocked && !toggleRetryable)) return;
    const enabled = !state.page.create_mode;
    if (state.phase === "empty") { setPendingCreateMode(state, enabled); return { createMode: enabled, error: null }; }
    return toggleReady(state, owner.current.token(), enabled);
  }, [canWrite, client, setPendingCreateMode, state, toggleBlocked, toggleRetryable, toggleReady]);

  const buildPage = async () => {
    if (!buildDraft.trim() || location.pathname !== createPath) return;
    await startChat("build", async () => {
      setBuildError(null);
      const focus = claimComposerFocus();
      try {
        if (!client || !connected) throw new Error("zeta is not connected; try again when it reconnects");
        if (!authority.current) throw new Error("this tab is read-only; take control to build a page");
        let target = buildTarget.current;
        // Keep the registered chat and delivery id on retry, even if reconnect replaced its lease.
        const token = target && owner.current.current(target.token) ? target.token : owner.current.begin("build:home", true);
        const readAt = titleClock.current;
        if (!target || target.token !== token) {
          const sessionId = target?.ready.sessionId ?? null;
          const attached = await attachPage(client, "home", sessionId, owner.current, creation.current, token, true, undefined, undefined, !sessionId, true, "page_build");
          requireCurrent(owner.current, token);
          if (attached.phase === "busy") throw new Error("another chat is running; try again when it finishes");
          if (attached.phase !== "ready" || (sessionId && attached.sessionId !== sessionId)) throw new Error("could not open the build chat");
          target = { ready: attached, token, deliveryId: target?.deliveryId };
          buildTarget.current = target;
        }
        const checkDestination = () => {
          requireCurrent(owner.current, token);
          if (location.pathname !== createPath || !authority.current) throw new Error("the build was interrupted; return here and try again");
        };
        checkDestination();
        if (!target.ready.page.create_mode || modeToggle.current.stale()?.sessionId === target.ready.sessionId) {
          const result = await toggleReady(target.ready, token, true);
          checkDestination();
          if (!result?.createMode || result.blocked) throw new Error(result?.error ?? "could not turn on create mode");
          target.ready = { ...target.ready, page: { ...target.ready.page, create_mode: true } };
        }
        await modeToggle.current.beforeSend();
        checkDestination();
        const deliveryId = target.deliveryId ?? crypto.randomUUID();
        target.deliveryId = deliveryId;
        await sendReady(client, target.ready, token, buildDraft, deliveryId, false, (id) => { target.deliveryId = id; });
        checkDestination();
        pendingSelection.current = { sessionId: target.ready.sessionId, sawRunning: true };
        publishReady(target.ready, token, readAt, false, focus.owns(), false);
        buildTarget.current = null;
        setBuildDraft("");
      } catch (caught) {
        setBuildError(caught instanceof StaleAttachment ? "the build was interrupted; try again" : caught instanceof Error ? caught.message : "could not start the build");
      } finally {
        focus.release();
      }
    });
  };

  const toggleApprovalMode = useCallback(async () => {
    if (!canWrite || !client || !ready || ready.serverApprovalMode === "ask" || ready.pendingApprovalMode) return;
    const token = owner.current.token();
    if (approvalRequest.current === token) return;
    const current = () => owner.current.current(token) && authority.current;
    const desired = ready.page.approval_mode === "allow" ? "ask" : "allow";
    approvalRequest.current = token;
    setApprovalChange({ pending: true });
    try {
      const result = await applyApprovalMode(client, ready.sessionId, desired, current);
      if (!current()) return;
      updateReady(token, (value) => ({ ...value, page: { ...value.page, approval_mode: result.approvalMode }, model: result.model, pendingApprovalMode: result.pending ? desired : null }));
      if (!result.pending) setApprovalChange({ pending: false });
    } catch {
      if (current()) setApprovalChange({ pending: false, error: "could not change tool approval; try again" });
    } finally {
      if (approvalRequest.current === token) approvalRequest.current = null;
    }
  }, [canWrite, client, ready, updateReady]);

  const rename = useCallback(async (sessionId: string, nextTitle: string): Promise<boolean> => {
    if (!canWrite) return false;
    const token = owner.current.token();
    const request = ++titleClock.current;
    const trimmed = cutTitle(nextTitle);
    const titledByUser = trimmed.length > 0;
    // clearing the open chat stores its zeta name, so the sidebar and the header show the same title
    const fallback = state.phase === "ready" && state.sessionId === sessionId && state.autoTitle !== "new chat" ? state.autoTitle : null;
    const saved = await persistChatTitle(sessionId, titledByUser ? trimmed : fallback, titledByUser);
    if (!saved) return false;
    applyActive(token, { kind: "rename", sessionId, request, title: titledByUser ? trimmed : null });
    return true;
  }, [applyActive, canWrite, state]);

  const refreshPage = useCallback(async () => {
    // Runs for a page with no chat started yet (phase "empty") as well as a ready chat, so a
    // form write refreshes computed layout values (count metrics) even before the first message.
    if (state.phase !== "ready" && state.phase !== "empty") return;
    const current = state; const token = owner.current.token();
    try {
      const response = await fetch(`/api/pages/${current.page.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`could not refresh page (${response.status})`);
      const page = await response.json() as Page;
      applyActive(token, { kind: "state", update: (value) => (value.phase === "ready" || value.phase === "empty") && value.page.id === page.id ? shownCreateMode(modeToggle.current, { ...value, page: { ...page, approval_mode: value.page.approval_mode } }) : value });
    } catch (caught) {
      if (owner.current.current(token)) console.error("could not refresh page", caught);
    }
  }, [applyActive, state]);

  // the chat this tab shows is zeta's attached session: remember it for a reload, and read the parked list again (the
  // chat left behind may have parked; a chat returned to is no longer parked, and zeta sends no event for that)
  // (each attach: the chat opened again after a refused swap stays the same id, but leaves the parked list)
  const heldSessionId = state.phase === "ready" && canWrite && !state.controlledElsewhere ? state.sessionId : null;
  const heldLease = heldSessionId && state.phase === "ready" ? state.lease : null;
  useEffect(() => {
    if (!client || !heldSessionId) return;
    holdAttached(heldSessionId);
    void refreshParked(client).catch(() => {});
  }, [client, heldSessionId, heldLease]);

  // The notice for a running chat clears itself when that turn ends; a blocked attach of another chat then retries.
  const openSessionId = state.phase === "ready" ? state.sessionId : null;
  useEffect(() => {
    if (!client || !busy?.sessionId) return;
    const { sessionId, retry } = busy;
    return whenTurnEnds(client, sessionId, () => { setBusy(null); if (retry === "attach" && sessionId !== openSessionId) retryAttachment(); });
  }, [busy, client, openSessionId, retryAttachment]);

  const recordLastState = useCallback((lastState: RowState) => {
    // the one owner of the pending selection: a state counts only while its chat is the shown chat. a user who moved
    // away (new chat, another chat, back/forward) shows another view, so that chat's turn end cannot take the view back.
    const pending = pendingSelection.current;
    if (pending && state.phase === "ready" && state.sessionId === pending.sessionId) {
      if (lastState === "running") pending.sawRunning = true;
      if (lastState === "idle" && pending.sawRunning) { setSelectedId(pending.sessionId); pendingSelection.current = null; }
    }
    // the tab that controls the chat records its state; a tab that only reads it does not
    // (the chat list loads again after each stored state)
    if (state.phase !== "ready" || !canWrite || state.controlledElsewhere) return;
    void writeShownState(state.sessionId, lastState);
  }, [canWrite, state]);

  const approvalMode = "page" in state ? creationApprovalMode(state.page.approval_mode, autoApproveDefault) : null;
  return { build: { approvalMode, draft: buildDraft, setDraft: setBuildDraft, pending: startingChat === "build", unavailable: startingChat !== null, error: buildError, locked: Boolean(buildTarget.current?.deliveryId), start: buildPage }, state, approvalChange, toggleApprovalMode, attachSlow, selectedId, listRefresh, toggleError, toggling, toggleBlocked, toggleRetryable, creationError, creationPageId, creatingChat: startingChat === "new" && state.phase !== "ready", swapping: swapping && state.phase === "ready" && state.sessionId === swap.current?.kept, startingChat: startingChat !== null, focusSessionId, retrySaving, discardCreation, retryAttachment, retryLimit, selectChat, continueWaitingChat, newChat, openNewChat, send, toggle, refreshPage, recordLastState, rename, busy, retryBusy, openBusyChat, stay, stop, stopAndRetry, retryStopped };
}
