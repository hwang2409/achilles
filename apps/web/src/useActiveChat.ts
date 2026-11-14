import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLease, ZetaClient } from "@fulcrum/zeta";
import type { Chat } from "./AppShell";
import { supportsFeature } from "./zeta";
import { applyApprovalMode, loadSession, openHomeSession } from "./zeta/session";

export type Page = { id: string; route: string; title: string; zeta_session_id: string | null; workspace: string; create_mode: boolean; approval_mode?: string | null; layout: { blocks: Array<Record<string, unknown>> } };
type Attachment = { page: Page; serverApprovalMode: string | null; sessionId: string; lease: SessionLease; credential: string; pendingApprovalMode: string | null; title: string };
type ReadyState = Attachment & { phase: "ready" };
type State = { phase: "loading" } | { phase: "error"; error: string } | ReadyState;
type Orphan = { sessionId: string; pageId: string; route: string };

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
class StaleAttachment extends Error {}
const requireCurrent = (owner: AttachmentOwner, token: number) => { if (!owner.current(token)) throw new StaleAttachment(); };

async function attachPage(client: ZetaClient, key: string, selectedId: string | null, owner: AttachmentOwner, token: number): Promise<Attachment> {
  let ownsLease = false;
  try {
    const loaded = await fetch(`/api/pages/${key}`, { cache: "no-store" }); requireCurrent(owner, token);
    if (!loaded.ok) throw new Error("page not found");
    const page = await loaded.json() as Page; requireCurrent(owner, token);
    if (!supportsFeature(client, "session_mcp_bindings")) throw new Error("this zeta does not support page tools");
    const credentialResponse = await fetch(`/api/pages/${page.id}/credential`, { cache: "no-store" }); requireCurrent(owner, token);
    if (!credentialResponse.ok) throw new Error(`could not load page credential (${credentialResponse.status})`);
    const credential = ((await credentialResponse.json()) as { credential: string }).credential; requireCurrent(owner, token);
    const selectedChat = selectedId ? await findChat(selectedId) : null; requireCurrent(owner, token);
    if (selectedId && selectedChat?.page_id !== page.id) throw new Error("chat not found on this page");
    const serverApprovalMode = page.approval_mode ?? null;
    let session = await openHomeSession(client, selectedId ?? page.zeta_session_id, credential, page.workspace, serverApprovalMode); requireCurrent(owner, token);
    let lease = await loadSession(client, session.id);
    if (!owner.accept(token, lease)) throw new StaleAttachment();
    ownsLease = true;
    if (!selectedId) {
      const saved = await fetch(`/api/pages/${page.id}/session`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_session_id: page.zeta_session_id, session_id: session.id }) }); requireCurrent(owner, token);
      if (!saved.ok && saved.status !== 409) throw new Error(`could not save session mapping (${saved.status})`);
      if (saved.status === 409) {
        const actual = ((await saved.json()) as { session_id: string }).session_id; requireCurrent(owner, token);
        owner.release(token); ownsLease = false;
        session = await openHomeSession(client, actual, credential, page.workspace, serverApprovalMode); requireCurrent(owner, token);
        lease = await loadSession(client, session.id);
        if (!owner.accept(token, lease)) throw new StaleAttachment();
        ownsLease = true;
      }
    }
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

