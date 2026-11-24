import { useContext, useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { PageChatCatalog, timeLabel, titleOf, useOnScreen, type Chat } from "./surface/AgentNavAdapter";
import { buildLabel, buildTone, type BuildRow } from "./create/buildActivity";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDown, Ellipsis, Plus, X } from "lucide-react";
import { WRITE_SURFACE } from "./writeSurfaces";

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
  const choices = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (popup !== "chats") return;
    const frame = requestAnimationFrame(() => {
      choices.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [popup]);
  const menu = useRef<HTMLButtonElement>(null);
  const modeItems = useRef<(HTMLDivElement | null)[]>([]);
  const confirm = useRef<HTMLButtonElement>(null);
  const focusMode = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { if (confirmation !== null) confirm.current?.focus(); }, [confirmation]);
  const finishConfirmation = () => { focusMode.current?.focus(); setConfirmation(null); };
  const changePopup = (kind: Popup, open: boolean) => {
    if (open && kind === "chats") catalog.clearSearch();
    if (kind === "modes") setConfirmation(null);
    setPopup((current) => open ? kind : current === kind ? null : current);
  };
  const modes = [
    { ...approval, id: WRITE_SURFACE.pageChatAutoApprove, label: "run tools without asking", enable: "run tools without asking", disable: "ask before running tools", on: "tools run without asking", off: "ask before running tools" },
    { ...create, id: WRITE_SURFACE.pageChatCreateMode, label: "create mode", enable: "allow this chat to change the page layout", disable: "limit this chat to changing page data", on: "create mode on", off: "data only" },
  ];
  const reason = (mode: Mode) => mode.reason ?? mode.pending;
  const menuStyle = "z-[60] w-[min(20rem,calc(100vw-2rem))] max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto overscroll-contain";
  const confirmationRow = (mode: (typeof modes)[number]) => <div className="mt-1 flex flex-wrap gap-2 border-t bg-muted p-2" role="region" aria-labelledby="page-chat-effect">
    <p className="basis-full text-sm" id="page-chat-effect">{mode.checked ? mode.disable : mode.enable}?</p>
    <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}><Button ref={confirm} role="button" size="sm" type="button" onClick={() => { finishConfirmation(); if (!reason(mode)) mode.action?.(); }}>confirm</Button></DropdownMenuItem>
    <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}><Button role="button" variant="outline" size="sm" type="button" onClick={finishConfirmation}>keep current</Button></DropdownMenuItem>
  </div>;
  return <>
    <div data-page-chat-head="" className="relative z-10 min-w-0 shrink-0 border-b px-4 py-1" data-approval-mode={approval.checked ? "allow" : "ask"} data-create-mode={create.checked ? "on" : "off"} data-popup={popup ?? undefined}>
      <div data-page-chat-title-row="" className="flex min-w-0 items-center gap-1">
        <DropdownMenu modal={false} open={popup === "chats"} onOpenChange={(open) => changePopup("chats", open)}>
          <DropdownMenuTrigger asChild><Button variant="ghost" className="h-11 min-w-0 flex-1 justify-start px-0 has-[>svg]:px-0" aria-label={`${title}, ${count}`} aria-haspopup="listbox">
            <strong id="page-chat-title" className="truncate" title={title}>{title}</strong><ChevronDown aria-hidden="true" />
          </Button></DropdownMenuTrigger>
          <DropdownMenuContent className={menuStyle} data-page-chat-popup="chats" role="listbox" aria-labelledby="page-chat-count" aria-busy={catalog.loading} align="start"
            ref={choices}>
            <DropdownMenuLabel id="page-chat-count">{count} on this page</DropdownMenuLabel>
            {chats.map((chat) => <ChatChoice key={chat.session_id} chat={chat} current={chat.session_id === sessionId} onSelect={onSelect} />)}
            {catalog.error ? <><DropdownMenuLabel role="status">could not load chats</DropdownMenuLabel><DropdownMenuItem onSelect={(event) => { event.preventDefault(); catalog.reload(); }}>retry</DropdownMenuItem></>
              : catalog.loading ? <DropdownMenuLabel role="status">loading chats…</DropdownMenuLabel>
              : !chats.length && <DropdownMenuLabel role="status">no chats for this page{newChat ? " · use + to start one" : ""}</DropdownMenuLabel>}
            {catalog.next && !catalog.loading && !catalog.error && <DropdownMenuItem onSelect={(event) => { event.preventDefault(); catalog.more(); }}>load older chats</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-lg" className="size-11" type="button" aria-label="new page chat" data-write-surface={WRITE_SURFACE.pageChatNew} title={newReason ?? "new page chat"} aria-describedby={newReason ? "page-chat-new-reason" : !newChat ? "tab-authority-description" : undefined} disabled={!newChat} onClick={newChat}><Plus aria-hidden="true" /></Button>
        <DropdownMenu modal={false} open={popup === "modes"} onOpenChange={(open) => changePopup("modes", open)}>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-lg" className="size-11" ref={menu} aria-label="page chat options"><Ellipsis aria-hidden="true" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent className={menuStyle} data-page-chat-popup="modes" align="end" aria-label="page chat options" onEscapeKeyDown={(event) => { if (confirmation !== null) { event.preventDefault(); finishConfirmation(); } }}>
            {modes.map((mode, index) => <div key={mode.id} role="none">
              <DropdownMenuCheckboxItem ref={(node) => { modeItems.current[index] = node; }} className="min-h-11" checked={mode.checked} data-write-surface={mode.id}
                disabled={Boolean(reason(mode) || !mode.action)} title={reason(mode)} aria-describedby={reason(mode) ? `${mode.id}-reason` : undefined}
                onSelect={(event) => { event.preventDefault(); focusMode.current = modeItems.current[index] ?? null; setConfirmation(index); }}>{mode.label}</DropdownMenuCheckboxItem>
              {reason(mode) && <div id={`${mode.id}-reason`} className="px-2 py-1.5 text-xs text-muted-foreground" role={mode.pending ? "status" : undefined}>{reason(mode)}</div>}
              {mode.error && <div className="px-2 py-1.5 text-xs text-destructive" role="alert">{mode.error}</div>}
              {mode.savedAt && <div className="px-2 py-1.5 text-xs text-muted-foreground" role="status">{mode.checked ? mode.on : mode.off} · saved <time dateTime={mode.savedAt.toISOString()}>{timeLabel(mode.savedAt.toISOString())}</time></div>}
            </div>)}
            {confirmation !== null && confirmationRow(modes[confirmation])}
          </DropdownMenuContent>
        </DropdownMenu>
        {close && <Button variant="ghost" size="icon-lg" className="size-11" type="button" ref={closeRef} aria-label="close page chat" onClick={close}><X aria-hidden="true" /></Button>}
      </div>
      <div className="truncate text-xs text-muted-foreground" role="status" data-chat-status={state} hidden={state === "idle"}>{stateLabel}</div>
    </div>
    {newReason && <div className="px-4 py-1 text-xs text-muted-foreground" id="page-chat-new-reason">{newReason}</div>}
  </>;
}

function ChatChoice({ chat, current, onSelect }: { chat: Chat; current: boolean; onSelect: (chat: Chat) => void }) {
  const catalog = useContext(PageChatCatalog)!;
  const seen = useOnScreen(chat.purpose === "page_build" ? chat.session_id : undefined, catalog.onScreen);
  const build = catalog.builds.find((row) => row.chat.session_id === chat.session_id);
  const label = chat.purpose === "page_build" ? build && buildLabel(build) : chat.last_state === "approval" ? "needs you" : chat.last_state ?? "idle";
  return <DropdownMenuItem ref={seen} role="option" aria-selected={current} className="min-h-11 gap-2 aria-selected:bg-accent" onSelect={() => onSelect(chat)}>
    <span data-page-chat-choice-title="" className="min-w-0 flex-1 truncate" title={titleOf(chat)}>{titleOf(chat)}</span>
    {label && <Badge variant="outline" className="rounded-sm" data-state={build && buildTone(build)}>{label}</Badge>}
    <time className="shrink-0 text-xs text-muted-foreground" dateTime={chat.updated_at}>{timeLabel(chat.updated_at)}</time>
  </DropdownMenuItem>;
}
