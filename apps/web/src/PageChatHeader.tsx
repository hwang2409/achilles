import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { PageChatCatalog, timeLabel, titleOf, useOnScreen, type Chat } from "./surface/AgentNavAdapter";
import { buildLabel, buildTone, type BuildRow } from "./create/buildActivity";
import { restorableFocus } from "./keyboard";
import { WRITE_SURFACE } from "./writeSurfaces";
import "./page-chat-header.css";

type Mode = {
  checked: boolean;
  action?: () => void;
  reason?: string;
  pending?: string;
  error?: string | null;
  savedAt?: Date;
};
type Popup = "chats" | "modes";

export function PageChatHeader({ pageId, sessionId, title, state, stateLabel, onSelect, newChat, newReason, approval, create, close, closeRef }: {
  pageId: string;
  sessionId: string | null;
  title: string;
  state: string;
  stateLabel: string;
  onSelect: (chat: Chat) => void;
  newChat?: () => void;
  newReason?: string;
  approval: Mode;
  create: Mode;
  close?: () => void;
  closeRef: Ref<HTMLButtonElement>;
}) {
  const catalog = useContext(PageChatCatalog)!;
  const chats = catalog.chats.filter((chat) => chat.page_id === pageId);
  const count = `${chats.length} ${chats.length === 1 ? "chat" : "chats"}`;
  const [popup, setPopup] = useState<Popup | null>(null);
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const switcher = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const rows = () => Array.from(panel.current?.querySelectorAll<HTMLElement>("[data-popup-row]") ?? []);
  const dismiss = (restore = false) => {
    if (restore) (popup === "chats" ? switcher : menu).current?.focus();
    setConfirmation(null);
    setPopup(null);
  };
  const open = (next: Popup) => {
    if (popup === next) return dismiss(true);
    if (next === "chats") catalog.clearSearch();
    setConfirmation(null);
    setPopup(next);
  };
  useLayoutEffect(() => {
    if (!popup || !panel.current) return;
    const items = rows();
    const first = items.find((item) => item.matches('[aria-selected="true"]'))
      ?? items.find((item) => !item.matches('[aria-disabled="true"]')) ?? items[0];
    if (!panel.current.contains(document.activeElement) || document.activeElement === panel.current) (first ?? panel.current).focus();
  }, [popup, chats.length, catalog.loading, catalog.error]);
  useLayoutEffect(() => { if (confirmation !== null) confirm.current?.focus(); }, [confirmation]);
  useEffect(() => {
    if (!popup) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && event.target.isConnected && !panel.current?.contains(event.target)
        && !switcher.current?.contains(event.target) && !menu.current?.contains(event.target)) {
        // Click runs after the browser's pointer focus change. Don't move focus away from the chosen control.
        const active = document.activeElement;
        dismiss(!restorableFocus(active) || panel.current?.contains(active));
      }
    };
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [popup]);
  const finishConfirmation = () => {
    if (confirmation !== null) rows()[confirmation]?.focus();
    setConfirmation(null);
  };
  const keys = (event: KeyboardEvent) => {
    if (!popup || event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (confirmation !== null) finishConfirmation(); else dismiss(true);
      return;
    }
    if (event.key === "Tab" && confirmation === null) { dismiss(true); return; }
    if (confirmation !== null || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = rows();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowUp" ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
    items[index]?.focus();
  };
  const select = (chat: Chat) => { dismiss(true); onSelect(chat); };
  const modes = [
    { ...approval, id: WRITE_SURFACE.pageChatAutoApprove, label: "run tools without asking", enable: "run tools without asking", disable: "ask before running tools", on: "tools run without asking", off: "ask before running tools" },
    { ...create, id: WRITE_SURFACE.pageChatCreateMode, label: "create mode", enable: "allow this chat to change the page layout", disable: "limit this chat to changing page data", on: "create mode on", off: "data only" },
  ];
  const reason = (mode: Mode) => mode.reason ?? mode.pending;
  return <>
    <div className="page-chat-head" data-approval-mode={approval.checked ? "allow" : "ask"} data-create-mode={create.checked ? "on" : "off"} data-popup={popup ?? undefined} onKeyDown={keys}>
      <div className="page-chat-title-row">
        <button className="ui-button page-chat-switcher" type="button" ref={switcher} aria-label={`${title}, ${count}`} aria-haspopup="listbox" aria-expanded={popup === "chats"} aria-controls={popup === "chats" ? "page-chat-choices" : undefined} onClick={() => open("chats")}>
          <strong id="page-chat-title" title={title}>{title}</strong><span aria-hidden="true">⌄</span>
        </button>
        <button className="ui-icon-button page-chat-icon" type="button" aria-label="new page chat" data-write-surface={WRITE_SURFACE.pageChatNew} title={newReason ?? "new page chat"} aria-describedby={newReason ? "page-chat-new-reason" : !newChat ? "tab-authority-description" : undefined} disabled={!newChat} onClick={newChat}><span aria-hidden="true">+</span></button>
        <button className="ui-icon-button page-chat-icon" type="button" ref={menu} aria-label="page chat options" aria-haspopup="menu" aria-expanded={popup === "modes"} aria-controls={popup === "modes" ? "page-chat-modes" : undefined} onClick={() => open("modes")}><span aria-hidden="true">⋯</span></button>
        {close && <button className="ui-icon-button page-chat-icon page-chat-close" type="button" ref={closeRef} aria-label="close page chat" onClick={close}><span aria-hidden="true">×</span></button>}
      </div>
      <div className={`page-chat-readouts ui-status state-${state}`} role="status" hidden={state === "idle"}>{stateLabel}</div>
      {popup === "chats" && <div className="page-chat-popup" data-kind="chats" ref={panel} tabIndex={-1}>
        <div className="page-chat-popup-note" id="page-chat-count">{count} on this page</div>
        <div role="listbox" id="page-chat-choices" aria-labelledby="page-chat-count" aria-busy={catalog.loading}>
          {chats.map((chat) => <ChatChoice key={chat.session_id} chat={chat} current={chat.session_id === sessionId} onSelect={select} />)}
        </div>
        {catalog.error ? <div className="page-chat-popup-note" role="status">could not load chats <button type="button" tabIndex={-1} data-popup-row onClick={catalog.reload}>retry</button></div>
          : catalog.loading ? <div className="page-chat-popup-note" role="status">loading chats…</div>
          : !chats.length && <div className="page-chat-popup-note" role="status">no chats for this page{newChat ? " · use + to start one" : ""}</div>}
        {catalog.next && !catalog.loading && !catalog.error && <button className="page-chat-popup-note page-chat-more" type="button" tabIndex={-1} data-popup-row onClick={catalog.more}>load older chats</button>}
      </div>}
      {popup === "modes" && <div className="page-chat-popup" data-kind="modes" ref={panel} tabIndex={-1}>
        <div role="menu" id="page-chat-modes" aria-label="page chat options">
          {modes.map((mode, index) => <div key={mode.id} role="none">
            <button type="button" className="page-chat-mode" role="menuitemcheckbox" data-popup-row data-write-surface={mode.id} tabIndex={-1} aria-checked={mode.checked}
              aria-disabled={Boolean(reason(mode) || !mode.action)} title={reason(mode)} aria-describedby={reason(mode) ? `${mode.id}-reason` : undefined}
              onClick={() => { if (!reason(mode) && mode.action) setConfirmation(index); }}>
              <span className="page-chat-mode-check" aria-hidden="true">{mode.checked ? "✓" : ""}</span>{mode.label}
            </button>
            {reason(mode) && <div id={`${mode.id}-reason`} className="page-chat-popup-note" role={mode.pending ? "status" : undefined}>{reason(mode)}</div>}
            {mode.error && <div className="page-chat-popup-note page-chat-error" role="alert">{mode.error}</div>}
            {mode.savedAt && <div className="page-chat-popup-note" role="status">{mode.checked ? mode.on : mode.off} · saved <time dateTime={mode.savedAt.toISOString()}>{timeLabel(mode.savedAt.toISOString())}</time></div>}
          </div>)}
        </div>
        {confirmation !== null && <div className="page-chat-confirm" role="region" aria-labelledby="page-chat-effect">
          <p id="page-chat-effect">{modes[confirmation].checked ? modes[confirmation].disable : modes[confirmation].enable}?</p>
          <button ref={confirm} type="button" onClick={() => { const mode = modes[confirmation]; finishConfirmation(); if (!reason(mode)) mode.action?.(); }}>confirm</button>
          <button type="button" onClick={finishConfirmation}>keep current</button>
        </div>}
      </div>}
    </div>
    {newReason && <div className="page-chat-new-reason" id="page-chat-new-reason">{newReason}</div>}
  </>;
}

