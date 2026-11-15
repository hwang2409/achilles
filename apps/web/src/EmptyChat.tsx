import { useEffect, useRef, useState } from "react";
import { draftStore } from "./draftStore";
import type { Page } from "./useActiveChat";
import { usePageTools, type PageTool } from "./page/usePageTools";

type Starter = { text: string; detail?: string; tag?: string; onSelect: () => void | Promise<void> };

const GENERIC_STARTERS = ["make a page that tracks something you care about", "add a tool to this page"];

const STARTER_TEXT_MAX = 80;

// A click sends exactly the text the button shows, so the starter text itself must already be
// short and sendable: the tool's description (written for a human) cut to its first sentence
// (split on the first ". " or newline), trailing period dropped, capped at STARTER_TEXT_MAX chars
// at a word boundary. A cut starter is still sent in full as shown — there is no longer text
// hiding behind it. Falls back to the tool name when that leaves nothing (no description, or a
// description that is only punctuation/whitespace). The full description remains available as
// the tooltip (see `detail` on the starter built from this).
export function toolStarterText(tool: PageTool): string {
  const description = tool.description.trim();
  if (!description) return `use ${tool.name}`;
  const cutAt = description.search(/\.\s|\n/);
  const sentence = (cutAt === -1 ? description : description.slice(0, cutAt)).replace(/\.$/, "").trim();
  if (!sentence) return `use ${tool.name}`;
  if (sentence.length <= STARTER_TEXT_MAX) return sentence;
  const hardCut = sentence.slice(0, STARTER_TEXT_MAX);
  const lastSpace = hardCut.lastIndexOf(" ");
  return (lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut).trim();
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
      ? resolvedTools.slice(0, 2).map((tool): Starter => {
          const text = toolStarterText(tool);
          const detail = tool.description.trim();
          return { text, detail: detail && detail !== text ? detail : undefined, onSelect: () => send1(text) };
        })
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
    <div className="chat-starters">{starters.map((starter, index) => <button key={index} disabled={sending} onClick={() => void select(starter.onSelect)}><b>{index + 1}</b><span title={starter.detail ?? starter.text}>{starter.text}</span>{starter.tag ? <i>{starter.tag}</i> : null}</button>)}</div>
  </div>;
}
