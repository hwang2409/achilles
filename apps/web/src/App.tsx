import { AccountSwitchReceipt } from "./accounts/AccountSwitchReview";
import type { createAccountLogin } from "./accounts/accountLogin";
import { PageChatHeader } from "./PageChatHeader";
import { createContext, useContext, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRunStore } from "@fulcrum/core";
import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { CodeFence } from "./chat/CodeFence";
import { CompactTool, ToolDisclosure } from "./chat/CompactTool";
import { Approval, Fallback, Message, Notification, RunProvider, Timeline, useItem, type ComposerProps, type Renderers } from "@fulcrum/react";
import type { ZetaClient } from "@fulcrum/zeta";
import type { RenderShell } from "./surface/SurfaceRouter";
import { titleOf, useAgentNavAdapter } from "./surface/AgentNavAdapter";
import { surfaceHref, approvalIntent, chatsRoute, createRoute, pagesRoute, type SurfaceRoute } from "./surface/routes";
import { CreateLanding } from "./create/CreateLanding";
import type { CreateModeOwner } from "./create/createMode";
import { AuthErrorRecovery } from "./chat/AuthErrorRecovery";
import { CommandOutput, useComposerCommands } from "./composer/ComposerCommands";
import { PlainComposer } from "./composer/PlainComposer";
import { ComposerModes } from "./composer/ComposerModes";
import { parseDefaults } from "./settings/SettingsModule";
import { chatQueues } from "./composer/chatQueues";
import { MAYBE_SENT_LABEL } from "./composer/composer-machine";
import { draftStore } from "./draftStore";
import { HistoryDialog } from "./page/HistoryDialog";
import { useRecordWrites } from "./page/RecordForm";
import { PageView } from "./page/PageView";
import { EmptyChat } from "./EmptyChat";
import { isEditableTarget, keyboardFocusToComposer, useModalFocus } from "./keyboard";
import { useSettings } from "./settings";
import { createApprovalDecider } from "./zeta/approvals";
import { backoff, supportsFeature, type Connection, type ConnectionState } from "./zeta";
import { trackQueuedSteer, useActiveChat, type Page } from "./useActiveChat";
import { useInlineRename } from "./useInlineRename";
import { watchJumpToLatest } from "./jumpToLatest";
import "./style.css";
import { continuationNotification } from "./chat/continuation";
import "./chat/continuation.css";
import "./shell.css";
import "./chat/transcript.css";
import "./composer/composer.css";
import "./chat/markdown.css";
import "./chat/fulcrum-g1.css";
import { READ_ONLY_REASON, WRITE_SURFACE } from "./writeSurfaces";
import "./jumpToLatest.css";

export { LayoutBlock, PageView, RecordList, RecordListView } from "./page/PageView";

export const canWriteForState = (state: ConnectionState) => state.phase === "connected" && state.authority === "controller";

const highlight = createHighlighter();
addEventListener("pagehide", () => highlight.dispose(), { once: true });
const fences: Fences = new Proxy({}, { get: () => CodeFence });
const RichMarkdown = (props: MarkdownProps) => <Markdown {...props} highlight={highlight} fences={fences} />;
const AuthRecoveryContext = createContext<({ id: string; sessionId: string } & Omit<ComponentProps<typeof AuthErrorRecovery>, "code">) | null>(null);
function ErrorRow({ id }: { id: string }) {
  const recovery = useContext(AuthRecoveryContext);
  const item = useItem(id);
  const code = item?.type === "error" && item.event.type === "error" ? item.event.error.code : undefined;
  if (recovery?.id === id) return <AuthErrorRecovery key={`${recovery.sessionId}:${id}:${recovery.canWrite}`} {...recovery} code={code} />;
  return <><Fallback id={id} />{code === "auth_error" && <a href={surfaceHref("/accounts")}>/accounts</a>}</>;
}
function ChatNotification({ id }: { id: string }) {
  const item = useItem(id);
  if (item?.type !== "notification" || item.event.type !== "notification" || item.event.notification_id !== continuationNotification || typeof item.event.data?.text !== "string") return <Notification id={id} />;
  return <p className="chat-continuation" role="status">{item.event.data.text}</p>;
}

