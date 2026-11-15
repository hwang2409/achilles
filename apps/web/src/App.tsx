import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRunStore } from "@fulcrum/core";
import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { Approval, Fallback, Message, RunProvider, Timeline, ToolCall, type ComposerProps, type Renderers } from "@fulcrum/react";
import { AppShell, titleOf } from "./AppShell";
import { PlainComposer } from "./composer/PlainComposer";
import { draftStore } from "./draftStore";
import { DetailRecord, type DetailFilter } from "./DetailRecord";
import { FormBlock, selectRow, useRecordWrites, useSelectedRow } from "./page/RecordForm";
import { EmptyChat } from "./EmptyChat";
import { isEditableTarget } from "./keyboard";
import { useSettings } from "./settings";
import { createApprovalDecider } from "./zeta/approvals";
import { createConnection, type Connection, type ConnectionState } from "./zeta";
import { useActiveChat, type Page } from "./useActiveChat";
import { useInlineRename } from "./useInlineRename";
import { watchJumpToLatest } from "./jumpToLatest";
import "./style.css";

const highlight = createHighlighter();
addEventListener("pagehide", () => highlight.dispose(), { once: true });
const fences: Fences = {};
const RichMarkdown = (props: MarkdownProps) => <Markdown {...props} highlight={highlight} fences={fences} />;
const renderers: Renderers = { message: ({ id }) => <Message id={id} markdown={RichMarkdown} />, tool: ({ id }) => <ToolCall id={id} />, error: ({ id }) => <Fallback id={id} /> };
const LazyVimComposer = lazy(() => import("./composer/VimComposer").then(({ VimComposer }) => ({ default: VimComposer })));

function ComposerSlot({ sessionId, focus, vim, props }: { sessionId: string; focus: boolean; vim: boolean; props: ComposerProps }) {
  const slot = useRef<HTMLDivElement>(null);
  const draft = useSyncExternalStore(
    (listener) => {
      const unsubscribeConfirm = draftStore.subscribeConfirm(sessionId, listener);
      const unsubscribeRemote = draftStore.subscribeRemote(sessionId, listener);
      return () => { unsubscribeConfirm(); unsubscribeRemote(); };
    },
    () => draftStore.get(sessionId),
    () => draftStore.get(sessionId),
  );
  useLayoutEffect(() => { if (focus && !document.activeElement?.closest("[data-chat-id], [data-page-id]")) slot.current?.querySelector<HTMLElement>('textarea[aria-label="message"], [role="textbox"]')?.focus({ preventScroll: true }); }, [focus]);
  const adapterProps = {
    ...props,
    defaultValue: draft,
    onDraftChange: (text: string) => draftStore.set(sessionId, text),
    onDeliveryConfirm: (sent: string) => draftStore.confirm(sessionId, sent),
  };
  const composer = vim
    ? <Suspense fallback={<VimLoading />}><LazyVimComposer {...adapterProps} /></Suspense>
    : <PlainComposer {...adapterProps} />;
  return <div id="message-composer" ref={slot} style={{ display: "contents" }}>{composer}</div>;
}

function VimLoading() {
  return <div className="vim-loading" data-part="composer" data-state="read-only" role="group" aria-label="message" aria-disabled="true"><div data-part="composer-field"><textarea rows={1} aria-label="message" placeholder="loading vim…" disabled /></div></div>;
}

function activeLastState(waiting: number, outcome: string, turn: "idle" | "running") {
  return waiting ? "approval" : outcome === "failed" ? "failed" : turn === "running" ? "running" : "idle";
}

function activeComposerProps(
  connected: boolean,
  toggleBlocked: boolean,
  turn: "idle" | "running",
  onSubmit: ComposerProps["onSubmit"],
  onStop: () => void,
): ComposerProps {
  if (!connected) return { state: "read-only", reason: "send is off until zeta is back", onSubmit, placeholder: "message zeta" };
  if (toggleBlocked) return { state: "read-only", reason: "send is off until page tools refresh", onSubmit, placeholder: "message zeta" };
  return { state: turn === "running" ? "steerable" : "idle", onSubmit, onStop, placeholder: "message zeta" };
}

