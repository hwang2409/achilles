import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { SessionLease, ZetaClient } from "@fulcrum/zeta";
import type { Chat } from "./AppShell";
import { supportsFeature } from "./zeta";
import { getSettings } from "./settings";
import { createChatCreationOwner, type ChatCreationInput, type ChatCreationOwner, type PendingChat } from "./chatCreation";
import { applyApprovalMode, creationApprovalMode, loadSession, openHomeSession, SessionNotFoundError } from "./zeta/session";

export type Page = { id: string; route: string; title: string; zeta_session_id: string | null; workspace: string; create_mode: boolean; approval_mode?: string | null; layout: { blocks: Array<Record<string, unknown>> } };
type AttachmentBase = { page: Page; serverApprovalMode: string | null; sessionId: string; lease: SessionLease; pendingApprovalMode: string | null; title: string };
export type Attachment = (AttachmentBase & { kind: "controller"; credential: string }) | (AttachmentBase & { kind: "observer" });
export type ReadyState = Attachment & { phase: "ready" };
export type AttachmentState = { phase: "loading" | "switching" } | { phase: "error"; error: string } | { phase: "missing" } | ReadyState;
export type AttachmentModel = { token: number; authority: Attachment["kind"]; attaching: boolean; state: AttachmentState };
export type AttachmentEvent =
  | { type: "attach-started"; token: number; authority: Attachment["kind"] }
  | { type: "attached"; token: number; attachment: Attachment }
  | { type: "failed"; token: number; error: string }
  | { type: "missing"; token: number }
  | { type: "loading"; token: number; authority: Attachment["kind"] }
  | { type: "update"; token: number; update: (current: ReadyState) => ReadyState };

export const createAttachmentModel = (authority: Attachment["kind"]): AttachmentModel => ({ token: 0, authority, attaching: false, state: { phase: "loading" } });

export function reduceAttachment(model: AttachmentModel, event: AttachmentEvent): AttachmentModel {
  if (event.type === "attach-started") {
    const keepReady = model.authority === event.authority && model.state.phase === "ready";
    return { token: event.token, authority: event.authority, attaching: true, state: keepReady ? model.state : { phase: "loading" } };
  }
  if (event.type === "loading") return { token: event.token, authority: event.authority, attaching: false, state: { phase: "loading" } };
  if (event.token !== model.token) return model;
  if (event.type === "attached") return model.attaching && event.attachment.kind === model.authority ? { ...model, attaching: false, state: { phase: "ready", ...event.attachment } } : model;
  if (event.type === "failed") return { ...model, attaching: false, state: model.state.phase === "ready" ? model.state : { phase: "error", error: event.error } };
  if (event.type === "missing") return { ...model, attaching: false, state: { phase: "missing" } };
  return model.state.phase === "ready" ? { ...model, state: event.update(model.state) } : model;
}

export function selectAttachmentState(model: AttachmentModel, canWrite: boolean): AttachmentState {
  const authority = canWrite ? "controller" : "observer";
  if (model.authority !== authority || (model.state.phase === "ready" && model.state.kind !== authority)) return { phase: "switching" };
  return model.state;
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

export function persistUntitledChatTitle(sessionId: string, title: string, onSuccess: () => void): void {
  void fetch(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) })
    .then((response) => { if (response.ok) onSuccess(); })
    .catch((error) => console.error("could not update chat title", error));
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
    const params = new URLSearchParams({ limit: "200" });
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

async function findWaitingChat() {
  let before: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "200" });
    if (before) params.set("before", before);
    const response = await fetch(`/api/chats?${params}`, { cache: "no-store" });
    if (!response.ok) return null;
    const result = await response.json() as { chats: Chat[]; next: string | null };
    const found = result.chats.find((chat) => chat.last_state === "approval");
    if (found) return found;
    before = result.next;
  } while (before);
  return null;
}

type AttachmentOwner = ReturnType<typeof createAttachmentOwner>;
type Target = { page: Page; selectedId: string | null; sessionId: string | null };
type ControllerMetadata = Target & { credential: string };
class StaleAttachment extends Error {}
const requireCurrent = (owner: AttachmentOwner, token: number) => { if (!owner.current(token)) throw new StaleAttachment(); };

