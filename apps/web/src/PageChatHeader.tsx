import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { PageChatCatalog, timeLabel, titleOf, useOnScreen, type Chat } from "./surface/AgentNavAdapter";
import { buildLabel, buildTone, type BuildRow } from "./create/buildActivity";
import { restorableFocus } from "./keyboard";
import { NavIcon } from "./surface/SurfaceNav";
import { WRITE_SURFACE } from "./writeSurfaces";
import "./page-chat-header.css";

// the open chat is already new: the empty chat below says so, so the disabled + keeps this only as its tooltip
export const ALREADY_NEW = "already in a new chat";

export function PageChatHeader({ pageId, sessionId, title, state, stateLabel, onSelect, newChat, newReason, close, closeRef }: {
  pageId: string;
  sessionId: string | null;
  title: string;
  state: string;
  stateLabel: string;
  onSelect: (chat: Chat) => void;
  newChat?: () => void;
  newReason?: string;
  close?: () => void;
  closeRef: Ref<HTMLButtonElement>;
}) {
  const catalog = useContext(PageChatCatalog)!;
  const shownReason = newReason === ALREADY_NEW ? undefined : newReason;
  const chats = catalog.chats.filter((chat) => chat.page_id === pageId);
  const count = `${chats.length} ${chats.length === 1 ? "chat" : "chats"}`;
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const switcher = useRef<HTMLButtonElement>(null);
  const rows = () => Array.from(panel.current?.querySelectorAll<HTMLElement>("[data-popup-row]") ?? []);
  const dismiss = (restore = false) => {
    if (restore) switcher.current?.focus();
    setOpen(false);
  };
  const toggle = () => {
    if (open) return dismiss(true);
    catalog.clearSearch();
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const items = rows();
    const first = items.find((item) => item.matches('[aria-selected="true"]'))
      ?? items.find((item) => !item.matches('[aria-disabled="true"]')) ?? items[0];
    if (!panel.current.contains(document.activeElement) || document.activeElement === panel.current) (first ?? panel.current).focus();
  }, [open, chats.length, catalog.loading, catalog.error]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && event.target.isConnected && !panel.current?.contains(event.target) && !switcher.current?.contains(event.target)) {
        // Click runs after the browser's pointer focus change. Don't move focus away from the chosen control.
        const active = document.activeElement;
        dismiss(!restorableFocus(active) || panel.current?.contains(active));
      }
    };
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [open]);
  const keys = (event: KeyboardEvent) => {
    if (!open || event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
      return;
    }
    if (event.key === "Tab") { dismiss(true); return; }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = rows();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowUp" ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
    items[index]?.focus();
  };
  const select = (chat: Chat) => { dismiss(true); onSelect(chat); };
  return <>
    <div className="page-chat-head" data-popup={open ? "chats" : undefined} onKeyDown={keys}>
      <div className="page-chat-title-row">
        <button className="ui-button page-chat-switcher" type="button" ref={switcher} aria-label={`${title}, ${count}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? "page-chat-choices" : undefined} onClick={toggle}>
          <strong id="page-chat-title" title={title}>{title}</strong><NavIcon d="M4 6l4 4 4-4" />
        </button>
        <button className="ui-icon-button page-chat-icon" type="button" aria-label="new page chat" data-write-surface={WRITE_SURFACE.pageChatNew} title={newReason ?? "new page chat"} aria-describedby={shownReason ? "page-chat-new-reason" : !newChat && !newReason ? "tab-authority-description" : undefined} disabled={!newChat} onClick={newChat}><span aria-hidden="true">+</span></button>
        {close && <button className="ui-icon-button page-chat-icon page-chat-close" type="button" ref={closeRef} aria-label="close page chat" onClick={close}><span aria-hidden="true">×</span></button>}
      </div>
      <div className={`page-chat-readouts ui-status state-${state}`} role="status" hidden={state === "idle"}>{stateLabel}</div>
      {open && <div className="page-chat-popup" data-kind="chats" ref={panel} tabIndex={-1}>
        <div className="page-chat-popup-note" id="page-chat-count">{count} on this page</div>
        <div role="listbox" id="page-chat-choices" aria-labelledby="page-chat-count" aria-busy={catalog.loading}>
          {chats.map((chat) => <ChatChoice key={chat.session_id} chat={chat} current={chat.session_id === sessionId} onSelect={select} />)}
        </div>
        {catalog.error ? <div className="page-chat-popup-note" role="status">could not load chats <button type="button" tabIndex={-1} data-popup-row onClick={catalog.reload}>retry</button></div>
          : catalog.loading ? <div className="page-chat-popup-note" role="status">loading chats…</div>
          : !chats.length && <div className="page-chat-popup-note" role="status">no chats for this page{newChat ? " · use + to start one" : ""}</div>}
        {catalog.next && !catalog.loading && !catalog.error && <button className="page-chat-popup-note page-chat-more" type="button" tabIndex={-1} data-popup-row onClick={catalog.more}>load older chats</button>}
      </div>}
    </div>
    {shownReason && <div className="page-chat-new-reason" id="page-chat-new-reason">{shownReason}</div>}
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
