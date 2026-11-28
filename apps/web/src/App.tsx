import { AccountSwitchReceipt } from "./accounts/AccountSwitchReview";
import type { createAccountLogin } from "./accounts/accountLogin";
import { ALREADY_NEW, PageChatHeader } from "./PageChatHeader";
import { createContext, useCallback, useContext, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRunStore } from "@fulcrum/core";
import { useApprovalIntent } from "./notify";
import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { CodeFence } from "./chat/CodeFence";
import { CompactTool, ToolDisclosure } from "./chat/CompactTool";
import { Approval, Fallback, Message, Notification, RunProvider, SubAgentNavigationProvider, Timeline, useItem, type ComposerProps, type Renderers } from "@fulcrum/react";
import { ChatAgents } from "./agents/ChatAgents";
import { BackgroundTasks, RUN_WORK_FEATURE, useBackgroundTasks } from "./chat/BackgroundTasks";
import type { ChildControls } from "./agents/childControls";
import type { ChildSendOwner } from "./agents/childSend";
import { completePath, type ZetaClient } from "@fulcrum/zeta";
import type { RenderShell } from "./surface/SurfaceRouter";
import { chatHref, titleOf, useAgentNavAdapter, type Chat } from "./surface/AgentNavAdapter";
import { surfaceHref, chatsRoute, createRoute, pagesRoute, type SurfaceRoute } from "./surface/routes";
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
import { ArchivedBar, PageCrumbMenu } from "./page/PageArchive";
import { PageFrame } from "./page/PageFrame";
import { EmptyChat } from "./EmptyChat";
import { isEditableTarget, keyboardFocusToComposer, returnFocusToComposer, userTyping, useModalFocus } from "./keyboard";
import { useSettings } from "./settings";
import { createApprovalDecider } from "./zeta/approvals";
import { backoff, historyImageLoader, supportsFeature, supportsRequest, type Connection, type ConnectionState } from "./zeta";
import { IMAGE_FEATURE, IMAGE_REQUEST } from "./composer/images";
import { TOO_MANY_CHATS } from "./zeta/session";
import { parkedRows, subscribeParked } from "./zeta/parked";
import { keepRowWrites, subscribeRowWrites, verifyChatStates } from "./zeta/rowState";
import { trackQueuedSteer, useActiveChat, type Page, type ParkedChat, type StopState } from "./useActiveChat";
import { useInlineRename } from "./useInlineRename";
import { watchJumpToLatest } from "./jumpToLatest";
import "./style.css";
import { continuationNotification } from "./chat/continuation";
import "./chat/continuation.css";
import { withChildRecovery } from "./chat/ChildRecoveryNotice";
import { BranchActionContext, BranchFromHere, BranchSwitcher, useBranches } from "./chat/branches";
import "./shell.css";
import "./chat/transcript.css";
import "./composer/composer.css";
import "./chat/markdown.css";
import "./chat/fulcrum-g1.css";
import { CHAT_CONTROLLED_REASON, READ_ONLY_REASON, WRITE_SURFACE } from "./writeSurfaces";
import "./jumpToLatest.css";

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

