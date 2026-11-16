import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRunStore } from "@fulcrum/core";
import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { CodeFence } from "./chat/CodeFence";
import { Approval, Fallback, Message, RunProvider, Timeline, ToolCall, useItem, type ComposerProps, type Renderers } from "@fulcrum/react";
import { AppShell, titleOf } from "./AppShell";
import { PlainComposer } from "./composer/PlainComposer";
import { chatQueues } from "./composer/chatQueues";
import { MAYBE_SENT_LABEL } from "./composer/composer-machine";
import { draftStore } from "./draftStore";
import { DetailRecord, type DetailFilter } from "./DetailRecord";
import { FormBlock, refreshSelection, selectRow, useRecordWrites, useSelectedRow } from "./page/RecordForm";
import { extendWithRecordKeys, recordColumns, schemaColumns } from "./page/listColumns";
import { usePageTools, type PageTool } from "./page/usePageTools";
import { HistoryDialog } from "./page/HistoryDialog";
import { PageView } from "./page/PageView";
import { EmptyChat } from "./EmptyChat";
import { isEditableTarget, keyboardFocusToComposer } from "./keyboard";
import { useSettings } from "./settings";
import { createApprovalDecider } from "./zeta/approvals";
import { backoff, createConnection, supportsFeature, type Connection, type ConnectionState } from "./zeta";
import { trackQueuedSteer, useActiveChat, type Page } from "./useActiveChat";
import { useInlineRename } from "./useInlineRename";
import { watchJumpToLatest } from "./jumpToLatest";
import "./style.css";
import "./chat/markdown.css";
import "./shell.css";
import "./page/page.css";

const highlight = createHighlighter();
addEventListener("pagehide", () => highlight.dispose(), { once: true });
const fences: Fences = new Proxy({}, { get: () => CodeFence });
const RichMarkdown = (props: MarkdownProps) => <Markdown {...props} highlight={highlight} fences={fences} />;
const renderers: Renderers = { message: ({ id }) => <Message id={id} markdown={RichMarkdown} />, tool: ({ id }) => <ToolCall id={id} />, error: ({ id }) => <Fallback id={id} /> };
// a steer zeta accepted but has not delivered yet shows once: in the composer with its "queued" status, not as a bubble
// inside the reply that is still streaming. it shows here once delivery settles.
function UserRow({ id, queued }: { id: string; queued: ReadonlySet<string> }) {
  const item = useItem(id);
  const event = item?.type === "user" && item.event.type === "user_message" ? item.event : undefined;
  if (event?.mode === "steer" && event.delivery_id && !event.delivery_status && queued.has(event.delivery_id)) return null;
  return <Fallback id={id} />;
}

const LazyVimComposer = lazy(() => import("./composer/VimComposer").then(({ VimComposer }) => ({ default: VimComposer })));

type ComposerActivity = { sending: boolean; queued: number; failed: boolean; held: boolean };