async function registerChat(orphan: Orphan) {
  const response = await fetch(`/api/pages/${orphan.pageId}/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: orphan.sessionId }) });
  if (!response.ok) throw new Error(`could not save chat (${response.status})`);
}

type NewChatSource = Pick<Attachment, "credential" | "page" | "serverApprovalMode">;
export async function createRegisteredSession(client: ZetaClient, current: NewChatSource, retain: (orphan: Orphan | null) => void) {
  const held: { pending: Orphan | null } = { pending: null };
  const created = await openHomeSession(client, null, current.credential, current.page.workspace, current.serverApprovalMode, true, async (sessionId) => {
    const pending = { sessionId, pageId: current.page.id, route: current.page.route === "/" ? "/" : current.page.route };
    held.pending = pending;
    retain(pending);
    try { await registerChat(pending); } catch { await registerChat(pending); }
    retain(null);
  });
  if (!held.pending) throw new Error("zeta did not retain the created session id");
  return { created, pending: held.pending };
}

export function useActiveChat(client: ZetaClient | null, connected: boolean) {
  const [selectedId, setSelectedId] = useState(selectedFromUrl);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [orphan, setOrphan] = useState<Orphan | null>(null);
  const [orphanError, setOrphanError] = useState<string | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const owner = useRef(createAttachmentOwner());

  useEffect(() => {
    if (!client || !connected) return;
    const token = owner.current.begin(`${keyFromPath()}:${selectedId ?? "default"}`, true);
    setState((current) => current.phase === "ready" ? current : { phase: "loading" });
    void attachPage(client, keyFromPath(), selectedId, owner.current, token).then((next) => {
      if (!owner.current.current(token)) return;
      setState({ phase: "ready", ...next });
    }).catch((caught) => { if (!(caught instanceof StaleAttachment) && owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught) }); });
    return () => owner.current.clear(token);
  }, [client, connected, selectedId]);

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

  const finishRegistration = useCallback(async (pending: Orphan) => {
    try {
      await registerChat(pending);
      setOrphan(null); setOrphanError(null);
      owner.current.clear(); setState({ phase: "loading" });
      history.pushState({}, "", routeWithChat(pending.route, pending.sessionId));
      setFocusSessionId(pending.sessionId); setSelectedId(pending.sessionId); setListRefresh((value) => value + 1);
    } catch (caught) { setOrphanError(`${attachmentError(caught)}. the zeta session was kept.`); }
  }, []);

  const newChat = useCallback(async () => {
    if (!client || state.phase !== "ready") return;
    const token = owner.current.begin(`new:${state.page.id}`, true);
    const current = state;
    setState({ phase: "loading" });
    await (async () => {
      let pending: Orphan | null = null;
      let registered = false;
      try {
        const result = await createRegisteredSession(client, current, (retained) => {
          pending = retained ?? pending;
          registered = !retained;
          setOrphan((value) => retained ?? (value?.sessionId === pending?.sessionId ? null : value));
          if (!retained) { setOrphanError(null); setListRefresh((value) => value + 1); }
        });
        const created = result.created;
        pending = result.pending;
        if (!owner.current.current(token)) return;
        history.pushState({}, "", routeWithChat(pending.route, pending.sessionId));
        setFocusSessionId(pending.sessionId); setSelectedId(pending.sessionId);
        return;
      } catch (caught) {
        if (pending && !registered) setOrphanError(`${attachmentError(caught)}. the zeta session was kept.`);
        else if (owner.current.current(token)) setState({ phase: "error", error: attachmentError(caught) });
        return;
      }
    })();
  }, [client, state]);

  const retryOrphan = useCallback(() => { if (orphan) void finishRegistration(orphan); }, [finishRegistration, orphan]);

  const updateReady = useCallback((token: number, update: (current: ReadyState) => ReadyState) => {
    if (!owner.current.current(token)) return;
    setState((current) => current.phase === "ready" ? update(current) : current);
  }, []);

  const send = useCallback(async (text: string, intent: { steer: boolean }, track: (id: string) => void) => {
    if (!client || state.phase !== "ready") throw new Error("zeta is not connected");
    const current = state; const token = owner.current.token();
    const delivery_id = crypto.randomUUID(); track(delivery_id);
    await client.request(intent.steer ? "steer" : "send", { session_id: current.sessionId, text, delivery_id });
    if (!owner.current.current(token) || current.title !== "untitled chat") return;
    const nextTitle = text.trim().slice(0, 200);
    const response = await fetch(`/api/chats/${encodeURIComponent(current.sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nextTitle }) });
    if (response.ok) updateReady(token, (value) => ({ ...value, title: nextTitle }));
    if (response.ok) setListRefresh((value) => value + 1);
  }, [client, state, updateReady]);

  const toggle = useCallback(async () => {
    if (state.phase !== "ready") return;
    const current = state; const token = owner.current.token();
    setToggleError(null); setToggling(true);
    try {
      const response = await fetch(`/api/pages/${current.page.id}/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !current.page.create_mode }) });
      if (!response.ok) throw new Error(`could not update create mode (${response.status})`);
      const result = await response.json() as { create_mode: boolean };
      updateReady(token, (value) => ({ ...value, page: { ...value.page, create_mode: result.create_mode } }));
    } catch (caught) { if (owner.current.current(token)) setToggleError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (owner.current.current(token)) setToggling(false); }
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
    void fetch(`/api/chats/${encodeURIComponent(state.sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ last_state: lastState }) })
      .then(() => { if (owner.current.current(token)) setListRefresh((value) => value + 1); });
  }, [state]);

  return { state, selectedId, listRefresh, toggleError, toggling, orphanError, focusSessionId, retryOrphan, selectChat, continueWaitingChat, newChat, send, toggle, settleApprovalMode, recordLastState };
}