const renderers: Renderers = { notification: withChildRecovery(ChatNotification), unknown: withChildRecovery(Fallback), message: ({ id }) => <Message id={id} markdown={RichMarkdown} />, tool: CompactTool, error: ErrorRow };
// a steer zeta accepted but has not delivered yet shows once: in the composer with its "queued" status, not as a bubble
// inside the reply that is still streaming. it shows here once delivery settles (a drop its turn did not read stays
// hidden while it goes out again as a new message, which then takes over this row).
function UserRow({ id, queued, onForked }: { id: string; queued: ReadonlySet<string>; onForked: () => void }) {
  const item = useItem(id);
  const event = item?.type === "user" && item.event.type === "user_message" ? item.event : undefined;
  if (event?.mode === "steer" && event.delivery_id && queued.has(event.delivery_id)) return null;
  if (!event || event.text_omitted) return <Fallback id={id} />;
  return <div className="user-turn"><Fallback id={id} /><BranchFromHere rowId={id} onForked={onForked} /></div>;
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

// the composer's text field: the plain textarea or the vim editor
const FIELD = 'textarea[aria-label="message"], [role="textbox"]';
// `fromNewChat`: this chat is unsent, so it takes the page's new-chat queue owner if that owner's first send created it
function ComposerSlot({ sessionId, fromNewChat, focus, vim, questionWaiting, focusRequest = 0, props, onActivity, client, chat, canWrite, controls }: { controls?: ReactNode; client: ZetaClient | null; chat: { id: string; title: string } | null; canWrite: boolean; sessionId: string; fromNewChat?: string; focus: boolean; vim: boolean; questionWaiting: boolean; focusRequest?: number; props: ComposerProps & { held?: boolean }; onActivity: (activity: ComposerActivity) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const commandOpener = useRef<HTMLElement | null>(null);
  const chatId = chat?.id;
  // zeta advertises path_complete only to a controller that negotiated path_completion
  const completePaths = useMemo(() => (canWrite && client && chatId && supportsRequest(client, "path_complete")
    ? (text: string, signal: AbortSignal) => completePath(client, chatId, text, { signal })
    : undefined), [canWrite, client, chatId]);
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
  // a refused command's text comes back only into an empty composer, so newer typing is never lost
  const commands = useComposerCommands(client, chat, canWrite, draft, (text) => { if (!draftStore.get(sessionId)) draftStore.set(sessionId, text); });
  // a hold's end, or a swap that replaced the field the user typed in, gives focus back to this composer
  const editable = props.state !== "read-only";
  useLayoutEffect(() => { if (editable) returnFocusToComposer(slot.current?.querySelector<HTMLElement>(FIELD)); }, [editable]);
  useLayoutEffect(() => { if (focus && !document.querySelector('[role="dialog"][aria-modal="true"]') && !document.activeElement?.closest("[data-chat-id], [data-page-id]")) slot.current?.querySelector<HTMLElement>(FIELD)?.focus({ preventScroll: true }); }, [focus]);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const field = slot.current?.querySelector<HTMLElement>(FIELD);
    if (!field || document.activeElement === field) return;
    field.focus({ preventScroll: true });
    // the caret goes after the draft, so typing continues it
    if (field instanceof HTMLTextAreaElement) field.setSelectionRange(field.value.length, field.value.length);
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
    onCommand: (command: Parameters<typeof commands.run>[0], text: string) => {
      const field = slot.current?.querySelector<HTMLElement>(FIELD);
      commandOpener.current = field ?? null;
      return commands.run(command, commandOpener.current, text);
    },
    commandOutput: commands.output && <CommandOutput commands={commands} opener={commandOpener.current} />,
    slashCommands: commands.slashList,
    controls,
    // an older zeta takes no images: no paste, no drop, no chips
    images: Boolean(client && supportsFeature(client, IMAGE_FEATURE) && supportsRequest(client, IMAGE_REQUEST)),
    completePaths,
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

// a page renders as its compiled react revision; a non-home page without one (a migrated block page) shows the server's notice
function PageSurface({ page, credential }: { page: Page; credential: string }) {
  if (page.code) return <PageFrame pageId={page.id} credential={credential} revision={page.code.version} />;
  return <main className="page-content"><p className="page-unsupported">{page.unsupported_format}</p></main>;
}
const hasSurface = (page: Page | null | undefined) => !!page?.code || !!page?.unsupported_format;

function connectionFailure(state: ConnectionState): string | null {
  if (state.phase !== "connected" && "lost" in state && state.lost) return "the connection to zeta was lost.";
  switch (state.phase) {
    case "not_running": return "zeta serve is not running.";
    case "auth_failed": return state.reason === "origin" ? `this origin is not allowed by zeta. restart zeta serve with --ws-origin ${location.origin}.` : "zeta rejected this browser connection.";
    case "unresponsive": return "zeta is not responding.";
    case "incompatible": return "this zeta version is not compatible with achilles.";
    // both the controller and the observer hello were refused: zeta has no free slot. the page retries by itself with backoff.
    case "controller_taken": return "zeta has no free slot for this tab: too many tabs or apps are connected. close one, and this page reconnects by itself.";
    default: return null;
  }
}

export function AgentSurface({ connection, childControls, childSend, client, connectionState, observerBanner, current, homeAlias, connectionStatus, renderShell, accountLogin }: { childControls: ChildControls; childSend: ChildSendOwner; accountLogin: ReturnType<typeof createAccountLogin>; renderShell: RenderShell; connection: Connection; client: ZetaClient | null; connectionState: ConnectionState; observerBanner: ReactNode; current: SurfaceRoute; homeAlias?: string; connectionStatus: { label: string; connected: boolean } }) {
  const settings = useSettings();
  const canWrite = canWriteForState(connectionState);
  const observerConnected = connectionState.phase === "connected" && connectionState.authority === "observer";
  // the approval a click took control for: a new client remounts the timeline, so it lives here, not in the card.
  const tookControl = useRef<TookControl>(null);
  // a disconnected tab is read-only too, but not because zeta is full
  const readOnlyReason = connectionState.phase === "connected" ? READ_ONLY_REASON : "zeta is not connected. this tab reconnects by itself.";
  const active = useActiveChat(client, connectionState.phase === "connected", undefined, canWrite, homeAlias, createRoute.path);
  const landing = location.pathname === createRoute.path;
  const ready = active.state.phase === "ready" ? active.state : null;
  // another tab controls the open chat: writes to this chat go there; tab writes (new chat, settings, page data) stay here
  const chatCanWrite = canWrite && !ready?.controlledElsewhere;
  const chatReadOnlyReason = canWrite && ready?.controlledElsewhere ? CHAT_CONTROLLED_REASON : readOnlyReason;
  // the held banner says why once; the approval card and the composer then keep it short (a 390 px screen shows all three)
  const heldElsewhere = canWrite && Boolean(ready?.controlledElsewhere);
  // "try again" on a held chat: pending until a new attach (a new lease) lands; still held after it says so
  const [heldRetry, setHeldRetry] = useState<{ sessionId: string; lease: unknown } | null>(null);
  useEffect(() => { if (!ready?.controlledElsewhere) setHeldRetry(null); }, [ready?.controlledElsewhere]);
  const retryingHeld = Boolean(heldRetry && ready?.lease === heldRetry.lease);
  const stillHeld = Boolean(heldRetry && ready?.sessionId === heldRetry.sessionId && ready.lease !== heldRetry.lease);
  // F2 or a click on a held chat's title says why it does not rename, in the notice
  const [renameRefused, setRenameRefused] = useState(false);
  useEffect(() => setRenameRefused(false), [ready?.sessionId, ready?.controlledElsewhere]);
  const refuseRename = () => setRenameRefused(true);
  const heldText = renameRefused ? HELD_TEXT.rename : stillHeld ? HELD_TEXT.still : HELD_TEXT.open;
  const empty = active.state.phase === "empty" ? active.state : null;
  const busyPage = active.state.phase === "busy" ? active.state : null;
  const activePage = ready?.page ?? empty?.page ?? null;
  const hasPageSurface = hasSurface(activePage);
  const emptyStore = useMemo(() => empty ? createRunStore() : null, [empty?.page.id]);
  const store = ready?.lease.store ?? null;
  const activeStore = store ?? emptyStore;
  const loadMedia = useMemo(() => historyImageLoader(client), [client]);
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
  // a restore from the history list changes a tool without a chat turn
  const [restores, setRestores] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyOpener = useRef<HTMLElement | null>(null);
  // the agents dialog of one chat, opened from the header or a sub-agent row on that run; shown only while that chat is on screen
  const [agents, setAgents] = useState<{ sessionId: string; run?: string; opener: HTMLElement | null } | null>(null);
  const readySessionId = ready?.sessionId;
  const agentNavigation = useMemo(() => ({
    open: (run: string) => { if (readySessionId) setAgents({ sessionId: readySessionId, run, opener: document.activeElement as HTMLElement | null }); },
    unavailable: () => client && supportsFeature(client, "agent_run_catalog_v1") ? undefined : "details need a newer zeta",
  }), [client, readySessionId]);
  // another chat on screen closes the dialog in this render, so it never mounts or reopens for a chat that is not shown
  if (agents && readySessionId && agents.sessionId !== readySessionId) setAgents(null);
  // this chat's background tasks: only the tab that holds the chat can list or cancel them (zeta's run_work)
  const backgroundTasks = useBackgroundTasks(client, ready && !ready.controlledElsewhere ? ready.sessionId : undefined, canWrite && !!client && supportsFeature(client, RUN_WORK_FEATURE));
  const [tasksOpen, setTasksOpen] = useState<{ sessionId: string; opener: HTMLElement | null } | null>(null);
  if (tasksOpen && readySessionId && tasksOpen.sessionId !== readySessionId) setTasksOpen(null);
  const refreshKey = `${completedTurns}:${completedTools}:${restores}`;
  const previousRefreshKey = useRef(refreshKey);
  const waiting = Number(approvalCount);
  const branches = useBranches(client, ready?.sessionId ?? null, store, completedTurns, turn === "running");
  // zeta forks and switches only an idle chat this tab holds
  const branchOff = !chatCanWrite ? heldElsewhere ? "branch it in the tab that has this chat." : chatReadOnlyReason
    : turn === "running" || waiting ? "wait for this turn to finish." : null;
  const branchAction = useMemo(() => branches.supported && ready ? { fork: branches.fork, disabledReason: branchOff ?? (branches.pending ? "branching…" : null) } : null, [branches.supported, branches.fork, ready, branchOff, branches.pending]);
  const [followRequest, setFollowRequest] = useState(0);
  const [pageRefreshNonce, setPageRefreshNonce] = useState(0);
  const completedCreatePages = useRef(new Set<string>());
  // a rename, archive, or restore: read the open page again, and the page list behind Pages, search, and the palette
  const pageChanged = () => { void active.refreshPage(); setPageRefreshNonce((current) => current + 1); };
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const { narrow, open: mobileChatOpen, setOpen: setMobileChatOpen } = usePageChatSheet();
  const mobilePageChat = narrow && hasPageSurface;
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
    if (!chatCanWrite) return Promise.reject(new Error(chatReadOnlyReason));
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
      if (value && ["create_page", "achilles__create_page", "restore_version", "achilles__restore_version", "write_page", "achilles__write_page", "edit_page", "achilles__edit_page"].includes(name) && !value.active && !value.is_error && !completedCreatePages.current.has(item.id)) {
        completedCreatePages.current.add(item.id);
        setPageRefreshNonce((current) => current + 1);
        if (["restore_version", "achilles__restore_version"].includes(name)) void active.refreshPage();
      }
    }
  }), [active.refreshPage, store]);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void active.refreshPage();
  }, [refreshKey]);
  useEffect(() => {
    if (ready?.sessionId) setFollowRequest((value) => value + 1);
  }, [ready?.sessionId]);
  useLayoutEffect(() => {
    const openContinuation = hasPageSurface && ready?.continued;
    setMobileChatOpen(!!openContinuation);
    setPageChatFocusRequest(openContinuation ? 1 : 0);
  }, [ready?.sessionId, activePage?.id, ready?.continued, setMobileChatOpen]);
  useModalFocus(pageChatSheetOpen, pageChatSurface, pageChatClose, true);
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
  const recovery = ready && client ? { id: authErrorId ?? "", client, chat: { id: ready.sessionId, title: ready.title }, sessionId: ready.sessionId, login: accountLogin, canWrite: chatCanWrite, onNewChat: active.newChat } : null;
  const appRenderers: Renderers = { ...renderers, user: ({ id }) => <UserRow id={id} queued={queuedSteers} onForked={() => setPageChatFocusRequest((value) => value + 1)} />, approval: ({ id }) => <ChatApproval id={id} observer={observerConnected} takeControl={() => connection.takeControl()} took={tookControl} disabledReason={!chatCanWrite ? heldElsewhere ? "approve it in the tab that has this chat." : chatReadOnlyReason : !approval ? "zeta is offline" : undefined} onApprove={!chatCanWrite ? undefined : approval ? (request) => approval("approve", request) : undefined} onDeny={!chatCanWrite ? undefined : approval ? (request) => approval("deny", request) : undefined} /> };
  const failure = connectionFailure(connectionState);
  const lost = connectionState.phase !== "connected" && "lost" in connectionState && connectionState.lost;
  const placeholder = hasPageSurface ? "Ask about this page" : "Message Zeta";
  // canWrite here means only this chat is off: another tab holds it
  const composerProps: ComposerProps & { held?: boolean } = !chatCanWrite ? { state: "read-only", reason: chatReadOnlyReason, onSubmit: send, placeholder: "read-only" }
    : active.creatingChat ? { state: "read-only", reason: "send waits until the new chat is ready", onSubmit: send, placeholder }
    // a swap is pending: the kept chat's composer is held read-only (its draft stays; nothing typed is lost) until zeta answers
    : active.swapping ? { state: "read-only", reason: "opening chat…", held: true, onSubmit: send, placeholder }
    : activeComposerProps(connected && Boolean(client), active.toggleBlocked, turn, send, () => { if (ready) void client?.request("abort", { session_id: ready.sessionId }); }, placeholder);
  // mirrors the final branch of `content` below: whichever states skip the composer must also relabel the skip link.
  const hasComposer = observerBanner ? Boolean(activePage) : !active.creationError && active.state.phase !== "missing" && active.state.phase !== "error" && !(failure && !lost) && Boolean(activePage) && Boolean(activeStore);
  // rows typed in the new-chat box that no chat took (a refused create): the page opens another chat, so say they wait
  const unsentNew = ready ? chatQueues.unsent(`new:${ready.page.id}`).length : 0;
  // a failed create keeps the message typed for it in the page's new-chat box: show it, so the user sees it is safe
  const keptNew = active.creationError && active.creationPageId ? chatQueues.unsent(`new:${active.creationPageId}`) : [];
  // a chat other than the one shown runs (no park): the header waits; the parked_limit notice is a choice, not a wait
  const state = headerState(lost, lastState, outcome, composerActivity, Boolean(active.busy && !active.busy.limit), Boolean(ready?.sent));
  // the chats this tab keeps running in zeta while it shows another one (only a tab that holds chats has them)
  const parked = useSyncExternalStore(useCallback((listener: () => void) => client ? subscribeParked(client, listener) : () => {}, [client]), () => parkedRows(canWrite ? client : null));
  const nav = useAgentNavAdapter({
    parked,
    sessionId: ready?.sessionId ?? null, waiting, canWrite, heldChatId: ready?.controlledElsewhere ? ready.sessionId : null, onHeldRename: refuseRename, onSelectChat: active.selectChat,
    onRenameChat: (chat, text) => { if (canWrite) void active.rename(chat.session_id, text); },
    refreshKey: active.listRefresh, pageRefreshKey: pageRefreshNonce,
  });
  // a page build's running turn reads "building", as in the nav, the switcher, and /create (the open chat is always listed)
  // rows that say "running" or "needs you" for a chat this tab does not hold (a closed tab, a zeta restart): check them
  // with zeta once per list load, and store what zeta says
  const listedChats = nav.catalog.chats;
  // (a chat a stop left attached has no other writer, so the check covers it too)
  const heldIds = [ready?.sessionId, ...parked.map((row) => row.session_id)].filter((id): id is string => Boolean(id)).join(" ");
  // this tab's own chats (not one shown read-only): what it last wrote is kept for these only
  const ownIds = [ready && !ready.controlledElsewhere ? ready.sessionId : null, ...parked.map((row) => row.session_id)].filter(Boolean).join(" ");
  useEffect(() => keepRowWrites(new Set(ownIds.split(" "))), [ownIds]);
  // a list another tab's write reloaded is not checked: that tab holds the chat and just stored its state, and zeta's
  // view of it could lag behind
  const remoteReload = useRef(false);
  useEffect(() => {
    if (remoteReload.current) { remoteReload.current = false; return; }
    if (!client || !connected || !canWrite || !listedChats.length) return;
    void verifyChatStates(client, listedChats, new Set(heldIds.split(" ")));
  }, [client, connected, canWrite, listedChats]);
  // every chat write (here, or in another tab of this browser) loads the list again
  const reloadChats = useRef(nav.catalog.reload);
  reloadChats.current = nav.catalog.reload;
  useEffect(() => subscribeRowWrites((remote) => { remoteReload.current = remote; reloadChats.current(); }), []);
  const building = nav.catalog.chats.some((chat) => chat.session_id === ready?.sessionId && chat.purpose === "page_build");
  const stateLabel = runStateLabel(state, composerActivity.queued, building);
  useApprovalIntent(state === "approval");
  const title = ready?.title ?? "new chat";
  const newPageChatReason = !connected ? "new chat is off until zeta is back" : !canWrite ? readOnlyReason
    : active.creatingChat ? "creating chat…" : ready?.controlledElsewhere ? undefined : empty || (ready && !ready.sent) ? ALREADY_NEW
    : undefined;
  const createMode: CreateModeOwner | undefined = !landing && activePage ? {
    available: connected && chatCanWrite && !active.creatingChat && (!active.toggleBlocked || active.toggleRetryable),
    enabled: activePage.create_mode, pending: active.toggling, error: active.toggleError,
    async toggle() {
      if (!createMode?.available || createMode.pending) return;
      await active.toggle();
    },
  } : undefined;
  // the chat's own model; a new chat shows zeta's default, the one it will start with
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  // a chat held elsewhere, or watched by an observer while zeta does not have it open, has no known model: show none, not the default
  const unknownSettings = Boolean(ready?.controlledElsewhere || ready?.settingsUnknown);
  const needsDefaultModel = connected && client !== null && (empty !== null || (ready !== null && !ready.model && !unknownSettings));
  useEffect(() => {
    if (!needsDefaultModel) return;
    let live = true;
    client!.request("state_settings", { collection: "mcp", limit: 1 }).then((result) => { if (live) setDefaultModel(parseDefaults(result)?.model ?? null); }, () => {});
    return () => { live = false; };
  }, [client, needsDefaultModel]);
  const serverForcesAsk = (ready ?? empty)?.serverApprovalMode === "ask";
  const composerModes = activePage && <ComposerModes model={unknownSettings ? null : ready?.model ?? defaultModel}
    create={createMode && { on: createMode.enabled, toggle: createMode.available ? createMode.toggle : undefined, busy: createMode.pending ? "saving…" : undefined,
      reason: !chatCanWrite ? chatReadOnlyReason : active.creatingChat ? "creating chat…" : active.toggleBlocked && !active.toggleRetryable ? "wait for page tools to refresh" : undefined }}
    approval={ready?.settingsUnknown ? undefined : { on: ready ? activePage.approval_mode === "allow" : active.build.approvalMode === "allow", toggle: chatCanWrite ? active.toggleApprovalMode : undefined,
      reason: !chatCanWrite ? chatReadOnlyReason : serverForcesAsk ? "this server requires tool approval" : !ready ? "start a chat to change tool approval" : undefined,
      busy: ready?.pendingApprovalMode && active.approvalChange?.pending ? "waiting for the turn to finish…" : active.approvalChange?.pending ? "saving…" : undefined,
      error: active.approvalChange?.error }} />;
  // "stay": focus goes to the shown chat's composer (the clicked button goes away)
  const stay = () => { void active.stay(); setPageChatFocusRequest((value) => value + 1); };
  const content = <>
    {activePage && historyOpen && <HistoryDialog key={activePage.id} pageId={activePage.id} credential={(ready ?? empty)!.credential} createMode={activePage.create_mode} opener={historyOpener} onClose={() => setHistoryOpen(false)} onChanged={() => setRestores((value) => value + 1)} canWrite={canWrite} disabledReason={readOnlyReason} />}
    {ready && agents?.sessionId === ready.sessionId && <ChatAgents key={ready.sessionId} client={client} store={store} sessionId={ready.sessionId} title={title} controls={childControls} send={childSend} readOnly={chatCanWrite ? undefined : chatReadOnlyReason} initialRun={agents.run} opener={agents.opener} onClose={() => setAgents(null)} />}
    {ready && tasksOpen?.sessionId === ready.sessionId && <BackgroundTasks key={ready.sessionId} client={client} sessionId={ready.sessionId} list={backgroundTasks} opener={tasksOpen.opener} onClose={() => setTasksOpen(null)} />}
    {activePage?.archived_at && <ArchivedBar key={activePage.id} page={activePage} onChanged={pageChanged} />}
    {activePage && active.toggleError && <div className="create-mode-alert" role="alert"><span>{active.toggleError}</span>{active.toggleRetryable && <button type="button" disabled={active.toggling} onClick={createMode?.toggle}>{active.toggling ? "retrying…" : "retry"}</button>}</div>}
    {lost && ready && failure && <ConnectionBanner state={connectionState} connection={connection} compact />}
    {unsentNew > 0 && <div className="create-mode-alert" role="status"><span>{unsentNew === 1 ? "1 unsent message" : `${unsentNew} unsent messages`} for a new chat</span><button type="button" onClick={active.openNewChat}>open</button></div>}
    {ready?.controlledElsewhere && <div className="chat-held-notice" role="status"><p><StableText text={heldText} reserve={Object.values(HELD_TEXT)} /></p><span className="chat-held-actions"><button type="button" className="ui-button" onClick={() => void active.newChat()} disabled={!canWrite}>new chat</button><button type="button" className="ui-button" aria-disabled={retryingHeld || undefined} onClick={() => { if (retryingHeld) return; setRenameRefused(false); setHeldRetry({ sessionId: ready.sessionId, lease: ready.lease }); active.retryAttachment(); }}><StableText text={retryingHeld ? "trying…" : "try again"} reserve={["try again", "trying…"]} /></button></span></div>}
    {active.busy?.limit ? <LimitNotice kind={active.busy.limit} className="chat-held-notice limit-notice" busy={active.busy} parked={active.busy.parked ?? []} stop={active.stop} chats={nav.catalog.chats} onScreen={Boolean(ready)} shownChat={ready ? nav.catalog.chats.find((chat) => chat.session_id === ready.sessionId) ?? null : null} onOpen={active.selectChat} onStop={() => void active.stopAndRetry()} onRetry={active.busy.limit === "resident" ? active.retryBusy : undefined} onRetryStopped={active.retryStopped} onStay={stay} canWrite={canWrite} />
      : active.busy && <BusyNotice busy={active.busy} openSessionId={ready?.sessionId ?? null} onOpen={active.openBusyChat} onRetry={active.retryBusy} canWrite={canWrite} />}
    {active.creationError ? <div className="full-state"><p role="alert">{active.creationError}</p>{keptNew.map((text, index) => <figure key={index} className="kept-message"><figcaption>kept, not sent</figcaption><blockquote>{text}</blockquote></figure>)}<div className="full-state-actions"><button className="primary" data-write-surface={WRITE_SURFACE.createRetry} autoFocus onClick={(event) => { event.currentTarget.focus(); if (canWrite) active.retrySaving(); }} disabled={!canWrite}>retry creating chat</button><button type="button" data-write-surface={WRITE_SURFACE.createDiscard} onClick={active.discardCreation} disabled={!canWrite}>start over</button></div></div>
      : active.state.phase === "missing" ? <div className="full-state"><p role="alert">this chat no longer exists</p><button className="primary" data-write-surface={WRITE_SURFACE.missingNewChat} onClick={active.newChat} disabled={!canWrite}>new chat</button></div>
      : active.state.phase === "error" && active.state.error === "page not found" ? <NotFoundState onNewChat={active.newChat} />
      : active.state.phase === "error" && active.state.error === TOO_MANY_CHATS ? <div className="full-state"><LimitNotice kind="resident" className="limit-state" parked={parked.map((row) => ({ sessionId: row.session_id, chat: nav.catalog.chats.find((chat) => chat.session_id === row.session_id) ?? null, finishing: false }))} stop={active.stop} chats={nav.catalog.chats} onOpen={active.selectChat} onStop={() => void active.stopAndRetry()} onRetry={active.retryLimit} onRetryStopped={active.retryStopped} onStay={stay} canWrite={canWrite} /></div>
      : active.state.phase === "error" ? <div className="full-state"><p role="alert">{active.state.error}</p></div>
      : busyPage ? <>{hasSurface(busyPage.page) && <PageSurface page={busyPage.page} credential={busyPage.credential} />}</>
      : failure && !lost ? <ConnectionBanner state={connectionState} connection={connection} />
      : !activePage || !activeStore ? <div className="full-state"><p role="status">{active.attachSlow ? "still connecting to this chat" : "loading chat…"}</p>{active.attachSlow && <button className="primary" type="button" onClick={active.retryAttachment}>Retry</button>}</div>
      : <RunProvider store={activeStore} loadMedia={loadMedia}>
        <div className={hasPageSurface ? "page-view docked" : "page-view"}>
        {hasPageSurface && <PageSurface page={activePage} credential={(ready ?? empty)!.credential} />}
        <div className={`page-chat${hasPageSurface ? " page-chat-docked" : ""}${pageChatSheetClosed ? " page-chat-sheet-closed" : ""}`}>
        {hasPageSurface && <button ref={pageChatButton} className="page-chat-bar" type="button" aria-expanded={pageChatSheetOpen} aria-controls="page-chat-sheet" onClick={() => setMobileChatOpen(true)}><span>Page chat</span>{state !== "idle" && <span className="page-chat-bar-state">{stateLabel}</span>}<span aria-hidden="true">⌃</span></button>}
        {pageChatSheetOpen && <div className="page-chat-backdrop" onClick={() => setMobileChatOpen(false)} />}
        <div ref={pageChatSurface} id="page-chat-sheet" className="page-chat-surface" role={pageChatSheetOpen ? "dialog" : undefined} aria-modal={pageChatSheetOpen ? "true" : undefined} aria-label={pageChatSheetOpen ? "page chat" : undefined} inert={pageChatSheetClosed}>
        {hasPageSurface && <PageChatHeader key={`${activePage.id}:${ready?.sessionId ?? "new"}:${pageChatSheetClosed}`} pageId={activePage.id} sessionId={ready?.sessionId ?? null} title={ready ? title : "Page chat"} state={state} stateLabel={stateLabel}
          onSelect={active.selectChat} newChat={newPageChatReason ? undefined : active.newChat} newReason={canWrite ? newPageChatReason : undefined}
          close={pageChatSheetOpen ? () => setMobileChatOpen(false) : undefined} closeRef={pageChatClose} />}
        <section ref={ready ? setTranscript : undefined} className="transcript" data-follow-request={followRequest}>{active.creatingChat ? <div className="full-state"><p role="status">creating chat…</p></div> : (!ready || Number(outlineLength) === 0) && <EmptyChat key={activePage.id} page={activePage} sessionId={ready?.sessionId ?? null} send={send} continueWaiting={active.continueWaitingChat} toggleCreateMode={createMode?.toggle ?? (async () => {})} credential={(ready ?? empty)!.credential} refreshKey={refreshKey} canWrite={chatCanWrite} />}{ready && <AuthRecoveryContext.Provider value={recovery}><BranchActionContext.Provider value={branchAction}><ToolDisclosure sessionId={ready.sessionId} cwd={ready.cwd}><SubAgentNavigationProvider value={agentNavigation}><Timeline renderers={appRenderers} virtual followRequest={followRequest} /></SubAgentNavigationProvider></ToolDisclosure></BranchActionContext.Provider></AuthRecoveryContext.Provider>}{ready && showJumpToLatest && <div data-part="jump-to-latest-lane" data-jump-owned="true"><button type="button" data-part="jump-to-latest" onMouseDown={(event) => event.preventDefault()} onClick={(event) => {
          // the button unmounts once the reader is at the bottom; a mouse click must not take focus from where it was (the composer)
          keyboardFocusToComposer(event);
          setFollowRequest((value) => value + 1);
          const scroll = transcript?.querySelector<HTMLElement>('[data-part="timeline-scroll"]');
          scroll?.scrollTo({ top: scroll.scrollHeight, behavior: "auto" });
        }} aria-label="jump to latest" title="jump to latest"><span data-jump-label="full">jump to latest</span><span data-jump-label="compact" aria-hidden="true">↓</span></button></div>}
        </section>
        {ready && branches.note && <p className="branch-note" role={branches.note.failed ? "alert" : "status"} data-failed={branches.note.failed ? "" : undefined}>{branches.note.text}</p>}
        <ComposerSlot key={ready?.sessionId ?? `new:${activePage.id}`} sessionId={ready?.sessionId ?? `new:${activePage.id}`} fromNewChat={ready && !ready.sent ? `new:${activePage.id}` : undefined} onActivity={setComposerActivity} focus={!active.creatingChat && (!ready || active.focusSessionId === ready.sessionId)} vim={chatCanWrite && settings.vim && !matchMedia("(pointer: coarse)").matches} questionWaiting={waiting > 0} focusRequest={pageChatFocusRequest} props={composerProps} client={client} chat={ready ? { id: ready.sessionId, title } : null} canWrite={chatCanWrite} controls={composerModes} />
        </div>
        </div>
        </div>
      </RunProvider>}
  </>;
  // a chat on a page that is not home belongs to Pages, as its header crumb says; the address decides, so loading and missing
  // pages agree. home belongs to Pages too once it shows a page
  const onPage = current === chatsRoute && (hasPageSurface || (location.pathname !== "/" && location.pathname !== homeAlias));
  const place = landing ? createRoute : current === createRoute ? chatsRoute : onPage ? pagesRoute : current;
  return renderShell({ current: place, nav, connectionStatus, banner: observerBanner, hasComposer: !landing && hasComposer,
    newChat: { available: canWrite && (!landing || active.state.phase === "empty"), pending: active.startingChat, run: () => void active.newChat() },
    workspace: landing ? undefined : { canWrite, serverForcesAsk, createMode },
    header: !landing && activePage && <ChatHeader page={activePage} docked={hasPageSurface} sessionId={ready?.sessionId ?? null} title={title} state={state} stateLabel={stateLabel} onRename={!chatCanWrite ? undefined : ready ? (id, text) => { void active.rename(id, text); } : undefined} onRenameRefused={ready?.controlledElsewhere ? refuseRename : undefined} onHistory={(opener) => { historyOpener.current = opener; setHistoryOpen(true); }} onAgents={ready ? (opener) => setAgents({ sessionId: ready.sessionId, opener }) : undefined} onPageChanged={pageChanged}
      tasks={ready && backgroundTasks.running > 0 ? { count: backgroundTasks.running, open: (opener) => setTasksOpen({ sessionId: ready.sessionId, opener }) } : undefined}

      branch={ready && branches.supported && <BranchSwitcher branches={branches.branches} disabledReason={branchOff} pending={branches.pending} onSelect={branches.select} />} />,
    children: (activity) => landing ? <CreateLanding build={active.build} nav={nav} activity={activity} client={client} /> : content,
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

// user-perceived characters: an emoji sequence (a family, a flag) is one, so a cut never splits it
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const graphemes = (text: string) => segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);

// zeta refused a swap: this tab keeps 3 chats running (parked_limit), or zeta is full (resident_limit). name the chats
// that hold the slots, and offer to stop the oldest (zeta's status order) and try the swap again, or to stay. the notice
// is a choice, not an error; focus moves into it, so the keyboard reaches its buttons next. it stays while a stop and its
// repeated swap run, and says so.
function LimitNotice({ kind, className, busy, parked, stop, chats, onScreen = false, shownChat = null, onOpen, onStop, onRetry, onRetryStopped, onStay, canWrite }: { kind: "parked" | "resident"; className: string; busy?: { retry: "attach" | "new"; target?: Chat | null }; parked: ParkedChat[]; stop: StopState | null; chats: readonly Chat[]; onScreen?: boolean; shownChat?: Chat | null; onOpen: (chat: Chat) => void; onStop: () => void; onRetry?: () => void; onRetryStopped: () => void; onStay: () => void; canWrite: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  // focus moves in when the notice shows, and back in after each change of it (a clicked button can go away) unless
  // the user is elsewhere (typing in the kept chat)
  const focused = useRef(false);
  useEffect(() => {
    const at = document.activeElement;
    // never out of a text field: the user is typing (the notice can mount again during a stop, so the ref alone misses it)
    if (userTyping() || (focused.current && at && at !== document.body && !element.current?.contains(at))) return;
    focused.current = true;
    element.current?.focus({ preventScroll: true });
  }, [kind, stop?.phase]);
  const chatOf = (sessionId: string) => parked.find((entry) => entry.sessionId === sessionId)?.chat ?? chats.find((chat) => chat.session_id === sessionId) ?? null;
  // two chats in the notice (or one in it and the one on screen) with one title get their time, and a short id when
  // the time is the same too, so each name means one chat
  const shown = [...parked.map((entry) => entry.chat), busy?.target ?? null, stop ? chatOf(stop.sessionId) : null, shownChat].filter((chat): chat is Chat => chat !== null);
  const timeOf = (chat: Chat) => new Date(chat.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }).toLowerCase();
  // [the quoted title, the suffix that tells twins apart ("" without twins)]; `clip` shortens the title inside the quotes
  const partsOf = (chat: Chat | null, clip = (title: string) => title): [string, string] => {
    if (!chat) return ["a chat", ""];
    const title = titleOf(chat);
    const twins = shown.filter((other) => other.session_id !== chat.session_id && titleOf(other) === title);
    if (twins.length === 0) return [`"${clip(title)}"`, ""];
    const time = timeOf(chat);
    return [`"${clip(title)}"`, ` (${time}${twins.some((other) => timeOf(other) === time) ? ` · ${chat.session_id.slice(0, 4)}` : ""})`];
  };
  const nameOf = (chat: Chat | null) => partsOf(chat).join("");
  const name = (sessionId: string) => nameOf(chatOf(sessionId));
  // the chat's name, as a link that opens it when achilles lists it; an anchor, so a long name wraps like the text around it
  const anchor = (chat: Chat, text: string) => <a className="link-button" href={chatHref(chat)} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(chat);
  }}>{text}</a>;
  const link = (sessionId: string) => { const chat = chatOf(sessionId); return chat ? anchor(chat, nameOf(chat)) : nameOf(chat); };
  const oldest = parked.find((entry) => !entry.finishing);
  // only the title shortens, as text (a clipped box keeps blank space after its ellipsis): the suffix that tells twins
  // apart stays whole, and the verb stays visible
  const clipped = (title: string) => { const chars = graphemes(title); return chars.length > 40 ? `${chars.slice(0, 39).join("").trimEnd()}…` : title; };
  const oldestName = partsOf(oldest ? chatOf(oldest.sessionId) : null, clipped);
  const stuck = stop?.phase === "still_stopping";
  // one line for the whole run, the stop and the repeated swap, until zeta answers
  const running = stop?.phase === "stopping" || stop?.phase === "retrying";
  const verb = kind === "resident" ? "try again" : busy?.retry === "new" ? "open new chat" : "switch";
  const target = busy?.retry === "new" ? "open a new chat" : busy?.target ? `open ${nameOf(busy.target)}` : "open that chat";
  const failed = stop?.phase === "failed" ? `${stop.error}. ` : "";
  const list = <>{parked.map((entry, at) => <span key={entry.sessionId}>{at > 0 && ", "}{entry.chat ? anchor(entry.chat, name(entry.sessionId)) : name(entry.sessionId)}{entry.finishing && " (finishing)"}</span>)}</>;
  // a refused swap after a stop: the stopped chat still holds work (it is parked), or zeta has not closed it yet
  const text = running ? <>stopping {link(stop.sessionId)}…</>
    : stuck ? stop.working ? <>{link(stop.sessionId)} is still finishing its background work. try again when it is done.</> : <>zeta has not freed {link(stop.sessionId)} yet. try again in a moment, or stay.</>
    : kind === "parked" ? <>{failed}this tab already keeps {parked.length === 1 ? "1 chat" : `${parked.length} chats`} running: {list}. zeta allows 3 per tab. stop one to {target} here, or stay.</>
    // resident: only this tab's own chats are named; the rest are other tabs' (or recently closed ones), which it cannot see
    : parked.length > 0 ? <>{failed}zeta has no room for another open chat. this tab holds {onScreen ? "the chat on screen and " : ""}{list}. stop one to {target}, try again later, or stay.</>
    : <>{failed}{TOO_MANY_CHATS}</>;
  return <div ref={element} className={className} role="alert" tabIndex={-1}>
    <p>{text}</p>
    <span className="chat-held-actions">
      {running ? <button type="button" className="ui-button" disabled>stopping…</button>
        : stuck ? <button type="button" className="ui-button" onClick={() => onRetryStopped()}>try again</button>
        : <>{onRetry && <button type="button" className="ui-button" onClick={onRetry}>try again</button>}
          {canWrite && oldest && <button type="button" className="ui-button limit-stop" data-write-surface={WRITE_SURFACE.busyRetry} onClick={onStop}>stop {oldestName.join("")} and {verb}</button>}</>}
      <button type="button" className="ui-button" onClick={onStay}>stay</button>
    </span>
  </div>;
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