// `fromNewChat`: this chat is unsent, so it takes the page's new-chat queue owner if that owner's first send created it
function ComposerSlot({ sessionId, fromNewChat, focus, vim, questionWaiting, props, onActivity }: { sessionId: string; fromNewChat?: string; focus: boolean; vim: boolean; questionWaiting: boolean; props: ComposerProps; onActivity: (activity: ComposerActivity) => void }) {
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
    onDraftSubmit: (sent: string) => draftStore.confirm(sessionId, sent),
    chatId: sessionId,
    fromNewChat,
    onActivity,
    questionWaiting,
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

// the header shows what the user is waiting on: an approval first, another chat's turn, then their own messages, then
// the turn. `chat`: false while no message of this chat reached zeta (no chat yet, or one made but never sent to): its
// unsent rows say "not sent" themselves, and the chat has nothing that is not sent
function headerState(lost: boolean, lastState: string, outcome: string, activity: ComposerActivity, busy: boolean, chat: boolean) {
  if (lost) return "offline";
  if (lastState === "approval") return lastState;
  if (busy) return "waiting";
  if (activity.held) return "maybe-unsent";
  if (activity.failed && chat) return "unsent";
  if (activity.queued) return "queued";
  if (activity.sending && lastState !== "running") return "sending";
  return lastState === "idle" && (outcome === "cancelled" || outcome === "disconnected") ? "stopped" : lastState;
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
  // a restore from the history list changes the layout or a tool without a chat turn
  const [restores, setRestores] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyOpener = useRef<HTMLElement | null>(null);
  const refreshKey = `${completedTurns}:${completedTools}:${restores}`;
  const previousRefreshKey = useRef(refreshKey);
  const waiting = Number(approvalCount);
  const [followRequest, setFollowRequest] = useState(0);
  const [pageRefreshNonce, setPageRefreshNonce] = useState(0);
  const completedCreatePages = useRef(new Set<string>());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [transcript, setTranscript] = useState<HTMLElement | null>(null);
  const [queuedSteers, setQueuedSteers] = useState<ReadonlySet<string>>(new Set());
  const [composerActivity, setComposerActivity] = useState<ComposerActivity>({ sending: false, queued: 0, failed: false, held: false });
  // after every composer of this commit has attached to its chat's queue owner
  useLayoutEffect(() => chatQueues.settle());
  const send: typeof active.send = (text, intent, track) => {
    setFollowRequest((value) => value + 1);
    return trackQueuedSteer(
      (queue) => active.send(text, intent, queue),
      (id) => { track(id); setQueuedSteers((ids) => new Set(ids).add(id)); },
      (id) => setQueuedSteers((ids) => { const next = new Set(ids); next.delete(id); return next; }),
    );
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
    // fulcrum's scroll box takes no focus, and webkit never focuses a scroller by itself: ArrowUp/PageUp could not scroll it
    scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", "transcript");
    // webkit scrolls a focused box on PageUp but not on the arrows; a row's own ArrowUp/ArrowDown (row navigation) is not the box's
    const arrows = (event: KeyboardEvent) => {
      if (event.target !== scroll || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      scroll.scrollBy({ top: event.key === "ArrowUp" ? -40 : 40 });
    };
    scroll.addEventListener("keydown", arrows);
    const stop = watchJumpToLatest(store, scroll, setShowJumpToLatest, () => setFollowRequest((value) => value + 1));
    return () => { scroll.removeEventListener("keydown", arrows); stop(); };
  }, [store, transcript]);
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
    // without `turn_reconnect`, zeta ends a running turn when this tab disconnects: a reload, a close, or a full page
    // load (a sidebar page link, or selectChat's location.assign to a chat on another page), so the browser asks first.
    // with it, zeta keeps the turn for 90 s and the next page load takes it over, like an approval wait, so it does
    // not ask; the browser cannot tell a reload from a close, and only a close (nobody back in 90 s) ends the turn.
    if (!connected || lastState !== "running" || (client && supportsFeature(client, "turn_reconnect"))) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [connected, lastState, client]);
  const approval = connected && client && store ? createApprovalDecider(client, store) : null;
  const appRenderers: Renderers = { ...renderers, user: ({ id }) => <UserRow id={id} queued={queuedSteers} />, approval: ({ id }) => <Approval id={id} disabledReason={!approval ? "zeta is offline" : undefined} onApprove={approval ? (request) => approval("approve", request) : undefined} onDeny={approval ? (request) => approval("deny", request) : undefined} /> };
  const failure = connectionFailure(connectionState);
  const lost = connectionState.phase !== "connected" && "lost" in connectionState && connectionState.lost;
  const composerProps: ComposerProps = active.creatingChat ? { state: "read-only", reason: "send waits until the new chat is ready", onSubmit: send, placeholder: "message zeta" }
    : activeComposerProps(connected && Boolean(client), active.toggleBlocked, turn, send, () => { if (ready) void client?.request("abort", { session_id: ready.sessionId }); });
  // mirrors the final branch of `content` below: whichever states skip the composer must also relabel the skip link.
  const hasComposer = !active.creationError && active.state.phase !== "missing" && active.state.phase !== "error" && !(failure && !lost) && Boolean(activePage) && Boolean(activeStore);
  // rows typed in the new-chat box that no chat took (a refused create): the page opens another chat, so say they wait
  const unsentNew = ready ? chatQueues.unsent(`new:${ready.page.id}`).length : 0;
  // a failed create keeps the message typed for it in the page's new-chat box: show it, so the user sees it is safe
  const keptNew = active.creationError && active.creationPageId ? chatQueues.unsent(`new:${active.creationPageId}`) : [];
  const content = <>
    {activePage && <ChatHeader page={activePage} sessionId={ready?.sessionId ?? null} title={ready?.title ?? "new chat"} state={headerState(lost, lastState, outcome, composerActivity, Boolean(active.busy), Boolean(ready?.sent))} queued={composerActivity.queued} toggling={active.toggling} disabled={active.toggling || !connected || active.creatingChat} toggle={active.toggle} onRename={ready ? (id, text) => { void active.rename(id, text); } : undefined} onHistory={(opener) => { historyOpener.current = opener; setHistoryOpen(true); }} />}
    {activePage && historyOpen && <HistoryDialog key={activePage.id} pageId={activePage.id} credential={(ready ?? empty)!.credential} createMode={activePage.create_mode} opener={historyOpener} onClose={() => setHistoryOpen(false)} onChanged={() => setRestores((value) => value + 1)} />}
    {activePage && active.toggleError && <div className="create-mode-alert" role="alert"><span>{active.toggleError}</span>{active.toggleRetryable && <button type="button" disabled={active.toggling} onClick={active.toggle}>{active.toggling ? "retrying…" : "retry"}</button>}</div>}
    {lost && ready && failure && <ConnectionBanner state={connectionState} connection={connection} compact />}
    {unsentNew > 0 && <div className="create-mode-alert" role="status"><span>{unsentNew === 1 ? "1 unsent message" : `${unsentNew} unsent messages`} for a new chat</span><button type="button" onClick={active.openNewChat}>open</button></div>}
    {active.busy && <BusyNotice busy={active.busy} openSessionId={ready?.sessionId ?? null} onOpen={active.openBusyChat} onRetry={active.retryBusy} />}
    {active.creationError ? <div className="full-state"><p role="alert">{active.creationError}</p>{keptNew.map((text, index) => <figure key={index} className="kept-message"><figcaption>kept, not sent</figcaption><blockquote>{text}</blockquote></figure>)}<div className="full-state-actions"><button className="primary" autoFocus onClick={(event) => { event.currentTarget.focus(); active.retrySaving(); }}>retry creating chat</button><button type="button" onClick={active.discardCreation}>start over</button></div></div>
      : active.state.phase === "missing" ? <div className="full-state"><p role="alert">this chat no longer exists</p><button className="primary" onClick={active.newChat}>new chat</button></div>
      : active.state.phase === "error" && active.state.error === "page not found" ? <NotFoundState onNewChat={active.newChat} />
      : active.state.phase === "error" ? <div className="full-state"><p role="alert">{active.state.error}</p></div>
      : busyPage ? <>{busyPage.page.layout.blocks.length > 0 && <PageView page={busyPage.page} pageId={busyPage.page.id} credential={busyPage.credential} refreshKey={`${refreshKey}:${pageRefreshNonce}`} />}</>
      : failure && !lost ? <ConnectionBanner state={connectionState} connection={connection} />
      : !activePage || !activeStore ? <div className="full-state"><p role="status">{active.attachSlow ? "still connecting to this chat" : "loading chat…"}</p>{active.attachSlow && <button className="primary" type="button" onClick={active.retryAttachment}>Retry</button>}</div>
      : <RunProvider store={activeStore}>
        <div className={hasBlocks ? "page-view docked" : "page-view"}>
        {hasBlocks && <PageView page={activePage} pageId={activePage.id} credential={(ready ?? empty)!.credential} refreshKey={`${refreshKey}:${pageRefreshNonce}`} />}
        <div className="page-chat">
        <section ref={ready ? setTranscript : undefined} className="transcript">{active.creatingChat ? <div className="full-state"><p role="status">creating chat…</p></div> : (!ready || Number(outlineLength) === 0) && <EmptyChat key={activePage.id} page={activePage} sessionId={ready?.sessionId ?? null} send={send} continueWaiting={active.continueWaitingChat} toggleCreateMode={active.toggle} credential={(ready ?? empty)!.credential} refreshKey={refreshKey} />}{ready && <Timeline renderers={appRenderers} virtual followRequest={followRequest} />}{ready && showJumpToLatest && <button type="button" data-part="jump-to-latest" onMouseDown={(event) => event.preventDefault()} onClick={(event) => {
          // the button unmounts once the reader is at the bottom; a mouse click must not take focus from where it was (the composer)
          keyboardFocusToComposer(event);
          setFollowRequest((value) => value + 1);
          const scroll = transcript?.querySelector('[data-part="timeline-scroll"]');
          scroll?.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
        }}>jump to latest</button>}</section>
        <ComposerSlot key={ready?.sessionId ?? `new:${activePage.id}`} sessionId={ready?.sessionId ?? `new:${activePage.id}`} fromNewChat={ready && !ready.sent ? `new:${activePage.id}` : undefined} onActivity={setComposerActivity} focus={!active.creatingChat && (!ready || active.focusSessionId === ready.sessionId)} vim={settings.vim && !matchMedia("(pointer: coarse)").matches} questionWaiting={waiting > 0} props={composerProps} />
        </div>
        </div>
      </RunProvider>}
  </>;
  return <AppShell page={activePage} sessionId={ready?.sessionId ?? null} waiting={waiting} serverForcesAsk={(ready ?? empty)?.serverApprovalMode === "ask"} hasComposer={hasComposer} onNewChat={active.newChat} onToggleCreateMode={active.toggle} onSelectChat={active.selectChat} onRenameChat={(chat, text) => { void active.rename(chat.session_id, text); }} refreshKey={active.listRefresh} pageRefreshKey={pageRefreshNonce}>{content}</AppShell>;
}