function connectionFailure(state: ConnectionState): string | null {
  if (state.phase !== "connected" && "lost" in state && state.lost) return "the connection to zeta was lost.";
  switch (state.phase) {
    case "not_running": return "zeta serve is not running.";
    case "auth_failed": return state.reason === "origin" ? `this origin is not allowed by zeta. restart zeta serve with --ws-origin ${location.origin}.` : "zeta rejected this browser connection.";
    case "unresponsive": return "zeta is not responding.";
    case "incompatible": return "this zeta version is not compatible with achilles.";
    // zeta allows one controller; this fires for any other controller connection (a second achilles
    // tab, or another client such as gamma, fulcrum, or the cli), and also when a reload's own
    // cleanup has not finished within zeta's 10s handoff deadline, even with no other tab open.
    // zeta never promotes an observer to controller, so there is no take-over to offer; the page
    // retries by itself with backoff until the slot frees.
    case "controller_taken": return "another client is using zeta (only one can control it at a time), maybe achilles in another tab. close it, and this page reconnects by itself.";
    default: return null;
  }
}

export function App() {
  const settings = useSettings();
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const [client, setClient] = useState(connection.client);
  const connectionState = useSyncExternalStore(connection.subscribe, () => connection.state);
  const active = useActiveChat(client, connectionState.phase === "connected");
  const ready = active.state.phase === "ready" ? active.state : null;
  const empty = active.state.phase === "empty" ? active.state : null;
  const busyPage = active.state.phase === "busy" ? active.state : null;
  const activePage = ready?.page ?? empty?.page ?? null;
  const hasBlocks = (activePage?.layout.blocks.length ?? 0) > 0;
  const recordWrites = useRecordWrites(activePage?.id ?? "");
  const previousRecordWrites = useRef(recordWrites);
  const emptyStore = useMemo(() => empty ? createRunStore() : null, [empty?.page.id]);
  const store = ready?.lease.store ?? null;
  const activeStore = store ?? emptyStore;
  const snapshot = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store ? () => {
    const state = store.getState();
    const completedTurns = state.turn === "idle" ? state.turns.length : Math.max(0, state.turns.length - 1);
    const completedTools = state.outline.reduce((count, item) => { if (item.kind !== "tool") return count; const value = store.getItem(item.id); return count + (value?.type === "tool" && !value.active ? 1 : 0); }, 0);
    const approvals = state.outline.reduce((count, item) => count + (store.getItem(item.id)?.type === "approval" && !(store.getItem(item.id) as { ended?: unknown }).ended ? 1 : 0), 0);
    const toolStates = state.outline.map((item) => {
      const value = store.getItem(item.id) as { active?: boolean; is_error?: boolean; version?: number } | undefined;
      return `${item.id}:${value?.active ?? "missing"}:${value?.is_error ?? false}:${value?.version ?? 0}`;
    }).join(",");
    return `${state.turn}:${completedTurns}:${completedTools}:${approvals}:${state.endOutcome ?? ""}:${state.outline.length}:${toolStates}`;
  } : () => "idle:0:0:0::0:");
  const [turn, completedTurns, completedTools, approvalCount, outcome, outlineLength] = snapshot.split(":") as ["idle" | "running", string, string, string, string, string];
  const refreshKey = `${completedTurns}:${completedTools}`;
  const previousRefreshKey = useRef(refreshKey);
  const waiting = Number(approvalCount);
  const previousTurn = useRef(turn);
  const [followRequest, setFollowRequest] = useState(0);
  const [pageRefreshNonce, setPageRefreshNonce] = useState(0);
  const completedCreatePages = useRef(new Set<string>());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [transcript, setTranscript] = useState<HTMLElement | null>(null);
  const send: typeof active.send = (...args) => {
    setFollowRequest((value) => value + 1);
    return active.send(...args);
  };

  useEffect(() => {
    const unsubscribe = connection.subscribe(() => setClient(connection.client));
    return () => { unsubscribe(); connection.stop(); };
  }, [connection]);
  useEffect(() => store?.subscribe(() => {
    for (const item of store.getState().outline) {
      if (item.kind !== "tool") continue;
      const value = store.getItem(item.id) as { active?: boolean; is_error?: boolean; tool_call?: { name?: string } } | undefined;
      const name = value?.tool_call?.name ?? "";
      if (value && ["create_page", "achilles__create_page", "update_layout", "achilles__update_layout", "restore_version", "achilles__restore_version"].includes(name) && !value.active && !value.is_error && !completedCreatePages.current.has(item.id)) {
        completedCreatePages.current.add(item.id);
        setPageRefreshNonce((current) => current + 1);
        if (["update_layout", "achilles__update_layout", "restore_version", "achilles__restore_version"].includes(name)) void active.refreshPage();
      }
    }
  }), [active.refreshPage, store]);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void active.refreshPage();
  }, [refreshKey]);
  useEffect(() => {
    // A form insert does not advance refreshKey (no chat turn), so count metrics computed into
    // the page layout would stay stale; record list/detail blocks already refetch on their own
    // through useRecordWrites in LayoutBlock, so this only refreshes the page object itself.
    if (previousRecordWrites.current === recordWrites) return;
    previousRecordWrites.current = recordWrites;
    void active.refreshPage();
  }, [recordWrites]);
  useEffect(() => {
    if (ready?.sessionId) setFollowRequest((value) => value + 1);
  }, [ready?.sessionId]);
  // layout effect: the reset for a new store lands before paint, so the previous chat's control never shows for a frame
  useLayoutEffect(() => {
    const scroll = transcript?.querySelector<HTMLElement>('[data-part="timeline-scroll"]');
    if (!store || !scroll) return;
    return watchJumpToLatest(store, scroll, setShowJumpToLatest);
  }, [store, transcript]);
  useEffect(() => {
    const previous = previousTurn.current; previousTurn.current = turn;
    // A chat attached during a live turn re-sends its page binding as soon as it is idle, even if the edge was missed.
    if (turn === "idle" && (previous === "running" || ready?.rebind)) void active.settleAfterTurn();
  }, [active.settleAfterTurn, turn, ready?.rebind]);
  const lastState = activeLastState(waiting, outcome, turn);
  useEffect(() => { active.recordLastState(lastState); }, [active.recordLastState, lastState]);

  const connected = connectionState.phase === "connected";
  const shownToggleError = useRef(active.toggleError);
  useEffect(() => {
    // a successful retry removes the notice and its focused button; give focus back to the visible header control
    const hadNotice = shownToggleError.current !== null; shownToggleError.current = active.toggleError;
    if (!hadNotice || active.toggleError !== null || document.activeElement !== document.body) return;
    [...document.querySelectorAll<HTMLElement>(".chat-actions > button")].find((button) => button.offsetParent !== null)?.focus();
  }, [active.toggleError]);
  useEffect(() => {
    // zeta ends a running turn when this tab disconnects: a reload, a close, or a full page load (a sidebar page link,
    // or selectChat's location.assign to a chat on another page), so the browser asks first. an approval wait survives
    // a reload (zeta keeps it for 90 s), so it does not ask then.
    if (!connected || lastState !== "running") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [connected, lastState]);
  const approval = connected && client && store ? createApprovalDecider(client, store) : null;
  const appRenderers: Renderers = { ...renderers, approval: ({ id }) => <Approval id={id} disabledReason={!approval ? "zeta is offline" : undefined} onApprove={approval ? (request) => approval("approve", request) : undefined} onDeny={approval ? (request) => approval("deny", request) : undefined} /> };
  const failure = connectionFailure(connectionState);
  const lost = connectionState.phase !== "connected" && "lost" in connectionState && connectionState.lost;
  const composerProps = activeComposerProps(connected && Boolean(client), active.toggleBlocked, turn, send, () => { if (ready) void client?.request("abort", { session_id: ready.sessionId }); });
  // mirrors the final branch of `content` below: whichever states skip the composer must also relabel the skip link.
  const hasComposer = !active.creationError && active.state.phase !== "missing" && active.state.phase !== "error" && !(failure && !lost) && Boolean(activePage) && Boolean(activeStore);
  const content = <>
    {activePage && <ChatHeader page={activePage} sessionId={ready?.sessionId ?? null} title={ready?.title ?? "new chat"} state={lost ? "offline" : lastState} toggling={active.toggling} disabled={active.toggling || !connected} toggle={active.toggle} onRename={ready ? (id, text) => { void active.rename(id, text); } : undefined} />}
    {activePage && active.toggleError && <div className="create-mode-alert" role="alert"><span>{active.toggleError}</span>{active.toggleRetryable && <button type="button" disabled={active.toggling} onClick={active.toggle}>{active.toggling ? "retrying…" : "retry"}</button>}</div>}
    {lost && ready && failure && <ConnectionBanner state={connectionState} connection={connection} compact />}
    {active.busy && <BusyNotice busy={active.busy} openSessionId={ready?.sessionId ?? null} onOpen={active.openBusyChat} onRetry={active.retryBusy} />}
    {active.creationError ? <div className="full-state"><p role="alert">{active.creationError}</p><button className="primary" onClick={active.retrySaving}>retry creating chat</button></div>
      : active.state.phase === "missing" ? <div className="full-state"><p role="alert">this chat no longer exists</p><button className="primary" onClick={active.newChat}>new chat</button></div>
      : active.state.phase === "error" && active.state.error === "page not found" ? <NotFoundState onNewChat={active.newChat} />
      : active.state.phase === "error" ? <div className="full-state"><p role="alert">{active.state.error}</p></div>
      : busyPage ? <>{busyPage.page.layout.blocks.length > 0 && <div className="layout-blocks">{busyPage.page.layout.blocks.map((block, index) => <LayoutBlock key={index} block={block} pageId={busyPage.page.id} credential={busyPage.credential} refreshKey={refreshKey} />)}</div>}</>
      : failure && !lost ? <ConnectionBanner state={connectionState} connection={connection} />
      : !activePage || !activeStore ? <div className="full-state"><p role="status">{active.attachSlow ? "still connecting to this chat" : "loading chat…"}</p>{active.attachSlow && <button className="primary" type="button" onClick={active.retryAttachment}>Retry</button>}</div>
      : <RunProvider store={activeStore}>
        <div className={hasBlocks ? "page-view docked" : "page-view"}>
        {hasBlocks && <div className="layout-blocks">{activePage.layout.blocks.map((block, index) => <LayoutBlock key={index} block={block} pageId={activePage.id} credential={(ready ?? empty)!.credential} refreshKey={refreshKey} />)}</div>}
        <div className="page-chat">
        <section ref={ready ? setTranscript : undefined} className="transcript">{(!ready || Number(outlineLength) === 0) && <EmptyChat key={activePage.id} page={activePage} sessionId={ready?.sessionId ?? null} send={send} continueWaiting={active.continueWaitingChat} toggleCreateMode={active.toggle} credential={(ready ?? empty)!.credential} refreshKey={refreshKey} />}{ready && <Timeline renderers={appRenderers} virtual followRequest={followRequest} />}{ready && showJumpToLatest && <button type="button" data-part="jump-to-latest" onClick={() => { setFollowRequest((value) => value + 1); const scroll = transcript?.querySelector('[data-part="timeline-scroll"]'); scroll?.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" }); }}>jump to latest</button>}</section>
        <ComposerSlot key={ready?.sessionId ?? `new:${activePage.id}`} sessionId={ready?.sessionId ?? `new:${activePage.id}`} focus={!ready || active.focusSessionId === ready.sessionId} vim={settings.vim && !matchMedia("(pointer: coarse)").matches} props={composerProps} />
        </div>
        </div>
      </RunProvider>}
  </>;
  return <AppShell page={activePage} sessionId={ready?.sessionId ?? null} waiting={waiting} serverForcesAsk={(ready ?? empty)?.serverApprovalMode === "ask"} hasComposer={hasComposer} onNewChat={active.newChat} onToggleCreateMode={active.toggle} onSelectChat={active.selectChat} onRenameChat={(chat, text) => { void active.rename(chat.session_id, text); }} refreshKey={active.listRefresh} pageRefreshKey={pageRefreshNonce}>{content}</AppShell>;
}

function BusyNotice({ busy, openSessionId, onOpen, onRetry }: { busy: { sessionId: string | null; chat: { title: string | null; first_title?: string | null } | null }; openSessionId: string | null; onOpen: () => void; onRetry: () => void }) {
  const here = busy.sessionId !== null && busy.sessionId === openSessionId;
  const open = !here && busy.chat;
  const text = here ? "this chat is still running. approve or stop it, then try again."
    : open ? `"${titleOf(busy.chat!)}" is still running. open it to approve or stop it, then try again.`
    : busy.sessionId ? "another chat is still running. approve or stop it, then try again."
    : "zeta was busy a moment ago and is ready now. try again.";
  return <div className="create-mode-alert" role="alert"><span>{text}</span><span>{open && <button type="button" onClick={onOpen}>open it</button>}<button type="button" onClick={onRetry}>try again</button></span></div>;
}

function NotFoundState({ onNewChat }: { onNewChat: () => Promise<void> }) {
  return <div className="full-state not-found-state"><p role="alert">page not found</p><div><a className="primary" href="/">go home</a><button className="primary" onClick={() => void onNewChat()}>new chat</button></div></div>;
}

function ChatHeader({ page, sessionId, title, state, toggling, disabled, toggle, onRename }: { page: Page; sessionId: string | null; title: string; state: string; toggling: boolean; disabled: boolean; toggle: () => void; onRename?: (sessionId: string, title: string) => void }) {
  const [overflow, setOverflow] = useState(false);
  const overflowButton = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const closeOverflow = () => { setOverflow(false); overflowButton.current?.focus(); };
  useEffect(() => {
    // the open menu covers the notice below the header, so Escape (from anywhere) and a tap outside close it
    if (!overflow) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { setOverflow(false); overflowButton.current?.focus(); } };
    const onDown = (event: PointerEvent) => { if (!actions.current?.contains(event.target as Node)) setOverflow(false); };
    addEventListener("keydown", onKey);
    addEventListener("pointerdown", onDown);
    return () => { removeEventListener("keydown", onKey); removeEventListener("pointerdown", onDown); };
  }, [overflow]);
  const rename = useInlineRename();
  const startRename = () => { if (onRename && sessionId) rename.start(title === "new chat" ? "" : title, (value) => onRename(sessionId, value)); };
  // a chat switch closes the editor; its draft never moves to the next chat
  useEffect(() => rename.cancel, [sessionId]);
  useEffect(() => {
    if (!onRename) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F2" || rename.editing || isEditableTarget(event)) return;
      event.preventDefault();
      startRename();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onRename, rename.editing, sessionId, title]);
  const modeLabel = toggling ? `turning ${page.create_mode ? "off" : "on"} create mode…` : page.create_mode ? "create mode on" : "create mode off";
  const controls = (inMenu: boolean) => <><span className={`approval-mode mode-${page.approval_mode ?? "ask"}`} aria-label={page.approval_mode === "allow" ? "auto-approve" : "ask before tools"}>{page.approval_mode === "allow" ? "auto-approve" : "ask before tools"}</span><button type="button" aria-pressed={page.create_mode ? "true" : "false"} disabled={disabled} onClick={() => { if (inMenu) closeOverflow(); toggle(); }}>{modeLabel}</button></>;
  const titleNode = rename.editing
    ? <input className="chat-title-edit" aria-label="chat title" {...rename.bind()} />
    : <strong title={title} aria-label={title} data-session-id={sessionId ?? undefined} role={onRename ? "button" : undefined} tabIndex={onRename ? 0 : undefined} onClick={startRename} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startRename(); } }}>{title}</strong>;
  return <header className="chat-header"><div className="chat-heading">{titleNode}<span title={page.title} aria-label={page.title}>{page.title}</span></div><div className="chat-actions" ref={actions}>{controls(false)}<span className={`run-state state-${state}`}>{state === "approval" ? "waiting on you" : state}</span><button ref={overflowButton} className="header-overflow" aria-label="chat options" aria-expanded={overflow} onClick={() => setOverflow((value) => !value)}>•••</button>{overflow && <div className="header-menu">{controls(true)}</div>}</div></header>;
}