function ChatChoice({ chat, current, onSelect }: { chat: Chat; current: boolean; onSelect: (chat: Chat) => void }) {
  const catalog = useContext(PageChatCatalog)!;
  const seen = useOnScreen(chat.purpose === "page_build" ? chat.session_id : undefined, catalog.onScreen);
  return <button ref={seen} type="button" className="page-chat-choice" role="option" data-popup-row tabIndex={-1} aria-selected={current} onClick={() => onSelect(chat)}>
    <span className="page-chat-choice-title" title={titleOf(chat)}>{titleOf(chat)}</span>
    {chat.purpose === "page_build" ? <BuildState build={catalog.builds.find((row) => row.chat.session_id === chat.session_id)} /> : <span className={`page-chat-status state-${chat.last_state ?? "idle"}`}>{chat.last_state === "approval" ? "needs you" : chat.last_state ?? "idle"}</span>}
    <time dateTime={chat.updated_at}>{timeLabel(chat.updated_at)}</time>
  </button>;
}

// A page build's state comes only from the build owner (create/buildActivity), in the nav's words; no row is no claim.
function BuildState({ build }: { build?: BuildRow }) {
  const label = build && buildLabel(build);
  return label ? <span className={`page-chat-status state-${buildTone(build) ?? "idle"}`} title={label}>{label}</span> : <span />;
}
