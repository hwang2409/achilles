import { useEffect, useState } from "react";
import type { Page } from "./useActiveChat";
import { usePageTools, type PageTool } from "./page/usePageTools";

type Starter = { text: string; tag?: string; onSelect: () => void };

const VERB_BY_OPERATION: Record<string, string> = {
  insert: "add a record with",
  update: "update a record with",
  get: "look up a record with",
  list: "list records with",
  delete: "delete a record with",
};

const GENERIC_STARTERS = ["make a page that tracks something you care about", "add a tool to this page"];

function toolStarterText(tool: PageTool): string {
  return `${VERB_BY_OPERATION[tool.operation] ?? "use"} ${tool.name}`;
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

export function EmptyChat({ page, send, continueWaiting, credential, refreshKey }: { page: Page; send: (text: string, intent: { steer: boolean }, track: (id: string) => void) => Promise<void>; continueWaiting: () => Promise<void>; credential: string; refreshKey: string }) {
  const { tools, error } = usePageTools(page.id, credential, refreshKey);
  const hasWaitingChat = useHasWaitingChat();
  const send1 = (text: string) => void send(text, { steer: false }, () => {});
  const resolvedTools = error ? [] : tools;
  const pageStarters = resolvedTools === null ? []
    : resolvedTools.length > 0
      ? resolvedTools.slice(0, 2).map((tool): Starter => ({ text: toolStarterText(tool), tag: tool.name, onSelect: () => send1(toolStarterText(tool)) }))
      : GENERIC_STARTERS.map((text): Starter => ({ text, tag: "create mode", onSelect: () => send1(text) }));
  const starters: Starter[] = [
    ...pageStarters,
    ...(hasWaitingChat ? [{ text: "continue your waiting chat", tag: "waiting chat", onSelect: () => void continueWaiting() }] : []),
  ];
  return <div className="empty-chat">
    <h1 title={`new chat on ${page.title}`}>new chat on {page.title}</h1>
    <p>create mode is only for making or changing pages and tools; tools already assigned to this page work with it on or off.</p>
    <div className="chat-starters">{starters.map((starter, index) => <button key={starter.text} onClick={starter.onSelect}><b>{index + 1}</b><span>{starter.text}</span>{starter.tag ? <i>{starter.tag}</i> : null}</button>)}</div>
  </div>;
}