function ConnectionBanner({ state, connection, compact = false }: { state: ConnectionState; connection: Connection; compact?: boolean }) {
  const text = connectionFailure(state) ?? "connecting to zeta…";
  if (compact) { const seconds = "retryAt" in state ? Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000)) : null; return <div className="connection-banner" role="alert"><span>{text}{seconds !== null && ` reconnecting in ${seconds}s…`} the transcript below is the last copy; your draft is kept.</span><button onClick={() => connection.retryNow()}>retry now</button></div>; }
  const command = `zeta serve --ws ${connection.port} --ws-origin ${location.origin}`;
  return <section className="full-state connection-state" role="alert"><p><span className="danger-mark" />{text}{"attempt" in state && <span className="attempt-count"> · tried {state.attempt} times</span>}</p><h1>{state.phase === "not_running" ? "start zeta, and this page connects by itself." : text}</h1>{state.phase === "not_running" && <div className="command"><span>shell</span><button onClick={() => navigator.clipboard.writeText(command)}>copy</button><code>$ {command}</code></div>}<button className="primary" onClick={() => connection.retryNow()}>retry now</button></section>;
}

export function LayoutBlock({ block, pageId, credential, refreshKey: chatRefreshKey }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string }) {
  const refreshKey = `${chatRefreshKey}:${useRecordWrites(pageId)}`;
  if (block.type === "text") return <p>{String(block.text)}</p>;
  if (block.type === "metric") return <p className="layout-metric"><strong>{String(block.label)}:</strong> {String(block.value)}</p>;
  if (block.type === "list") return <RecordList key={`${pageId}:${String(block.collection)}`} title={String(block.title)} collection={String(block.collection)} pageId={pageId} credential={credential} refreshKey={refreshKey} />;
  if (block.type === "detail") {
    const fields = Array.isArray(block.fields) ? block.fields.map(String) : [];
    const filter = block.filter as DetailFilter | undefined;
    if (filter && typeof block.collection === "string") return <DetailRecord title={String(block.title)} collection={block.collection} fields={fields} filter={filter} pageId={pageId} credential={credential} refreshKey={refreshKey} />;
    return <p>{String(block.title)}: {fields.join(", ")}</p>;
  }
  if (block.type === "form") return <FormBlock key={`${pageId}:${String(block.tool)}`} title={String(block.title)} toolName={String(block.tool)} pageId={pageId} credential={credential} refreshKey={chatRefreshKey} />;
  return null;
}
export function RecordList({ title, collection, pageId, credential, refreshKey }: { title: string; collection: string; pageId: string; credential: string; refreshKey: string }) {
  const [records, setRecords] = useState<Record<string, unknown>[] | null>(null); const [total, setTotal] = useState(0); const [error, setError] = useState<string | null>(null); const requestSequence = useRef(0);
  useEffect(() => { let live = true; const request = ++requestSequence.current; void fetch(`/api/pages/${pageId}/records/${encodeURIComponent(collection)}?limit=100`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(`could not load records (${response.status})`); const value = await response.json(); if (!Array.isArray(value)) throw new Error("invalid records response"); if (live && request === requestSequence.current) { setRecords(value); setTotal(Number(response.headers.get("x-achilles-total") ?? value.length)); setError(null); } }).catch((caught) => { if (live && request === requestSequence.current) setError(caught instanceof Error ? caught.message : String(caught)); }); return () => { live = false; }; }, [collection, credential, pageId, refreshKey]);
  const selected = useSelectedRow(pageId);
  const selectedId = selected?.collection === collection ? selected.record.record_id : undefined;
  return <RecordListView title={title} records={records} total={total} error={error} selectedId={selectedId} onSelect={(record) => selectRow(pageId, record && { collection, record })} />;
}

