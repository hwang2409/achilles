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

export function persistUntitledChatTitle(sessionId: string, title: string, onSuccess: () => void): void {
  void fetch(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) })
    .then((response) => { if (response.ok) onSuccess(); })
    .catch((error) => console.error("could not update chat title", error));
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
class StaleAttachment extends Error {}
const requireCurrent = (owner: AttachmentOwner, token: number) => { if (!owner.current(token)) throw new StaleAttachment(); };

export async function attachPage(client: ZetaClient, key: string, selectedId: string | null, owner: AttachmentOwner, creation: ChatCreationOwner, token: number): Promise<Attachment> {
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
    let resumedCreation: PendingChat | null;
    try { resumedCreation = await creation.resume(creationInput); }
    catch (caught) { throw new PendingCreationError(caught, creationInput); }
    requireCurrent(owner, token);
    const selectedChat = selectedId ? await findChat(selectedId) : null; requireCurrent(owner, token);
    if (selectedId && selectedChat?.page_id !== page.id) throw new MissingChatError(creationInput, page.route === "/" ? "/" : page.route);
    const serverApprovalMode = page.approval_mode ?? null;
    let sessionId = selectedId ?? resumedCreation?.mappedSessionId ?? page.zeta_session_id;
    let session: Awaited<ReturnType<typeof openHomeSession>> | undefined;
    if (sessionId) {
      try { session = await openHomeSession(client, sessionId, credential, page.workspace, serverApprovalMode); }
      catch (caught) {
        if (!(caught instanceof SessionNotFoundError)) throw caught;
        if (selectedId) throw new MissingChatError(creationInput, page.route === "/" ? "/" : page.route);
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
    ownsLease = true;
    page.approval_mode = session.approvalMode;
    const title = session.name?.trim() || selectedChat?.title?.trim() || (await findChat(session.id))?.title?.trim() || "untitled chat"; requireCurrent(owner, token);
    if (session.name?.trim() && session.name.trim() !== selectedChat?.title?.trim())
      void fetch(`/api/chats/${encodeURIComponent(session.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    return { page, serverApprovalMode, sessionId: session.id, lease, credential, pendingApprovalMode: session.pending ? "ask" : null, title };
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
    reset() {
      generation += 1;
      if (active) active.cancelled = true;
      active = null; pending = null; published = null; retry = null;
    },
  };
}

// Product decision: old Zeta can strand a queued steer; wait once, keep the draft, and never resend text automatically.
const STUCK_STEER_WAIT_MS = 15_000;
export class UncertainSteerDeliveryError extends Error {}
export class DroppedSteerDeliveryError extends Error {}

export async function confirmSteerDelivery(
  client: Pick<ZetaClient, "request">,
  _sessionId: string,
  _text: string,
  deliveryId: string,
  track: (id: string) => void,
  deadlineMs = STUCK_STEER_WAIT_MS,
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  const id = deliveryId;
  track(id);
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UncertainSteerDeliveryError("this message may not have reached the assistant yet. it may still arrive with your next message, so sending it again could deliver it twice.");
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
    if (outcome === "dropped") throw new DroppedSteerDeliveryError("this message was not sent. your text is still here; press send to try again.");
    if (status.status !== "queued" && !(status.status === "evicted" && status.outcome === "queued"))
      throw new Error(`steer delivery status: ${status.status}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
}

export function useActiveChat(client: ZetaClient | null, connected: boolean) {
  const [selectedId, setSelectedId] = useState(selectedFromUrl);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [creationPageId, setCreationPageId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!client || !connected) return;
    const token = owner.current.begin(`${keyFromPath()}:${selectedId ?? "default"}`, true);
    modeToggle.current.reset(); setToggleError(null); setToggling(false); setToggleBlocked(false); setToggleRetryable(false);
    setCreationPageId(null);
    setState((current) => current.phase === "ready" ? current : { phase: "loading" });
    void attachPage(client, keyFromPath(), selectedId, owner.current, creation.current, token).then((next) => {
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
  }, [client, connected, routeRefresh, selectedId]);

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
    if (!client) return;
    if (state.phase === "error" && state.error === "page not found") {
      createAfterLoad.current = true;
      owner.current.clear();
      history.pushState({}, "", "/");
      setState({ phase: "loading" });
      setSelectedId(null);
      setRouteRefresh((value) => value + 1);
      return;
    }
    const context = state.phase === "ready"
      ? { route: state.page.route === "/" ? "/" : state.page.route, input: { client, pageId: state.page.id, credential: state.credential, cwd: state.page.workspace, mode: creationApprovalMode(state.serverApprovalMode, getSettings().autoApproveDefault) } }
      : state.phase === "missing" ? missingCreation.current : null;
    if (!context) return;
    const token = owner.current.begin(`new:${context.input.pageId}`, true);
    setCreationPageId(context.input.pageId);
    setState({ phase: "loading" });
    try {
      publishCreated(context.route, await creation.current.create(context.input), token);
    } catch (caught) {
      if (!creation.current.status(context.input.pageId).pending && owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught, "creation") });
    }
  }, [client, publishCreated, state]);

  const retrySaving = useCallback(() => {
    if (!creationPageId) return;
    void creation.current.resume(creationPageId)?.then((pending) => {
      if (pending) publishCreated(location.pathname, pending);
    }).catch(() => {});
  }, [creationPageId, publishCreated]);

  useEffect(() => {
    if (!createAfterLoad.current || state.phase !== "ready") return;
    createAfterLoad.current = false;
    void newChat();
  }, [newChat, state]);

  const updateReady = useCallback((token: number, update: (current: ReadyState) => ReadyState) => {
    if (!owner.current.current(token)) return;
    setState((current) => current.phase === "ready" ? update(current) : current);
  }, []);

  const send = useCallback(async (text: string, intent: { steer: boolean }, track: (id: string) => void) => {
    if (!client || state.phase !== "ready") throw new Error("zeta is not connected");
    await modeToggle.current.beforeSend();
    const current = state; const token = owner.current.token();
    let delivery_id: string = crypto.randomUUID();
    if (!intent.steer) track(delivery_id);
    await client.request(intent.steer ? "steer" : "send", { session_id: current.sessionId, text, delivery_id });
    if (intent.steer) delivery_id = await confirmSteerDelivery(client, current.sessionId, text, delivery_id, track);
    if (!owner.current.current(token) || current.title !== "untitled chat") return;
    const nextTitle = text.trim().slice(0, 200);
    persistUntitledChatTitle(current.sessionId, nextTitle, () => {
      updateReady(token, (value) => ({ ...value, title: nextTitle }));
      setListRefresh((value) => value + 1);
    });
  }, [client, state, updateReady]);

  const toggle = useCallback(async () => {
    if (!client || state.phase !== "ready" || (toggleBlocked && !toggleRetryable)) return;
    const current = state; const token = owner.current.token();
    setToggleError(null); setToggling(true);
    const result = await modeToggle.current.run({ client, pageId: current.page.id, sessionId: current.sessionId, enabled: !current.page.create_mode });
    if (!owner.current.current(token)) return;
    if (result.createMode !== null) updateReady(token, (value) => ({ ...value, page: { ...value.page, create_mode: result.createMode! } }));
    setToggleError(result.error); setToggleBlocked(result.blocked); setToggleRetryable(result.retryable); setToggling(false);
  }, [client, state, toggleBlocked, toggleRetryable, updateReady]);

  const refreshPage = useCallback(async () => {
    if (state.phase !== "ready") return;
    const current = state; const token = owner.current.token();
    try {
      const response = await fetch(`/api/pages/${current.page.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`could not refresh page (${response.status})`);
      const page = await response.json() as Page;
      updateReady(token, (value) => value.page.id === page.id ? { ...value, page: { ...page, approval_mode: value.page.approval_mode } } : value);
    } catch (caught) {
      if (owner.current.current(token)) console.error("could not refresh page", caught);
    }
  }, [state, updateReady]);

  const settleApprovalMode = useCallback(async () => {
    if (!client || state.phase !== "ready" || !state.pendingApprovalMode) return;
    const current = state; const mode = state.pendingApprovalMode; const token = owner.current.token();
    try {
      const result = await applyApprovalMode(client, current.sessionId, mode);
      updateReady(token, (value) => ({ ...value, page: { ...value.page, approval_mode: result.approvalMode }, pendingApprovalMode: result.pending ? mode : null }));
    } catch (caught) { if (owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught) }); }
  }, [client, state, updateReady]);

  const recordLastState = useCallback((lastState: string) => {
    if (state.phase !== "ready") return;
    const token = owner.current.token();
    void persistChatState(state.sessionId, lastState)
      .then((saved) => { if (saved && owner.current.current(token)) setListRefresh((value) => value + 1); });
  }, [state]);

  return { state, selectedId, listRefresh, toggleError, toggling, toggleBlocked, toggleRetryable, creationError, focusSessionId, retrySaving, selectChat, continueWaitingChat, newChat, send, toggle, refreshPage, settleApprovalMode, recordLastState };
}
