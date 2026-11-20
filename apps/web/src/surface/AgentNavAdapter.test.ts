import "../test-dom";
import { expect, test } from "bun:test";
import { createElement } from "react";
import { useAgentNavAdapter, type Chat } from "./AgentNavAdapter";

const { render, waitFor } = await import("@testing-library/react");

test("the completed build row replaces persisted running while ordinary and unknown rows keep it", async () => {
  const running: Chat = { session_id: "build", purpose: "page_build", page_id: "home", page_route: "/", page_title: "home", title: "reading list build", last_state: "running", created_at: "2030-01-01", updated_at: "2030-01-01" };
  const ordinary: Chat = { ...running, purpose: "chat", session_id: "ordinary" };
  const unknown = { ...running, session_id: "unknown" };
  const observed = (chat: Chat) => ({ chat, state: "done" as const, stale: false });
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => String(input).startsWith("/api/chats")
    ? Response.json({ chats: [running, ordinary, unknown], next: null, approval_count: 0 })
    : Response.json({ pages: [], next: null }), { preconnect: original.preconnect });
  const View = () => {
    const nav = useAgentNavAdapter({ sessionId: null, waiting: 0, canWrite: false, refreshKey: 0, pageRefreshKey: 0 });
    return nav.recent(() => {}, [observed(running), observed(ordinary)]);
  };
  const app = render(createElement(View));
  try {
    await waitFor(() => expect(app.container.querySelector('[data-chat-id="unknown"]')).not.toBeNull());
    const label = (id: string) => app.container.querySelector(`[data-chat-id="${id}"] .chat-row-meta`)?.textContent;
    expect(label("build")).toBe("done · home");
    expect(label("ordinary")).toBe("running · home");
    expect(label("unknown")).toBe("running · home");
    expect(running.last_state).toBe("running");
  } finally { app.unmount(); globalThis.fetch = original; }
});
