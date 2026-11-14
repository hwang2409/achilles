import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SessionLease, ZetaClient } from "@fulcrum/zeta";
import type { Chat } from "./AppShell";
import { supportsFeature } from "./zeta";
import { getSettings } from "./settings";
import { createChatCreationOwner, type ChatCreationInput, type ChatCreationOwner, type PendingChat } from "./chatCreation";
import { applyApprovalMode, creationApprovalMode, loadSession, openHomeSession, SessionNotFoundError } from "./zeta/session";

export type Page = { id: string; route: string; title: string; zeta_session_id: string | null; workspace: string; create_mode: boolean; approval_mode?: string | null; layout: { blocks: Array<Record<string, unknown>> } };
type Attachment = { page: Page; serverApprovalMode: string | null; sessionId: string; lease: SessionLease; credential: string; pendingApprovalMode: string | null; title: string };
type ReadyState = Attachment & { phase: "ready" };
type State = { phase: "loading" } | { phase: "error"; error: string } | { phase: "missing" } | ReadyState;

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

function attachmentError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
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
type ReadMetadata = Target & { credential: string };
class StaleAttachment extends Error {}
const requireCurrent = (owner: AttachmentOwner, token: number) => { if (!owner.current(token)) throw new StaleAttachment(); };

async function resolveTarget(key: string, selectedId: string | null, owner: AttachmentOwner, token: number): Promise<Target> {
  const loaded = await fetch(`/api/pages/${key}`, { cache: "no-store" }); requireCurrent(owner, token);
  if (!loaded.ok) throw new Error("page not found");
  const page = await loaded.json() as Page; requireCurrent(owner, token);
  return { page, selectedId, sessionId: selectedId ?? page.zeta_session_id };
}

async function loadReadMetadata(target: Target, owner: AttachmentOwner, token: number): Promise<ReadMetadata> {
  const response = await fetch(`/api/pages/${target.page.id}/credential`, { cache: "no-store" }); requireCurrent(owner, token);
  if (!response.ok) throw new Error(`could not load page credential (${response.status})`);
  const credential = ((await response.json()) as { credential: string }).credential; requireCurrent(owner, token);
  return { ...target, credential };
}

async function attachObserver(client: ZetaClient, metadata: ReadMetadata, owner: AttachmentOwner, token: number): Promise<Attachment> {
  const { page, sessionId, credential } = metadata;
  if (!sessionId) throw new Error("not available in read-only view");
  const selectedChat = await findChat(sessionId); requireCurrent(owner, token);
  let lease: SessionLease;
  try { lease = await loadSession(client, sessionId); }
  catch { throw new Error("not available in read-only view"); }
  if (!owner.accept(token, lease)) throw new StaleAttachment();
  return { page, serverApprovalMode: page.approval_mode ?? null, sessionId, lease, credential, pendingApprovalMode: null, title: selectedChat?.title?.trim() || "untitled chat" };
}