function BusyNotice({ busy, openSessionId, onOpen, onRetry }: { busy: { sessionId: string | null; chat: { title: string | null; first_title?: string | null } | null; retry: "attach" | "new" }; openSessionId: string | null; onOpen: () => void; onRetry: () => void }) {
  const here = busy.sessionId !== null && busy.sessionId === openSessionId;
  const open = !here && busy.chat;
  const running = open ? `"${titleOf(busy.chat!)}"` : "another chat";
  const text = busy.retry === "new" && busy.sessionId ? `${running} is still running, so zeta cannot start a new chat yet. a message sent here stays unsent; retry it when that chat ends.`
    : here ? "this chat is still running. approve or stop it, then try again."
    : open ? `"${titleOf(busy.chat!)}" is still running. open it to approve or stop it, then try again.`
    : busy.sessionId ? "another chat is still running. approve or stop it, then try again."
    : "zeta was busy a moment ago and is ready now. try again.";
  return <div className="create-mode-alert" role="alert"><span>{text}</span><span>{open && <button type="button" onClick={onOpen}>open it</button>}<button type="button" onClick={onRetry}>try again</button></span></div>;
}

function NotFoundState({ onNewChat }: { onNewChat: () => Promise<void> }) {
  return <div className="full-state not-found-state"><p role="alert">page not found</p><div><a className="primary" href="/">go home</a><button className="primary" onClick={() => void onNewChat()}>new chat</button></div></div>;
}