async function resolveTarget(key: string, selectedId: string | null, owner: AttachmentOwner, token: number): Promise<Target> {
  const loaded = await fetch(`/api/pages/${key}`, { cache: "no-store" }); requireCurrent(owner, token);
  if (!loaded.ok) throw new Error("page not found");
  const page = await loaded.json() as Page; requireCurrent(owner, token);
  return { page, selectedId, sessionId: selectedId ?? page.zeta_session_id };
}

async function attachObserver(client: ZetaClient, target: Target, owner: AttachmentOwner, token: number): Promise<Attachment> {
  const { page, sessionId } = target;
  if (!sessionId) throw new Error("not available in read-only view");
  const selectedChat = await findChat(sessionId); requireCurrent(owner, token);
  let lease: SessionLease;
  try { lease = await loadSession(client, sessionId); }
  catch { throw new Error("not available in read-only view"); }
  if (!owner.accept(token, lease)) throw new StaleAttachment();
  return { kind: "observer", page, serverApprovalMode: page.approval_mode ?? null, sessionId, lease, pendingApprovalMode: null, title: selectedChat?.title?.trim() || "untitled chat" };
}

type OpenedSession = Awaited<ReturnType<typeof openHomeSession>>;

async function resumeCreation(creation: ChatCreationOwner, input: ChatCreationInput) {
  try { return await creation.resume(input); }
  catch (caught) { throw new PendingCreationError(caught, input); }
}

async function openControllerSession(client: ZetaClient, metadata: ControllerMetadata, input: ChatCreationInput, sessionId: string | null, allowMissingSelected: boolean): Promise<OpenedSession | undefined> {
  if (!sessionId) return;
  try { return await openHomeSession(client, sessionId, metadata.credential, metadata.page.workspace, metadata.page.approval_mode); }
  catch (caught) {
    if (!(caught instanceof SessionNotFoundError)) throw caught;
    if (metadata.selectedId && !allowMissingSelected) throw new MissingChatError(input, metadata.page.route === "/" ? "/" : metadata.page.route);
  }
}

async function createControllerSession(client: ZetaClient, metadata: ControllerMetadata, input: ChatCreationInput, creation: ChatCreationOwner, owner: AttachmentOwner, token: number): Promise<OpenedSession> {
  const mappingInput = { ...input, mapExpectedSessionId: metadata.page.zeta_session_id };
  let created: PendingChat;
  try { created = await creation.create(mappingInput); }
  catch (caught) { throw new PendingCreationError(caught, mappingInput); }
  requireCurrent(owner, token);
  const sessionId = created.mappedSessionId ?? created.sessionId;
  const session = await openHomeSession(client, sessionId, metadata.credential, metadata.page.workspace, metadata.page.approval_mode); requireCurrent(owner, token);
  return session;
}