async function attachController(client: ZetaClient, metadata: ReadMetadata, owner: AttachmentOwner, creation: ChatCreationOwner, token: number, allowMissingSelected: boolean): Promise<Attachment> {
  const { page, selectedId, credential } = metadata;
  if (!supportsFeature(client, "session_mcp_bindings")) throw new Error("this zeta does not support page tools");
  const creationInput = { client, pageId: page.id, credential, cwd: page.workspace, mode: creationApprovalMode(page.approval_mode, getSettings().autoApproveDefault) };
  let resumedCreation: PendingChat | null;
  try { resumedCreation = await creation.resume(creationInput); }
  catch (caught) { throw new PendingCreationError(caught, creationInput); }
  requireCurrent(owner, token);
  const selectedChat = selectedId ? await findChat(selectedId) : null; requireCurrent(owner, token);
  if (selectedId && !allowMissingSelected && selectedChat?.page_id !== page.id) throw new MissingChatError(creationInput, page.route === "/" ? "/" : page.route);
  const serverApprovalMode = page.approval_mode ?? null;
  let sessionId = selectedId ?? resumedCreation?.mappedSessionId ?? metadata.sessionId;
  let session: Awaited<ReturnType<typeof openHomeSession>> | undefined;
  if (sessionId) {
    try { session = await openHomeSession(client, sessionId, credential, page.workspace, serverApprovalMode); }
    catch (caught) {
      if (!(caught instanceof SessionNotFoundError)) throw caught;
      if (selectedId && !allowMissingSelected) throw new MissingChatError(creationInput, page.route === "/" ? "/" : page.route);
    }
    requireCurrent(owner, token);
  }
  if (!session) {
    const mappingInput = { ...creationInput, mapExpectedSessionId: page.zeta_session_id };
    let created: PendingChat;
    try { created = await creation.create(mappingInput); }
    catch (caught) { throw new PendingCreationError(caught, mappingInput); }
    requireCurrent(owner, token);
    sessionId = created.mappedSessionId ?? created.sessionId;
    session = await openHomeSession(client, sessionId, credential, page.workspace, serverApprovalMode); requireCurrent(owner, token);
  }
  const lease = await loadSession(client, session.id);
  if (!owner.accept(token, lease)) throw new StaleAttachment();
  try {
    page.approval_mode = session.approvalMode;
    const title = session.name?.trim() || selectedChat?.title?.trim() || (await findChat(session.id))?.title?.trim() || "untitled chat"; requireCurrent(owner, token);
    if (session.name?.trim() && session.name.trim() !== selectedChat?.title?.trim())
      void fetch(`/api/chats/${encodeURIComponent(session.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    return { page, serverApprovalMode, sessionId: session.id, lease, credential, pendingApprovalMode: session.pending ? "ask" : null, title };
  } catch (caught) { owner.release(token); throw caught; }
}

export async function attachPage(client: ZetaClient, key: string, selectedId: string | null, owner: AttachmentOwner, creation: ChatCreationOwner, token: number, readOnly = false, allowMissingSelected = false): Promise<Attachment> {
  const target = await resolveTarget(key, selectedId, owner, token);
  const metadata = await loadReadMetadata(target, owner, token);
  return readOnly
    ? attachObserver(client, metadata, owner, token)
    : attachController(client, metadata, owner, creation, token, allowMissingSelected);
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
  constructor(caught: unknown, readonly input: ChatCreationInput) { super(attachmentError(caught)); }
}

const NO_CREATION = { pending: null, error: null };

function chatCreationContext(state: State, client: ZetaClient) {
  if (state.phase === "ready") return { route: state.page.route === "/" ? "/" : state.page.route, input: { client, pageId: state.page.id, credential: state.credential, cwd: state.page.workspace, mode: creationApprovalMode(state.serverApprovalMode, getSettings().autoApproveDefault) } };
  return null;
}

export function useActiveChat(client: ZetaClient | null, connected: boolean, canWrite = false, allowMissingSelected = false) {
  const [selectedId, setSelectedId] = useState(selectedFromUrl);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [creationPageId, setCreationPageId] = useState<string | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const owner = useRef(createAttachmentOwner());
  const creation = useRef(createChatCreationOwner());
  const status = useSyncExternalStore(creation.current.subscribe, () => creationPageId ? creation.current.status(creationPageId) : NO_CREATION);
  const creationError = status.error;
  const missingCreation = useRef<{ input: ChatCreationInput; route: string } | null>(null);

  useEffect(() => {
    if (!client || !connected) return;
    const token = owner.current.begin(`${keyFromPath()}:${selectedId ?? "default"}`, true);
    setCreationPageId(null);
    setState((current) => current.phase === "ready" ? current : { phase: "loading" });
    void attachPage(client, keyFromPath(), selectedId, owner.current, creation.current, token, !canWrite, allowMissingSelected).then((next) => {
      if (!owner.current.current(token)) return;
      setCreationPageId(next.page.id);
      setState({ phase: "ready", ...next });
    }).catch((caught) => {
      if (caught instanceof PendingCreationError && owner.current.current(token)) {
        setCreationPageId(caught.input.pageId);
      } else if (caught instanceof MissingChatError && owner.current.current(token)) {
        missingCreation.current = { input: caught.input, route: caught.route };
        setState({ phase: "missing" });
      } else if (!(caught instanceof StaleAttachment) && owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught) });
    });
    return () => owner.current.clear(token);
  }, [allowMissingSelected, canWrite, client, connected, selectedId]);

  useEffect(() => {
    const pop = () => { owner.current.clear(); setState({ phase: "loading" }); setSelectedId(selectedFromUrl()); };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => () => owner.current.clear(), []);

  const selectChat = useCallback((chat: Chat) => {
    const route = chat.page_route === "/" ? "/" : chat.page_route;
    const target = routeWithChat(route, chat.session_id);
    if (route !== location.pathname) { location.assign(target); return; }
    if (chat.session_id === selectedId) return;
    owner.current.begin(`${keyFromPath()}:${chat.session_id}`);
    setState({ phase: "loading" });
    history.pushState({}, "", target);
    setFocusSessionId(null);
    setSelectedId(chat.session_id);
  }, [selectedId]);

  const continueWaitingChat = useCallback(async () => {
    const waiting = await findWaitingChat();
    if (waiting) selectChat(waiting);
  }, [selectChat]);

  const publishCreated = useCallback((route: string, pending: PendingChat, token?: number) => {
    if (token !== undefined && !owner.current.current(token)) return;
    missingCreation.current = null; setCreationPageId(pending.pageId); setListRefresh((value) => value + 1);
    owner.current.clear(); setState({ phase: "loading" });
    const attachedSessionId = pending.mappedSessionId ?? pending.sessionId;
    history.pushState({}, "", routeWithChat(route, attachedSessionId));
    setFocusSessionId(attachedSessionId); setSelectedId(attachedSessionId);
  }, []);

  const newChat = useCallback(async () => {
    if (!client || !canWrite) return;
    const context = chatCreationContext(state, client) ?? (state.phase === "missing" ? missingCreation.current : null);
    if (!context) return;
    const token = owner.current.begin(`new:${context.input.pageId}`, true);
    setCreationPageId(context.input.pageId);
    setState({ phase: "loading" });
    try {
      publishCreated(context.route, await creation.current.create(context.input), token);
    } catch (caught) {
      if (!creation.current.status(context.input.pageId).pending && owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught) });
    }
  }, [canWrite, client, publishCreated, state]);

  const retrySaving = useCallback(() => {
    if (!canWrite || !creationPageId) return;
    void creation.current.resume(creationPageId)?.then((pending) => {
      if (pending) publishCreated(location.pathname, pending);
    }).catch(() => {});
  }, [canWrite, creationPageId, publishCreated]);

  const updateReady = useCallback((token: number, update: (current: ReadyState) => ReadyState) => {
    if (!owner.current.current(token)) return;
    setState((current) => current.phase === "ready" ? update(current) : current);
  }, []);

  const send = useCallback(async (text: string, intent: { steer: boolean }, track: (id: string) => void) => {
    if (!canWrite || !client || state.phase !== "ready") throw new Error("zeta is not connected");
    const current = state; const token = owner.current.token();
    const delivery_id = crypto.randomUUID(); track(delivery_id);
    await client.request(intent.steer ? "steer" : "send", { session_id: current.sessionId, text, delivery_id });
    if (!owner.current.current(token) || current.title !== "untitled chat") return;
    const nextTitle = text.trim().slice(0, 200);
    const response = await fetch(`/api/chats/${encodeURIComponent(current.sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nextTitle }) });
    if (response.ok) updateReady(token, (value) => ({ ...value, title: nextTitle }));
    if (response.ok) setListRefresh((value) => value + 1);
  }, [canWrite, client, state, updateReady]);

  const toggle = useCallback(async () => {
    if (!canWrite || state.phase !== "ready") return;
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
    if (!canWrite || !client || state.phase !== "ready" || !state.pendingApprovalMode) return;
    const current = state; const mode = state.pendingApprovalMode; const token = owner.current.token();
    try {
      const result = await applyApprovalMode(client, current.sessionId, mode);
      updateReady(token, (value) => ({ ...value, page: { ...value.page, approval_mode: result.approvalMode }, pendingApprovalMode: result.pending ? mode : null }));
    } catch (caught) { if (owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught) }); }
  }, [canWrite, client, state, updateReady]);

  const recordLastState = useCallback((lastState: string) => {
    if (!canWrite || state.phase !== "ready") return;
    const token = owner.current.token();
    void fetch(`/api/chats/${encodeURIComponent(state.sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ last_state: lastState }) })
      .then(() => { if (owner.current.current(token)) setListRefresh((value) => value + 1); });
  }, [canWrite, state]);

  return { state, selectedId, listRefresh, toggleError, toggling, creationError, focusSessionId, retrySaving, selectChat, continueWaitingChat, newChat, send, toggle, settleApprovalMode, recordLastState };
}