function ChatHeader({ page, sessionId, title, state, queued, toggling, disabled, toggle, onRename, onHistory }: { page: Page; sessionId: string | null; title: string; state: string; queued: number; toggling: boolean; disabled: boolean; toggle: () => void; onRename?: (sessionId: string, title: string) => void; onHistory: (opener: HTMLElement | null) => void }) {
  const [overflow, setOverflow] = useState(false);
  const overflowButton = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const closeOverflow = () => { setOverflow(false); overflowButton.current?.focus(); };
  useEffect(() => {
    // the open menu covers the notice below the header, so Escape (from anywhere, even a table row that handles it:
    // capture runs first), a tap outside, and focus moving outside (Tab) close it
    if (!overflow) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOverflow(false);
      if (actions.current?.contains(document.activeElement)) overflowButton.current?.focus();
    };
    const onDown = (event: PointerEvent) => { if (!actions.current?.contains(event.target as Node)) setOverflow(false); };
    // focus landing anywhere outside, not focus leaving the box: WebKit does not focus a clicked •••, so focus may never enter it
    const onFocusIn = (event: FocusEvent) => { if (!actions.current?.contains(event.target as Node)) setOverflow(false); };
    addEventListener("keydown", onKey, true);
    addEventListener("pointerdown", onDown);
    addEventListener("focusin", onFocusIn);
    return () => { removeEventListener("keydown", onKey, true); removeEventListener("pointerdown", onDown); removeEventListener("focusin", onFocusIn); };
  }, [overflow]);
  const rename = useInlineRename();
  const titleControl = useRef<HTMLElement>(null);
  const startRename = () => { if (onRename && sessionId) rename.start(title === "new chat" ? "" : title, (value) => onRename(sessionId, value)); };
  // enter or esc unmounts the editor and drops focus to <body>; hand it back to the title. deferred past the focus
  // change, so a blur commit by a click elsewhere keeps the clicked control's focus.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (rename.editing) { wasEditing.current = true; return; }
    if (!wasEditing.current) return;
    wasEditing.current = false;
    const timer = setTimeout(() => { if (document.activeElement === document.body) titleControl.current?.focus(); });
    return () => clearTimeout(timer);
  }, [rename.editing]);
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
  const modeLabel = toggling ? `turning ${page.create_mode ? "off" : "on"} create mode…` : `◻ create mode${page.create_mode ? " on" : ""}`;
  const controls = (inMenu: boolean, withHistory = true) => <><span className={`approval-mode mode-${page.approval_mode ?? "ask"}`} aria-label={page.approval_mode === "allow" ? "auto-approve" : "ask before tools"}>{page.approval_mode === "allow" ? "auto-approve" : "ask before tools"}</span><button type="button" aria-label={toggling ? modeLabel : page.create_mode ? "create mode on" : "create mode off"} aria-pressed={page.create_mode ? "true" : "false"} disabled={disabled} onClick={() => { if (inMenu) closeOverflow(); toggle(); }}>{modeLabel}</button>{withHistory && <button type="button" onClick={(event) => { if (inMenu) closeOverflow(); onHistory(inMenu ? overflowButton.current : event.currentTarget); }}>history</button>}</>;
  const titleNode = rename.editing
    ? <input className="chat-title-edit" aria-label="chat title" {...rename.bind()} />
    : <strong ref={titleControl} title={title} aria-label={title} data-session-id={sessionId ?? undefined} role={onRename ? "button" : undefined} tabIndex={onRename ? 0 : undefined} onClick={startRename} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startRename(); } }}>{title}</strong>;
  // the fold hides the full controls into the ••• menu below 64em, but an enabled mode must stay visible
  // without opening it (spec.md:36, :109): a short word mark per mode that is on sits beside •••.
  // when the header is tight the CSS-hidden .fold-long parts drop: "auto-approve" becomes "auto" and
  // "create mode" becomes its hollow square alone; role="img" plus aria-label keeps the full name for screen readers.
  const autoApprove = page.approval_mode === "allow";
  const foldMarkers = (autoApprove || page.create_mode) && <span className="fold-indicator">{autoApprove && <span className="fold-mark fold-mark-approve" role="img" aria-label="auto-approve is on" title="auto-approve is on">auto<span className="fold-long">-approve</span></span>}{page.create_mode && <span className="fold-mark fold-mark-create" role="img" aria-label="create mode is on" title="create mode is on"><span className="fold-long">create mode</span></span>}</span>;
  const routeLabel = page.route === "/" ? "home" : page.route.replace(/^\//, "");
  return <header className="chat-header"><div className="chat-heading"><span title={routeLabel} aria-label={routeLabel}>{routeLabel} /</span>{titleNode}</div><div className="chat-actions" ref={actions}>{controls(false, false)}<div className="header-status"><span className={`run-state state-${state}`} role="status">{state === "approval" ? "needs you" : state === "unsent" ? "not sent" : state === "maybe-unsent" ? MAYBE_SENT_LABEL : state === "queued" && queued > 1 ? `${queued} queued` : state}</span>{foldMarkers}</div><button type="button" onClick={(event) => onHistory(event.currentTarget)}>history</button><button ref={overflowButton} className="header-overflow" aria-label="chat options" aria-expanded={overflow} onClick={() => setOverflow((value) => !value)}>•••</button>{overflow && <div className="header-menu">{controls(true)}</div>}</div></header>;
}