const renderers: Renderers = { notification: ChatNotification, message: ({ id }) => <Message id={id} markdown={RichMarkdown} />, tool: CompactTool, error: ErrorRow };
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

const PAGE_CHAT_SHEET_QUERY = "(width < 1280px)";

function usePageChatSheet() {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState(() => matchMedia(PAGE_CHAT_SHEET_QUERY).matches);
  useEffect(() => {
    const media = matchMedia(PAGE_CHAT_SHEET_QUERY);
    const update = () => {
      // Keep the live composer in view when its rail becomes a modal sheet.
      setOpen(media.matches && Boolean(document.activeElement?.closest(".page-chat-docked #message-composer")));
      setMatches(media.matches);
    };
    setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return { narrow: matches, open, setOpen };
}

// `fromNewChat`: this chat is unsent, so it takes the page's new-chat queue owner if that owner's first send created it
function ComposerSlot({ sessionId, fromNewChat, focus, vim, questionWaiting, focusRequest = 0, props, onActivity, client, chat, canWrite, controls }: { controls?: ReactNode; client: ZetaClient | null; chat: { id: string; title: string } | null; canWrite: boolean; sessionId: string; fromNewChat?: string; focus: boolean; vim: boolean; questionWaiting: boolean; focusRequest?: number; props: ComposerProps; onActivity: (activity: ComposerActivity) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const commandOpener = useRef<HTMLElement | null>(null);
  const commands = useComposerCommands(client, chat, canWrite);
  const draft = useSyncExternalStore(
    (listener) => {
      const unsubscribeConfirm = draftStore.subscribeConfirm(sessionId, listener);
      const unsubscribeRemote = draftStore.subscribeRemote(sessionId, listener);
      const unsubscribeDraft = draftStore.subscribe(sessionId, listener);
      return () => { unsubscribeConfirm(); unsubscribeRemote(); unsubscribeDraft(); };
    },
    () => draftStore.get(sessionId),
    () => draftStore.get(sessionId),
  );
  useLayoutEffect(() => { if (focus && !document.querySelector('[role="dialog"][aria-modal="true"]') && !document.activeElement?.closest("[data-chat-id], [data-page-id]")) slot.current?.querySelector<HTMLElement>('textarea[aria-label="message"], [role="textbox"]')?.focus({ preventScroll: true }); }, [focus]);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    slot.current?.querySelector<HTMLElement>('textarea[aria-label="message"], [role="textbox"]')?.focus({ preventScroll: true });
  }, [focusRequest, draft]);
  const adapterProps = {
    ...props,
    defaultValue: draft,
    onDraftChange: (text: string) => draftStore.set(sessionId, text),
    onDraftSubmit: (sent: string) => draftStore.confirm(sessionId, sent),
    chatId: sessionId,
    fromNewChat,
    onActivity,
    questionWaiting,
    onCommand: (command: Parameters<typeof commands.run>[0]) => {
      const field = slot.current?.querySelector<HTMLElement>('textarea[aria-label="message"], [role="textbox"]');
      commandOpener.current = field ?? null;
      return commands.run(command, commandOpener.current);
    },
    commandOutput: commands.output && <CommandOutput commands={commands} opener={commandOpener.current} />,
    controls,
  };
  const composer = vim
    ? <Suspense fallback={<VimLoading />}><LazyVimComposer {...adapterProps} /></Suspense>
    : <PlainComposer {...adapterProps} />;
  return <div id="message-composer" ref={slot} style={{ display: "contents" }}><AccountSwitchReceipt />{composer}</div>;
}

function VimLoading() {
  return <div className="vim-loading" data-part="composer" data-state="read-only" role="group" aria-label="message" aria-disabled="true"><div data-part="composer-field"><textarea rows={1} aria-label="message" placeholder="loading vim…" disabled /></div></div>;
}

function activeLastState(waiting: number, outcome: string, turn: "idle" | "running") {
  return waiting ? "approval" : outcome === "failed" ? "failed" : turn === "running" ? "running" : "idle";
}

// the row id of the last turn's auth failure, when the chat is idle and its last turn failed to authenticate; else
// null. the error reaches the client with code "auth_error" (the account that failed is not in the event).
function authErrorRow(store: ReturnType<typeof createRunStore> | null): string | null {
  if (!store) return null;
  const state = store.getState();
  if (state.turn !== "idle") return null;
  for (let index = state.outline.length - 1; index >= 0; index -= 1) {
    const item = store.getItem(state.outline[index]!.id);
    // the first reply/error/tool/prompt row from the end: a later success ends in a message, so the notice clears
    if (!item || !["error", "message", "tool", "user"].includes(item.type)) continue;
    return item.type === "error" && item.event.type === "error" && item.event.error.code === "auth_error" ? item.id : null;
  }
  return null;
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
  placeholder: string,
): ComposerProps {
  if (!connected) return { state: "read-only", reason: "send is off until zeta is back", onSubmit, placeholder };
  if (toggleBlocked) return { state: "read-only", reason: "send is off until page tools refresh", onSubmit, placeholder };
  return { state: turn === "running" ? "steerable" : "idle", onSubmit, onStop, placeholder };
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

export function AgentSurface({ connection, client, connectionState, observerBanner, current, homeAlias, connectionStatus, renderShell, accountLogin }: { accountLogin: ReturnType<typeof createAccountLogin>; renderShell: RenderShell; connection: Connection; client: ZetaClient | null; connectionState: ConnectionState; observerBanner: ReactNode; current: SurfaceRoute; homeAlias?: string; connectionStatus: { label: string; connected: boolean } }) {
  const settings = useSettings();
  const canWrite = canWriteForState(connectionState);
  const observerConnected = connectionState.phase === "connected" && connectionState.authority === "observer";
  // the approval a click took control for: a new client remounts the timeline, so it lives here, not in the card.
  const tookControl = useRef<TookControl>(null);
  const readOnlyReason = READ_ONLY_REASON;
  const active = useActiveChat(client, connectionState.phase === "connected", undefined, canWrite, homeAlias, createRoute.path);
  const landing = location.pathname === createRoute.path;
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
  const { narrow, open: mobileChatOpen, setOpen: setMobileChatOpen } = usePageChatSheet();
  const mobilePageChat = narrow && hasBlocks;
  const pageChatSheetOpen = mobilePageChat && mobileChatOpen;
  const pageChatSheetClosed = mobilePageChat && !mobileChatOpen;
  const mobileChatWasOpen = useRef(false);
  const pageChatButton = useRef<HTMLButtonElement | null>(null);
  const pageChatClose = useRef<HTMLButtonElement | null>(null);
  const pageChatSurface = useRef<HTMLDivElement | null>(null);
  const [pageChatFocusRequest, setPageChatFocusRequest] = useState(0);
  const [transcript, setTranscript] = useState<HTMLElement | null>(null);
  const [queuedSteers, setQueuedSteers] = useState<ReadonlySet<string>>(new Set());
  const [composerActivity, setComposerActivity] = useState<ComposerActivity>({ sending: false, queued: 0, failed: false, held: false });
  // after every composer of this commit has attached to its chat's queue owner
  useLayoutEffect(() => chatQueues.settle());
  const send: typeof active.send = (text, intent, track) => {
    if (!canWrite) return Promise.reject(new Error(readOnlyReason));
    setFollowRequest((value) => value + 1);
    return trackQueuedSteer(
      (queue) => active.send(text, intent, queue),
      (id) => { track(id); setQueuedSteers((ids) => new Set(ids).add(id)); },
      (id) => setQueuedSteers((ids) => { const next = new Set(ids); next.delete(id); return next; }),
    );
  };

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
  useLayoutEffect(() => {
    const openContinuation = hasBlocks && ready?.continued;
    setMobileChatOpen(!!openContinuation);
    setPageChatFocusRequest(openContinuation ? 1 : 0);
  }, [ready?.sessionId, activePage?.id, ready?.continued, setMobileChatOpen]);
  useModalFocus(pageChatSheetOpen, pageChatSurface, pageChatClose, true);
  const askPageChat = (draft: string) => {
    const sessionId = ready?.sessionId ?? (activePage ? `new:${activePage.id}` : null);
    if (!sessionId) return;
    if (!draftStore.get(sessionId).trim()) draftStore.set(sessionId, draft);
    setPageChatFocusRequest((value) => value + 1);
    if (mobilePageChat) { setMobileChatOpen(true); }
  };
  useEffect(() => {
    if (!pageChatSheetOpen) {
      if (mobileChatWasOpen.current && mobilePageChat) pageChatButton.current?.focus();
      mobileChatWasOpen.current = false;
      return;
    }
    mobileChatWasOpen.current = true;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setMobileChatOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [pageChatSheetOpen, mobilePageChat, setMobileChatOpen]);
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
  const authErrorId = useSyncExternalStore(store?.subscribe ?? (() => () => {}), () => authErrorRow(store));
  const lastState = activeLastState(waiting, authErrorId ? "failed" : outcome, turn);
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
  const recovery = ready && client ? { id: authErrorId ?? "", client, chat: { id: ready.sessionId, title: ready.title }, sessionId: ready.sessionId, login: accountLogin, canWrite, onNewChat: active.newChat } : null;
  const appRenderers: Renderers = { ...renderers, user: ({ id }) => <UserRow id={id} queued={queuedSteers} />, approval: ({ id }) => <ChatApproval id={id} observer={observerConnected} takeControl={() => connection.takeControl()} took={tookControl} disabledReason={!canWrite ? readOnlyReason : !approval ? "zeta is offline" : undefined} onApprove={!canWrite ? undefined : approval ? (request) => approval("approve", request) : undefined} onDeny={!canWrite ? undefined : approval ? (request) => approval("deny", request) : undefined} /> };
  const failure = connectionFailure(connectionState);
  const lost = connectionState.phase !== "connected" && "lost" in connectionState && connectionState.lost;
  const placeholder = hasBlocks ? "Ask about this page" : "Message Zeta";
  const composerProps: ComposerProps = !canWrite ? { state: "read-only", reason: readOnlyReason, onSubmit: send, placeholder: "Read-only" }
    : active.creatingChat ? { state: "read-only", reason: "send waits until the new chat is ready", onSubmit: send, placeholder }
    : activeComposerProps(connected && Boolean(client), active.toggleBlocked, turn, send, () => { if (ready) void client?.request("abort", { session_id: ready.sessionId }); }, placeholder);
  // mirrors the final branch of `content` below: whichever states skip the composer must also relabel the skip link.
  const hasComposer = observerBanner ? Boolean(activePage) : !active.creationError && active.state.phase !== "missing" && active.state.phase !== "error" && !(failure && !lost) && Boolean(activePage) && Boolean(activeStore);
  // rows typed in the new-chat box that no chat took (a refused create): the page opens another chat, so say they wait
  const unsentNew = ready ? chatQueues.unsent(`new:${ready.page.id}`).length : 0;
  // a failed create keeps the message typed for it in the page's new-chat box: show it, so the user sees it is safe
  const keptNew = active.creationError && active.creationPageId ? chatQueues.unsent(`new:${active.creationPageId}`) : [];
  const state = headerState(lost, lastState, outcome, composerActivity, Boolean(active.busy), Boolean(ready?.sent));
  const nav = useAgentNavAdapter({
    sessionId: ready?.sessionId ?? null, waiting, canWrite, onSelectChat: active.selectChat,
    onRenameChat: (chat, text) => { if (canWrite) void active.rename(chat.session_id, text); },
    refreshKey: active.listRefresh, pageRefreshKey: pageRefreshNonce,
  });
  // a page build's running turn reads "building", as in the nav, the switcher, and /create (the open chat is always listed)
  const building = nav.catalog.chats.some((chat) => chat.session_id === ready?.sessionId && chat.purpose === "page_build");
  const stateLabel = runStateLabel(state, composerActivity.queued, building);
  useEffect(() => {
    if (state !== "approval" || location.hash !== approvalIntent) return;
    // as fulcrum's "jump to approval": the first enabled action, once the card has rendered
    const frame = requestAnimationFrame(() => {
      const action = document.querySelector<HTMLElement>("[data-part=approval-actions] button:not([aria-disabled=true])");
      if (!action) return;
      action.focus();
      history.replaceState(history.state, "", location.pathname + location.search);
    });
    return () => cancelAnimationFrame(frame);
  }, [state]);
  const title = ready?.title ?? "New chat";
  const newPageChatReason = !connected ? "new chat is off until zeta is back" : !canWrite ? readOnlyReason
    : active.creatingChat ? "creating chat…" : empty || (ready && !ready.sent) ? "already in a new chat"
    : state === "running" || state === "approval" || active.busy ? "wait for the running chat to finish" : undefined;
  const createMode: CreateModeOwner | undefined = !landing && activePage ? {
    available: connected && canWrite && !active.creatingChat && (!active.toggleBlocked || active.toggleRetryable),
    enabled: activePage.create_mode, pending: active.toggling, error: active.toggleError,
    async toggle() {
      if (!createMode?.available || createMode.pending) return;
      await active.toggle();
    },
  } : undefined;
  // the chat's own model; a new chat shows zeta's default, the one it will start with
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const needsDefaultModel = connected && client !== null && (empty !== null || (ready !== null && !ready.model));
  useEffect(() => {
    if (!needsDefaultModel) return;
    let live = true;
    client!.request("state_settings", { collection: "mcp", limit: 1 }).then((result) => { if (live) setDefaultModel(parseDefaults(result)?.model ?? null); }, () => {});
    return () => { live = false; };
  }, [client, needsDefaultModel]);
  const serverForcesAsk = (ready ?? empty)?.serverApprovalMode === "ask";
  const composerModes = activePage && <ComposerModes model={ready?.model ?? defaultModel}
    create={createMode && { on: createMode.enabled, toggle: createMode.available ? createMode.toggle : undefined, busy: createMode.pending ? "saving…" : undefined,
      reason: !canWrite ? readOnlyReason : active.creatingChat ? "creating chat…" : active.toggleBlocked && !active.toggleRetryable ? "wait for page tools to refresh" : undefined }}
    approval={{ on: ready ? activePage.approval_mode === "allow" : active.build.approvalMode === "allow", toggle: canWrite ? active.toggleApprovalMode : undefined,
      reason: !canWrite ? readOnlyReason : serverForcesAsk ? "this server requires tool approval" : !ready ? "start a chat to change tool approval" : undefined,
      busy: ready?.pendingApprovalMode && active.approvalChange?.pending ? "waiting for the turn to finish…" : active.approvalChange?.pending ? "saving…" : undefined,
      error: active.approvalChange?.error }} />;
  const content = <>
    {activePage && historyOpen && <HistoryDialog key={activePage.id} pageId={activePage.id} credential={(ready ?? empty)!.credential} createMode={activePage.create_mode} opener={historyOpener} onClose={() => setHistoryOpen(false)} onChanged={() => setRestores((value) => value + 1)} canWrite={canWrite} disabledReason={readOnlyReason} />}
    {activePage && active.toggleError && <div className="create-mode-alert" role="alert" hidden={hasBlocks && !active.toggleRetryable}><span>{active.toggleError}</span>{active.toggleRetryable && <button type="button" disabled={active.toggling} onClick={createMode?.toggle}>{active.toggling ? "retrying…" : "retry"}</button>}</div>}
    {lost && ready && failure && <ConnectionBanner state={connectionState} connection={connection} compact />}
    {unsentNew > 0 && <div className="create-mode-alert" role="status"><span>{unsentNew === 1 ? "1 unsent message" : `${unsentNew} unsent messages`} for a new chat</span><button type="button" onClick={active.openNewChat}>open</button></div>}
    {active.busy && <BusyNotice busy={active.busy} openSessionId={ready?.sessionId ?? null} onOpen={active.openBusyChat} onRetry={active.retryBusy} canWrite={canWrite} />}
    {active.creationError ? <div className="full-state"><p role="alert">{active.creationError}</p>{keptNew.map((text, index) => <figure key={index} className="kept-message"><figcaption>kept, not sent</figcaption><blockquote>{text}</blockquote></figure>)}<div className="full-state-actions"><button className="primary" data-write-surface={WRITE_SURFACE.createRetry} autoFocus onClick={(event) => { event.currentTarget.focus(); if (canWrite) active.retrySaving(); }} disabled={!canWrite}>retry creating chat</button><button type="button" data-write-surface={WRITE_SURFACE.createDiscard} onClick={active.discardCreation} disabled={!canWrite}>start over</button></div></div>
      : active.state.phase === "missing" ? <div className="full-state"><p role="alert">this chat no longer exists</p><button className="primary" data-write-surface={WRITE_SURFACE.missingNewChat} onClick={active.newChat} disabled={!canWrite}>new chat</button></div>
      : active.state.phase === "error" && active.state.error === "page not found" ? <NotFoundState onNewChat={active.newChat} />
      : active.state.phase === "error" ? <div className="full-state"><p role="alert">{active.state.error}</p></div>
      : busyPage ? <>{busyPage.page.layout.blocks.length > 0 && <PageView page={busyPage.page} pageId={busyPage.page.id} credential={busyPage.credential} refreshKey={`${refreshKey}:${pageRefreshNonce}`} onAskChat={undefined} canWrite={canWrite} disabledReason={readOnlyReason} />}</>
      : failure && !lost ? <ConnectionBanner state={connectionState} connection={connection} />
      : !activePage || !activeStore ? <div className="full-state"><p role="status">{active.attachSlow ? "still connecting to this chat" : "loading chat…"}</p>{active.attachSlow && <button className="primary" type="button" onClick={active.retryAttachment}>Retry</button>}</div>
      : <RunProvider store={activeStore}>
        <div className={hasBlocks ? "page-view docked" : "page-view"}>
        {hasBlocks && <PageView page={activePage} pageId={activePage.id} credential={(ready ?? empty)!.credential} refreshKey={`${refreshKey}:${pageRefreshNonce}`} onAskChat={canWrite ? askPageChat : undefined} canWrite={canWrite} disabledReason={readOnlyReason} />}
        <div className={`page-chat${hasBlocks ? " page-chat-docked" : ""}${pageChatSheetClosed ? " page-chat-sheet-closed" : ""}`}>
        {hasBlocks && <button ref={pageChatButton} className="page-chat-bar" type="button" aria-expanded={pageChatSheetOpen} aria-controls="page-chat-sheet" onClick={() => setMobileChatOpen(true)}><span>Page chat</span>{state !== "idle" && <span className="page-chat-bar-state">{stateLabel}</span>}<span aria-hidden="true">⌃</span></button>}
        {pageChatSheetOpen && <div className="page-chat-backdrop" onClick={() => setMobileChatOpen(false)} />}
        <div ref={pageChatSurface} id="page-chat-sheet" className="page-chat-surface" role={pageChatSheetOpen ? "dialog" : undefined} aria-modal={pageChatSheetOpen ? "true" : undefined} aria-label={pageChatSheetOpen ? "page chat" : undefined} inert={pageChatSheetClosed}>
        {hasBlocks && <PageChatHeader key={`${activePage.id}:${ready?.sessionId ?? "new"}:${pageChatSheetClosed}`} pageId={activePage.id} sessionId={ready?.sessionId ?? null} title={ready ? title : "Page chat"} state={state} stateLabel={stateLabel}
          onSelect={active.selectChat} newChat={newPageChatReason ? undefined : active.newChat} newReason={canWrite ? newPageChatReason : undefined}
          close={pageChatSheetOpen ? () => setMobileChatOpen(false) : undefined} closeRef={pageChatClose} />}
        <section ref={ready ? setTranscript : undefined} className="transcript" data-follow-request={followRequest}>{active.creatingChat ? <div className="full-state"><p role="status">creating chat…</p></div> : (!ready || Number(outlineLength) === 0) && <EmptyChat key={activePage.id} page={activePage} sessionId={ready?.sessionId ?? null} send={send} continueWaiting={active.continueWaitingChat} toggleCreateMode={createMode?.toggle ?? (async () => {})} credential={(ready ?? empty)!.credential} refreshKey={refreshKey} canWrite={canWrite} />}{ready && <AuthRecoveryContext.Provider value={recovery}><ToolDisclosure sessionId={ready.sessionId} cwd={ready.cwd}><Timeline renderers={appRenderers} virtual followRequest={followRequest} /></ToolDisclosure></AuthRecoveryContext.Provider>}{ready && showJumpToLatest && <div data-part="jump-to-latest-lane" data-jump-owned="true"><button type="button" data-part="jump-to-latest" onMouseDown={(event) => event.preventDefault()} onClick={(event) => {
          // the button unmounts once the reader is at the bottom; a mouse click must not take focus from where it was (the composer)
          keyboardFocusToComposer(event);
          setFollowRequest((value) => value + 1);
          const scroll = transcript?.querySelector<HTMLElement>('[data-part="timeline-scroll"]');
          scroll?.scrollTo({ top: scroll.scrollHeight, behavior: "auto" });
        }} aria-label="jump to latest" title="jump to latest"><span data-jump-label="full">jump to latest</span><span data-jump-label="compact" aria-hidden="true">↓</span></button></div>}
        </section>
        <ComposerSlot key={ready?.sessionId ?? `new:${activePage.id}`} sessionId={ready?.sessionId ?? `new:${activePage.id}`} fromNewChat={ready && !ready.sent ? `new:${activePage.id}` : undefined} onActivity={setComposerActivity} focus={!active.creatingChat && (!ready || active.focusSessionId === ready.sessionId)} vim={canWrite && settings.vim && !matchMedia("(pointer: coarse)").matches} questionWaiting={waiting > 0} focusRequest={pageChatFocusRequest} props={composerProps} client={client} chat={ready ? { id: ready.sessionId, title } : null} canWrite={canWrite} controls={composerModes} />
        </div>
        </div>
        </div>
      </RunProvider>}
  </>;
  // a chat on a page that is not home belongs to Pages, as its header crumb says; the address decides, so loading and missing pages agree
  const onPage = current === chatsRoute && location.pathname !== "/" && location.pathname !== homeAlias;
  const place = landing ? createRoute : current === createRoute ? chatsRoute : onPage ? pagesRoute : current;
  return renderShell({ current: place, nav, connectionStatus, banner: observerBanner, hasComposer: !landing && hasComposer,
    newChat: { available: canWrite && (!landing || active.state.phase === "empty"), pending: active.startingChat, run: () => void active.newChat() },
    workspace: landing ? undefined : { canWrite, serverForcesAsk, createMode },
    header: !landing && activePage && <ChatHeader page={activePage} docked={hasBlocks} sessionId={ready?.sessionId ?? null} title={title} state={state} stateLabel={stateLabel} onRename={!canWrite ? undefined : ready ? (id, text) => { void active.rename(id, text); } : undefined} onHistory={(opener) => { historyOpener.current = opener; setHistoryOpen(true); }} />,
    children: (activity) => landing ? <CreateLanding build={active.build} nav={nav} activity={activity} /> : content,
  });
}

/**
 * A pending approval. In a tab that is not in control it says so, and one click (never an automatic one) takes control:
 * the button sits in the card's action row under that line. After the take, focus moves to approve and a line says so.
 */
type TookControl = { id: string; focus: boolean } | null;
function ChatApproval({ id, observer, takeControl, took, ...decision }: { observer: boolean; takeControl: () => Promise<string | null>; took: { current: TookControl } } & ComponentProps<typeof Approval>) {
  const item = useItem(id);
  const [working, setWorking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // fulcrum's Approval has no slot for an extra action: render into its action row.
  const [row, setRow] = useState<Element | null>(null);
  const card = () => document.querySelector(`[data-part="approval"][data-id="${CSS.escape(id)}"]`);
  useLayoutEffect(() => setRow(card()?.querySelector('[data-part="approval-actions"]') ?? null));
  // the take swaps the client, and the timeline can replace this card more than once: while focus is lost, put it on
  // approve. once focus is on anything else, stop.
  useLayoutEffect(() => {
    if (observer || took.current?.id !== id || !took.current.focus) return;
    const approve = card()?.querySelector<HTMLElement>('button[data-action="approve"]:not([aria-disabled="true"])');
    const active = document.activeElement;
    if (active && active !== document.body && active !== approve) took.current = { id, focus: false };
    else approve?.focus();
  });
  const pending = item?.type === "approval" && !item.ended;
  const control = !pending ? null : observer ? <>
    <button type="button" aria-label="take control to answer" aria-disabled={working || undefined} onClick={async () => {
      if (working) return;
      setWorking(true); setRefusal(null);
      // set before the take: the new client can render this card before the take resolves. a refusal keeps observer.
      took.current = { id, focus: true };
      const reason = await takeControl();
      if (reason !== null) took.current = null;
      setRefusal(reason); setWorking(false);
    }}>{working ? "taking control…" : "take control"}</button>
    {refusal && <span role="status">{refusal}</span>}
  </> : took.current?.id === id ? <span role="status">this tab is now in control</span> : null;
  return <>
    <Approval id={id} {...(observer ? { disabledReason: "this tab is not in control · take control to answer" } : decision)} />
    {row && control && createPortal(<div className="approval-control">{control}</div>, row)}
  </>;
}

function BusyNotice({ busy, openSessionId, onOpen, onRetry, canWrite = false }: { busy: { sessionId: string | null; chat: { title: string | null; first_title?: string | null } | null; retry: "attach" | "new" }; openSessionId: string | null; onOpen: () => void; onRetry: () => void; canWrite?: boolean }) {
  const here = busy.sessionId !== null && busy.sessionId === openSessionId;
  const open = !here && busy.chat;
  const running = open ? `"${titleOf(busy.chat!)}"` : "another chat";
  const text = busy.retry === "new" && busy.sessionId ? `${running} is still running, so zeta cannot start a new chat yet. a message sent here stays unsent; retry it when that chat ends.`
    : here ? "this chat is still running. approve or stop it, then try again."
    : open ? `"${titleOf(busy.chat!)}" is still running. open it to approve or stop it, then try again.`
    : busy.sessionId ? "another chat is still running. approve or stop it, then try again."
    : "zeta was busy a moment ago and is ready now. try again.";
  return <div className="create-mode-alert" role="alert"><span>{text}</span><span>{open && <button type="button" onClick={onOpen}>open it</button>}<button type="button" data-write-surface={WRITE_SURFACE.busyRetry} disabled={!canWrite} onClick={onRetry}>try again</button></span></div>;
}

function NotFoundState({ onNewChat }: { onNewChat: () => Promise<void> }) {
  return <div className="full-state not-found-state"><p role="alert">page not found</p><div><a className="primary" href="/">go home</a><button className="primary" onClick={() => void onNewChat()}>new chat</button></div></div>;
}

function runStateLabel(state: string, queued: number, building: boolean) {
  return state === "approval" ? "needs you" : state === "running" && building ? "building" : state === "unsent" ? "not sent" : state === "maybe-unsent" ? MAYBE_SENT_LABEL : state === "queued" && queued > 1 ? `${queued} queued` : state;
}

function ChatHeader({ page, docked, sessionId, title, state, stateLabel, onRename, onHistory }: { page: Page; docked: boolean; sessionId: string | null; title: string; state: string; stateLabel: string; onRename?: (sessionId: string, title: string) => void; onHistory: (opener: HTMLElement | null) => void }) {
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
  const titleNode = rename.editing
    ? <input className="chat-title-edit" aria-label="chat title" {...rename.bind()} />
    : <strong ref={titleControl} title={title} aria-label={title} data-write-surface={WRITE_SURFACE.headerRename} data-session-id={sessionId ?? undefined} role={onRename ? "button" : undefined} tabIndex={onRename ? 0 : undefined} onClick={startRename} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startRename(); } }}>{title}</strong>;
  const routeLabel = page.route === "/" ? "Home" : page.title;
  if (docked) return <header className="chat-header"><div className="chat-heading"><span className="page-crumb" title={routeLabel}>Pages <span aria-hidden="true">/</span> {routeLabel}</span><span aria-hidden="true">/</span>{titleNode}</div><div className="chat-actions"><button type="button" onClick={(event) => onHistory(event.currentTarget)}>History</button></div></header>;
  return <header className="chat-header"><div className="chat-heading"><span title={routeLabel} aria-label={routeLabel}>{routeLabel}</span><span aria-hidden="true">/</span>{titleNode}</div><div className="chat-actions"><span className={`run-state state-${state}`} role="status" hidden={state === "idle"}>{stateLabel}</span><button type="button" onClick={(event) => onHistory(event.currentTarget)}>History</button></div></header>;
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