async function finishControllerAttachment(metadata: ControllerMetadata, session: OpenedSession, selectedChat: Chat | null, lease: SessionLease, owner: AttachmentOwner, token: number): Promise<Attachment> {
  const { page, credential } = metadata;
  try {
    const serverApprovalMode = page.approval_mode ?? null;
    page.approval_mode = session.approvalMode;
    const title = session.name?.trim() || selectedChat?.title?.trim() || (await findChat(session.id))?.title?.trim() || "untitled chat"; requireCurrent(owner, token);
    if (session.name?.trim() && session.name.trim() !== selectedChat?.title?.trim())
      void fetch(`/api/chats/${encodeURIComponent(session.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    return { kind: "controller", page, serverApprovalMode, sessionId: session.id, lease, credential, pendingApprovalMode: session.pending ? "ask" : null, title };
  } catch (caught) { owner.release(token); throw caught; }
}

async function attachController(client: ZetaClient, target: Target, owner: AttachmentOwner, creation: ChatCreationOwner, token: number, allowMissingSelected: boolean): Promise<Attachment> {
  const response = await fetch(`/api/pages/${target.page.id}/credential`, { cache: "no-store" }); requireCurrent(owner, token);
  if (!response.ok) throw new Error(`could not load page credential (${response.status})`);
  const credential = ((await response.json()) as { credential: string }).credential; requireCurrent(owner, token);
  const metadata = { ...target, credential };
  const { page, selectedId } = metadata;
  if (!supportsFeature(client, "session_mcp_bindings")) throw new Error("this zeta does not support page tools");
  const creationInput = { client, pageId: page.id, credential, cwd: page.workspace, mode: creationApprovalMode(page.approval_mode, getSettings().autoApproveDefault) };
  const resumedCreation = await resumeCreation(creation, creationInput); requireCurrent(owner, token);
  const selectedChat = selectedId ? await findChat(selectedId) : null; requireCurrent(owner, token);
  if (selectedId && !allowMissingSelected && selectedChat?.page_id !== page.id) throw new MissingChatError(creationInput, page.route === "/" ? "/" : page.route);
  const targetSessionId = selectedId ?? resumedCreation?.mappedSessionId ?? metadata.sessionId;
  const session = await openControllerSession(client, metadata, creationInput, targetSessionId, allowMissingSelected) ?? await createControllerSession(client, metadata, creationInput, creation, owner, token);
  requireCurrent(owner, token);
  const lease = await loadSession(client, session.id);
  if (!owner.accept(token, lease)) throw new StaleAttachment();
  return finishControllerAttachment(metadata, session, selectedChat, lease, owner, token);
}

export async function attachPage(client: ZetaClient, key: string, selectedId: string | null, owner: AttachmentOwner, creation: ChatCreationOwner, token: number, readOnly = false, allowMissingSelected = false): Promise<Attachment> {
  const target = await resolveTarget(key, selectedId, owner, token);
  return readOnly
    ? attachObserver(client, target, owner, token)
    : attachController(client, target, owner, creation, token, allowMissingSelected);
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

async function waitForIdle(client: Pick<ZetaClient, "request">, sessionId: string, deadline: number) {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("turn did not become idle before resend");
    const result = await client.request("status", { session_id: sessionId }, { timeoutMs: Math.min(1_000, remaining) });
    if (result && typeof result === "object" && (result as { state?: string }).state === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
}

export async function confirmSteerDelivery(
  client: Pick<ZetaClient, "request">,
  sessionId: string,
  text: string,
  deliveryId: string,
  track: (id: string) => void,
  deadlineMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let id = deliveryId;
  track(id);
  let resent = false;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("steer delivery confirmation timed out");
    let result: unknown;
    try {
      result = await client.request("delivery_status", { delivery_id: id }, { timeoutMs: Math.min(1_000, remaining) });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (!result || typeof result !== "object") throw new Error("invalid steer delivery status");
    const status = result as DeliveryStatus;
    const outcome = status.status === "evicted" ? status.outcome : status.status;
    if (outcome === "delivered") return id;
    if (outcome === "dropped") {
      if (resent) throw new Error("steer delivery was dropped after resend");
      resent = true;
      await waitForIdle(client, sessionId, deadline);
      id = crypto.randomUUID();
      track(id);
      await client.request("send", { session_id: sessionId, text, delivery_id: id }, { timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())) });
      continue;
    }
    if (status.status !== "queued" && !(status.status === "evicted" && status.outcome === "queued"))
      throw new Error(`steer delivery status: ${status.status}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
}

function chatCreationContext(state: AttachmentState, client: ZetaClient) {
  if (state.phase === "ready" && state.kind === "controller") return { route: state.page.route === "/" ? "/" : state.page.route, input: { client, pageId: state.page.id, credential: state.credential, cwd: state.page.workspace, mode: creationApprovalMode(state.serverApprovalMode, getSettings().autoApproveDefault) } };
  return null;
}

export function useActiveChat(client: ZetaClient | null, connected: boolean, canWrite = false, allowMissingSelected = false) {
  const [selectedId, setSelectedId] = useState(selectedFromUrl);
  const [attachment, dispatchAttachment] = useReducer(reduceAttachment, canWrite ? "controller" : "observer", createAttachmentModel);
  const state = selectAttachmentState(attachment, canWrite);
  const [creationPageId, setCreationPageId] = useState<string | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [routeRefresh, setRouteRefresh] = useState(0);
  const owner = useRef(createAttachmentOwner());
  const creation = useRef(createChatCreationOwner());
  const status = useSyncExternalStore(creation.current.subscribe, () => creationPageId ? creation.current.status(creationPageId) : NO_CREATION);
  const creationError = status.error ? attachmentError(status.error, "creation") : null;
  const missingCreation = useRef<{ input: ChatCreationInput; route: string } | null>(null);
  const createAfterLoad = useRef(false);

  useEffect(() => {
    if (!client || !connected) return;
    const token = owner.current.begin(`${keyFromPath()}:${selectedId ?? "default"}`, true);
    const authority = canWrite ? "controller" : "observer";
    setCreationPageId(null);
    dispatchAttachment({ type: "attach-started", token, authority });
    void attachPage(client, keyFromPath(), selectedId, owner.current, creation.current, token, !canWrite, allowMissingSelected).then((next) => {
      if (!owner.current.current(token)) return;
      setCreationPageId(next.page.id);
      dispatchAttachment({ type: "attached", token, attachment: next });
    }).catch((caught) => {
      if (caught instanceof PendingCreationError && owner.current.current(token)) {
        setCreationPageId(caught.input.pageId);
      } else if (caught instanceof MissingChatError && owner.current.current(token)) {
        missingCreation.current = { input: caught.input, route: caught.route };
        dispatchAttachment({ type: "missing", token });
      } else if (!(caught instanceof StaleAttachment) && owner.current.current(token)) dispatchAttachment({ type: "failed", token, error: attachmentError(caught) });
    });
    return () => owner.current.clear(token);
  }, [allowMissingSelected, canWrite, client, connected, routeRefresh, selectedId]);

  useEffect(() => {
    const pop = () => { owner.current.clear(); dispatchAttachment({ type: "loading", token: owner.current.token(), authority: canWrite ? "controller" : "observer" }); setSelectedId(selectedFromUrl()); };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, [canWrite]);
  useEffect(() => () => owner.current.clear(), []);

  const selectChat = useCallback((chat: Chat) => {
    const route = chat.page_route === "/" ? "/" : chat.page_route;
    const target = routeWithChat(route, chat.session_id);
    if (route !== location.pathname) { location.assign(target); return; }
    if (chat.session_id === selectedId) return;
    owner.current.begin(`${keyFromPath()}:${chat.session_id}`);
    dispatchAttachment({ type: "loading", token: owner.current.token(), authority: canWrite ? "controller" : "observer" });
    history.pushState({}, "", target);
    setFocusSessionId(null);
    setSelectedId(chat.session_id);
  }, [canWrite, selectedId]);

  const continueWaitingChat = useCallback(async () => {
    const waiting = await findWaitingChat();
    if (waiting) selectChat(waiting);
  }, [selectChat]);

  const publishCreated = useCallback((route: string, pending: PendingChat, token?: number) => {
    if (token !== undefined && !owner.current.current(token)) return;
    missingCreation.current = null; setCreationPageId(pending.pageId); setListRefresh((value) => value + 1);
    owner.current.clear(); dispatchAttachment({ type: "loading", token: owner.current.token(), authority: canWrite ? "controller" : "observer" });
    const attachedSessionId = pending.mappedSessionId ?? pending.sessionId;
    history.pushState({}, "", routeWithChat(route, attachedSessionId));
    setFocusSessionId(attachedSessionId); setSelectedId(attachedSessionId);
  }, [canWrite]);

  const newChat = useCallback(async () => {
    if (!client || !canWrite) return;
    if (state.phase === "error" && state.error === "page not found") {
      createAfterLoad.current = true;
      owner.current.clear();
      history.pushState({}, "", "/");
      dispatchAttachment({ type: "loading", token: owner.current.token(), authority: "controller" });
      setSelectedId(null);
      setRouteRefresh((value) => value + 1);
      return;
    }
    const context = state.phase === "ready" && state.kind === "controller"
      ? { route: state.page.route === "/" ? "/" : state.page.route, input: { client, pageId: state.page.id, credential: state.credential, cwd: state.page.workspace, mode: creationApprovalMode(state.serverApprovalMode, getSettings().autoApproveDefault) } }
      : state.phase === "missing" ? missingCreation.current : null;
    if (!context) return;
    const token = owner.current.begin(`new:${context.input.pageId}`, true);
    setCreationPageId(context.input.pageId);
    dispatchAttachment({ type: "loading", token, authority: "controller" });
    try {
      publishCreated(context.route, await creation.current.create(context.input), token);
    } catch (caught) {
      if (!creation.current.status(context.input.pageId).pending && owner.current.current(token)) dispatchAttachment({ type: "failed", token, error: attachmentError(caught, "creation") });
    }
  }, [canWrite, client, publishCreated, state]);

  const retrySaving = useCallback(() => {
    if (!canWrite || !creationPageId) return;
    void creation.current.resume(creationPageId)?.then((pending) => {
      if (pending) publishCreated(location.pathname, pending);
    }).catch(() => {});
  }, [canWrite, creationPageId, publishCreated]);

  useEffect(() => {
    if (!createAfterLoad.current || state.phase !== "ready" || state.kind !== "controller") return;
    createAfterLoad.current = false;
    void newChat();
  }, [newChat, state]);

  const updateReady = useCallback((token: number, update: (current: ReadyState) => ReadyState) => {
    if (!owner.current.current(token)) return;
    dispatchAttachment({ type: "update", token, update });
  }, []);

  const send = useCallback(async (text: string, intent: { steer: boolean }, track: (id: string) => void) => {
    if (!canWrite || !client || state.phase !== "ready" || state.kind !== "controller") throw new Error("zeta is not connected");
    const current = state; const token = owner.current.token();
    let delivery_id: string = crypto.randomUUID();
    if (!intent.steer) track(delivery_id);
    try {
      await client.request(intent.steer ? "steer" : "send", { session_id: current.sessionId, text, delivery_id });
      if (intent.steer) delivery_id = await confirmSteerDelivery(client, current.sessionId, text, delivery_id, track);
    } catch (error) {
      // A stale turn view can race its server-side turn end. send queues the same draft instead of losing it.
      if (!intent.steer || !(error instanceof Error) || !error.message.includes("no turn is running")) throw error;
      await waitForIdle(client, current.sessionId, Date.now() + 15_000);
      delivery_id = crypto.randomUUID(); track(delivery_id);
      await client.request("send", { session_id: current.sessionId, text, delivery_id });
      delivery_id = await confirmSteerDelivery(client, current.sessionId, text, delivery_id, track);
    }
    if (!owner.current.current(token) || current.title !== "untitled chat") return;
    const nextTitle = text.trim().slice(0, 200);
    persistUntitledChatTitle(current.sessionId, nextTitle, () => {
      updateReady(token, (value) => ({ ...value, title: nextTitle }));
      setListRefresh((value) => value + 1);
    });
  }, [canWrite, client, state, updateReady]);

  const toggle = useCallback(async () => {
    if (!canWrite || state.phase !== "ready" || state.kind !== "controller") return;
    const current = state; const token = owner.current.token();
    setToggleError(null); setToggling(true);
    try {
      const response = await fetch(`/api/pages/${current.page.id}/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !current.page.create_mode }) });
      if (!response.ok) throw new Error(`could not update create mode (${response.status})`);
      const result = await response.json() as { create_mode: boolean };
      updateReady(token, (value) => ({ ...value, page: { ...value.page, create_mode: result.create_mode } }));
    } catch (caught) { if (owner.current.current(token)) setToggleError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (owner.current.current(token)) setToggling(false); }
  }, [canWrite, state, updateReady]);

  const settleApprovalMode = useCallback(async () => {
    if (!canWrite || !client || state.phase !== "ready" || state.kind !== "controller" || !state.pendingApprovalMode) return;
    const current = state; const mode = state.pendingApprovalMode; const token = owner.current.token();
    try {
      const result = await applyApprovalMode(client, current.sessionId, mode);
      updateReady(token, (value) => ({ ...value, page: { ...value.page, approval_mode: result.approvalMode }, pendingApprovalMode: result.pending ? mode : null }));
    } catch (caught) { if (owner.current.current(token)) dispatchAttachment({ type: "failed", token, error: attachmentError(caught) }); }
  }, [canWrite, client, state, updateReady]);

  const recordLastState = useCallback((lastState: string) => {
    if (!canWrite || state.phase !== "ready" || state.kind !== "controller") return;
    const token = owner.current.token();
    void fetch(`/api/chats/${encodeURIComponent(state.sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ last_state: lastState }) })
      .then(() => { if (owner.current.current(token)) setListRefresh((value) => value + 1); });
  }, [canWrite, state]);

  return { state, selectedId, listRefresh, toggleError, toggling, creationError, focusSessionId, retrySaving, selectChat, continueWaitingChat, newChat, send, toggle, settleApprovalMode, recordLastState };
}