const connectionHeadings: Partial<Record<ConnectionState["phase"], string>> = {
  not_running: "start zeta, and this page connects by itself.",
  controller_taken: "zeta is busy elsewhere",
  auth_failed: "zeta refused this page",
  incompatible: "zeta version mismatch",
};

function ConnectionBanner({ state, connection, compact = false }: { state: ConnectionState; connection: Connection; compact?: boolean }) {
  const text = connectionFailure(state) ?? "connecting to zeta…";
  if (compact) { const seconds = "retryAt" in state ? Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000)) : null; return <div className="connection-banner" role="alert"><span>{text}{seconds !== null && ` reconnecting in ${seconds}s…`} the transcript below is the last copy; your draft is kept.</span><button onClick={() => connection.retryNow()}>retry now</button></div>; }
  const command = connection.startCommand;
  // a short heading, the full sentence as body text; the time of the last try (not a rising attempt
  // count alone, which read as a failure) plus the count itself, so a click has something to confirm it worked.
  const heading = connectionHeadings[state.phase];
  const attempt = "attempt" in state ? state.attempt : 0;
  const status = "retryAt" in state
    ? <>retrying by itself · last try <span className="local-time">{new Date(state.retryAt - backoff(attempt)).toLocaleTimeString().toLowerCase()}</span> · tried {attempt} time{attempt === 1 ? "" : "s"}</>
    : "retrying…";
  return <section className="full-state connection-state" role="alert"><p><span className="retry-mark" />{status}</p><h1>{heading ?? text}</h1>{heading && <p className="connection-detail">{text}</p>}{state.phase === "not_running" && <div className="command"><span>shell</span><button onClick={() => navigator.clipboard.writeText(command)}>copy</button><code>$ {command}</code></div>}<button className="primary" onClick={() => connection.retryNow()}>retry now</button></section>;
}