const HELD_TEXT = {
  open: "this chat is open or kept running in another tab. you can read it here.",
  still: "still open or kept running in another tab. you can read it here.",
  rename: "rename this chat in the tab that has it open.",
};

// sized to the largest of its texts, so a text change does not move the layout; only the shown text is read out
function StableText({ text, reserve }: { text: string; reserve: string[] }) {
  return <span className="stable-text"><span>{text}</span>{reserve.filter((other) => other !== text).map((other) => <span key={other} aria-hidden="true">{other}</span>)}</span>;
}

function ChatHeader({ page, docked, sessionId, title, state, stateLabel, onRename, onRenameRefused, onHistory, onAgents, tasks, onPageChanged, branch }: { page: Page; docked: boolean; sessionId: string | null; title: string; state: string; stateLabel: string; onRename?: (sessionId: string, title: string) => void; onRenameRefused?: () => void; onHistory: (opener: HTMLElement | null) => void; onAgents?: (opener: HTMLElement | null) => void; tasks?: { count: number; open: (opener: HTMLElement | null) => void }; onPageChanged: () => void; branch?: ReactNode }) {
  const rename = useInlineRename();
  const titleControl = useRef<HTMLElement>(null);
  const startRename = () => { if (!onRename) return onRenameRefused?.(); if (sessionId) rename.start(title === "new chat" ? "" : title, (value) => onRename(sessionId, value)); };
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
    if (!onRename && !onRenameRefused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F2" || rename.editing || isEditableTarget(event)) return;
      event.preventDefault();
      startRename();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onRename, onRenameRefused, rename.editing, sessionId, title]);
  const titleNode = rename.editing
    ? <input className="chat-title-edit" aria-label="chat title" {...rename.bind()} />
    : <strong ref={titleControl} title={title} aria-label={title} data-write-surface={WRITE_SURFACE.headerRename} data-session-id={sessionId ?? undefined} role={onRename ? "button" : undefined} tabIndex={onRename ? 0 : undefined} onClick={startRename} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startRename(); } }}>{title}</strong>;
  const routeLabel = page.route === "/" ? "Home" : page.title;
  // the running count of this chat's background tasks; it opens their list. the name starts with the visible words
  const taskWords = tasks && `${tasks.count} ${tasks.count === 1 ? "task" : "tasks"}`;
  const agents = <>{tasks && <button type="button" className="chat-tasks-chip" aria-label={`${taskWords} running in the background`} onClick={(event) => tasks.open(event.currentTarget)}>{taskWords}</button>}
    {onAgents && <button type="button" onClick={(event) => onAgents(event.currentTarget)}>Agents</button>}</>;
  if (docked) return <header className="chat-header"><div className="chat-heading"><span className="page-crumb" title={routeLabel}>Pages <span aria-hidden="true">/</span> {page.id === "home" ? routeLabel : <PageCrumbMenu page={page} onChanged={onPageChanged} />}</span><span aria-hidden="true">/</span>{titleNode}</div><div className="chat-actions">{branch}{agents}<button type="button" onClick={(event) => onHistory(event.currentTarget)}>History</button></div></header>;
  return <header className="chat-header"><div className="chat-heading"><span title={routeLabel} aria-label={routeLabel}>{routeLabel}</span><span aria-hidden="true">/</span>{titleNode}</div><div className="chat-actions"><span className={`run-state state-${state}`} role="status" hidden={state === "idle"}>{stateLabel}</span>{branch}{agents}<button type="button" onClick={(event) => onHistory(event.currentTarget)}>History</button></div></header>;
}

const connectionHeadings: Partial<Record<ConnectionState["phase"], string>> = {
  not_running: "start zeta, and this page connects by itself.",
  controller_taken: "zeta is full",
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