export function RecordListView({ title, records, total, error, selectedId, onSelect }: { title: string; records: Record<string, unknown>[] | null; total: number; error: string | null; selectedId?: unknown; onSelect?: (record: Record<string, unknown> | null) => void }) {
  const loadedRecords = records ?? [];
  // revision is internal (it guards saves); record_id goes last and muted
  const columns = [...new Set(loadedRecords.flatMap((record) => Object.keys(record).filter((key) => key !== "record_id" && key !== "revision")))]; if (loadedRecords.some((record) => "record_id" in record)) columns.push("record_id");
  const loading = records === null && !error;
  const onKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, record: Record<string, unknown>) => {
    const row = event.currentTarget;
    if (event.key === "Enter" || event.key === " ") onSelect?.(record);
    else if (event.key === "Escape") onSelect?.(null);
    else if (event.key === "ArrowDown") (row.nextElementSibling as HTMLElement | null)?.focus();
    else if (event.key === "ArrowUp") (row.previousElementSibling as HTMLElement | null)?.focus();
    else return;
    event.preventDefault();
  };
  return <section className="record-list" aria-busy={loading}><h2>{title}</h2>{error ? <p role="alert">{error}</p> : loading ? <p role="status">loading records…</p> : loadedRecords.length === 0 ? <p>no records yet</p> : <><table role={onSelect ? "grid" : undefined} aria-label={title}><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{loadedRecords.map((record, index) => <tr key={String(record.record_id ?? index)} {...onSelect && { tabIndex: 0, "aria-selected": record.record_id === selectedId, onClick: () => onSelect(record), onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => onKeyDown(event, record) }}>{columns.map((column) => <td key={column} className={column === "record_id" ? "record-id" : undefined}>{formatRecordValue(record[column])}</td>)}</tr>)}</tbody></table>{total > 100 && <p>showing newest 100 of {total}</p>}</>}</section>;
}
function formatRecordValue(value: unknown): string { return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""); }