export function LayoutBlock({ block, pageId, credential, refreshKey: chatRefreshKey }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string }) {
  const refreshKey = `${chatRefreshKey}:${useRecordWrites(pageId)}`;
  if (block.type === "text") return <p>{String(block.text)}</p>;
  if (block.type === "metric") return <p className="layout-metric"><strong>{String(block.label)}:</strong> {String(block.value)}</p>;
  if (block.type === "list") return <ListBlock block={block} pageId={pageId} credential={credential} refreshKey={refreshKey} toolsKey={chatRefreshKey} />;
  if (block.type === "detail") {
    const fields = Array.isArray(block.fields) ? block.fields.map(String) : [];
    const filter = block.filter as DetailFilter | undefined;
    if (filter && typeof block.collection === "string") return <DetailRecord title={String(block.title)} collection={block.collection} fields={fields} filter={filter} pageId={pageId} credential={credential} refreshKey={refreshKey} />;
    return <p>{String(block.title)}: {fields.join(", ")}</p>;
  }
  if (block.type === "form") return <FormBlock key={`${pageId}:${String(block.tool)}`} title={String(block.title)} toolName={String(block.tool)} fields={Array.isArray(block.fields) ? block.fields.map(String) : undefined} pageId={pageId} credential={credential} refreshKey={chatRefreshKey} />;
  return null;
}

function ListBlock({ block, pageId, credential, refreshKey, toolsKey }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string; toolsKey: string }) {
  const key = `${pageId}:${String(block.collection)}`;
  const list = { title: String(block.title), collection: String(block.collection), pageId, credential, refreshKey, filter: block.filter as DetailFilter | undefined };
  return Array.isArray(block.fields) && block.fields.length > 0 ? <RecordList key={key} {...list} columns={block.fields.map(String)} /> : <SchemaRecordList key={key} {...list} toolsKey={toolsKey} />;
}

// Shares the page's tool list fetch with forms (same key), and keeps the last list so a chat turn does not blank the table.
function SchemaRecordList({ toolsKey, ...list }: { title: string; collection: string; pageId: string; credential: string; refreshKey: string; filter?: DetailFilter; toolsKey: string }) {
  const { tools, error } = usePageTools(list.pageId, list.credential, toolsKey);
  const last = useRef<PageTool[] | null>(null);
  if (tools !== null) last.current = tools;
  const shown = tools ?? last.current;
  return <RecordList {...list} columns={shown ? schemaColumns(shown, list.collection) : error ? [] : null} extendColumns />;
}

