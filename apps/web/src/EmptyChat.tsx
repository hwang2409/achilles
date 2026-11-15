import { useEffect, useRef, useState } from "react";
import { draftStore } from "./draftStore";
import type { Page } from "./useActiveChat";
import { usePageTools, type PageTool } from "./page/usePageTools";

type Starter = { text: string; tag?: string; onSelect: () => void | Promise<void> };

const GENERIC_STARTERS = ["make a page that tracks something you care about", "add a tool to this page"];

// The tool's own description is the starter text (it's written for a human); the tool name is
// internal and only backs it up when a tool has no description.
function toolStarterText(tool: PageTool): string {
  return tool.description.trim() || `use ${tool.name}`;
}

function useHasWaitingChat(): boolean {
  const [hasWaiting, setHasWaiting] = useState(false);
  useEffect(() => {
    let live = true;
    void fetch("/api/chats?limit=1", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() as Promise<{ approval_count: number }> : null))
      .then((value) => { if (live && value) setHasWaiting(value.approval_count > 0); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return hasWaiting;
}

export function EmptyChat({ page, sessionId, send, continueWaiting, toggleCreateMode, credential, refreshKey }: { page: Page; sessionId: string | null; send: (text: string, intent: { steer: boolean }, track: (id: string) => void) => Promise<void>; continueWaiting: () => Promise<void>; toggleCreateMode: () => Promise<void>; credential: string; refreshKey: string }) {
  const { tools, error } = usePageTools(page.id, credential, refreshKey);
  const hasWaitingChat = useHasWaitingChat();
  const send1 = async (text: string) => {
    try {
      await send(text, { steer: false }, () => {});
    } catch {
      // A chat that is already attached (ready, empty transcript) runs the toggle's network call
      // right here; if it fails, send() rejects before the text goes anywhere. Keep it as the
      // composer draft, like createFirstChat does for a brand-new chat — but only when the
      // composer is empty. The composer for this session is already mounted here, so writing
      // unconditionally would erase text the user already typed.
      if (sessionId && !draftStore.get(sessionId).trim()) draftStore.set(sessionId, text);
    }
  };
  // A creation starter needs create mode's tools, so it turns create mode on first, through the
  // same path (and the same refresh-failure handling) as the header toggle, then sends. If the
  // toggle's tool refresh fails, the header's notice shows and send()'s own guard holds the message.
  const sendWithCreateMode = async (text: string) => {
    if (!page.create_mode) await toggleCreateMode();
    await send1(text);
  };
  const resolvedTools = error ? [] : tools;
  const pageStarters = resolvedTools === null ? []
    : resolvedTools.length > 0
      ? resolvedTools.slice(0, 2).map((tool): Starter => ({ text: toolStarterText(tool), onSelect: () => send1(toolStarterText(tool)) }))
      : GENERIC_STARTERS.map((text): Starter => ({ text, tag: "create mode", onSelect: () => sendWithCreateMode(text) }));
  const starters: Starter[] = [
    ...pageStarters,
    ...(hasWaitingChat ? [{ text: "continue your waiting chat", tag: "waiting chat", onSelect: continueWaiting }] : []),
  ];
  // Guards a double click (or two different starters clicked fast): only one starter runs at a
  // time, so a second click never fires a second send or a second create-mode toggle.
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const select = async (onSelect: () => void | Promise<void>) => {
    if (sendingRef.current) return;
    sendingRef.current = true; setSending(true);
    try { await onSelect(); } finally { sendingRef.current = false; setSending(false); }
  };
  return <div className="empty-chat">
    <h1 title={`new chat on ${page.title}`}>new chat on {page.title}</h1>
    <p>create mode is only for making or changing pages and tools; tools already assigned to this page work with it on or off.</p>
    <div className="chat-starters">{starters.map((starter, index) => <button key={index} disabled={sending} onClick={() => void select(starter.onSelect)}><b>{index + 1}</b><span title={starter.text}>{starter.text}</span>{starter.tag ? <i>{starter.tag}</i> : null}</button>)}</div>
  </div>;
}