// columns: null while they load; empty falls back to the record keys, sorted. extendColumns means
// columns is the schema's own list, not an explicit `fields` choice: record keys the schema does not
// name are appended, sorted, so the table never hides data the record actually has.
export function RecordList({ title, collection, pageId, credential, refreshKey, filter, columns = [], extendColumns = false }: { title: string; collection: string; pageId: string; credential: string; refreshKey: string; filter?: DetailFilter; columns?: string[] | null; extendColumns?: boolean }) {
  const query = new URLSearchParams({ ...filter && { field: filter.field, equals: JSON.stringify(filter.equals) }, limit: "100" }).toString();
  const [records, setRecords] = useState<Record<string, unknown>[] | null>(null); const [total, setTotal] = useState(0); const [error, setError] = useState<string | null>(null); const requestSequence = useRef(0);
  useEffect(() => { let live = true; const request = ++requestSequence.current; void fetch(`/api/pages/${pageId}/records/${encodeURIComponent(collection)}?${query}`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(`could not load records (${response.status})`); const value = await response.json(); if (!Array.isArray(value)) throw new Error("invalid records response"); if (live && request === requestSequence.current) { setRecords(value); refreshSelection(pageId, collection, value); setTotal(Number(response.headers.get("x-achilles-total") ?? value.length)); setError(null); } }).catch((caught) => { if (live && request === requestSequence.current) setError(caught instanceof Error ? caught.message : String(caught)); }); return () => { live = false; }; }, [collection, credential, pageId, query, refreshKey]);
  const selected = useSelectedRow(pageId);
  const selectedId = selected?.collection === collection ? selected.record.record_id : undefined;
  return <RecordListView title={title} collection={collection} records={records} columns={columns} extendColumns={extendColumns} total={total} error={error} selectedId={selectedId} onSelect={(record, row) => selectRow(pageId, record && { collection, record, opener: row })} />;
}

export function RecordListView({ title, collection, records, columns: chosen = [], extendColumns = false, total, error, selectedId, onSelect }: { title: string; collection?: string; records: Record<string, unknown>[] | null; columns?: string[] | null; extendColumns?: boolean; total: number; error: string | null; selectedId?: unknown; onSelect?: (record: Record<string, unknown> | null, row: HTMLElement) => void }) {
  const loadedRecords = records ?? [];
  // roving tabindex: one row is the table's tab stop (the last focused row, else the selected one, else the first); arrows move between rows
  const [focusedId, setFocusedId] = useState<unknown>(undefined);
  const has = (id: unknown) => id !== undefined && loadedRecords.some((record) => record.record_id === id);
  const tabStop = has(focusedId) ? focusedId : has(selectedId) ? selectedId : loadedRecords[0]?.record_id;
  const columns = !chosen?.length ? recordColumns(loadedRecords) : extendColumns ? extendWithRecordKeys(chosen, loadedRecords) : chosen;
  const loading = (records === null || chosen === null) && !error;
  const onKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, record: Record<string, unknown>) => {
    const row = event.currentTarget;
    if (event.key === "Enter" || event.key === " ") onSelect?.(record, row);
    else if (event.key === "Escape") onSelect?.(null, row);
    else if (event.key === "ArrowDown") (row.nextElementSibling as HTMLElement | null)?.focus();
    else if (event.key === "ArrowUp") (row.previousElementSibling as HTMLElement | null)?.focus();
    else return;
    event.preventDefault();
  };
  return <section className="record-list" aria-busy={loading}><h2>{title}</h2>{error ? <p role="alert">{error}</p> : loading ? <p role="status">loading records…</p> : loadedRecords.length === 0 ? <p>no records yet</p> : <><table role={onSelect ? "grid" : undefined} aria-label={title} data-collection={collection}><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{loadedRecords.map((record, index) => <tr key={String(record.record_id ?? index)} data-record-id={record.record_id == null ? undefined : String(record.record_id)} {...onSelect && { tabIndex: record.record_id === tabStop ? 0 : -1, "aria-selected": record.record_id === selectedId, onFocus: () => setFocusedId(record.record_id), onClick: (event: React.MouseEvent<HTMLTableRowElement>) => onSelect(record, event.currentTarget), onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => onKeyDown(event, record) }}>{columns.map((column) => <td key={column}>{formatRecordValue(record[column])}</td>)}</tr>)}</tbody></table>{total > 100 && <p>showing newest 100 of {total}</p>}</>}</section>;
}
function formatRecordValue(value: unknown): string { return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""); }
