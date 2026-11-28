import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import type { ZetaClient } from "@fulcrum/zeta";

// after test-dom: React must see the registered DOM.
const { cleanup, render, screen, within } = await import("@testing-library/react");
const { SessionsModule } = await import("./SessionsModule");
const { sessionOwned } = await import("../chat/continuation");

const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); history.replaceState(null, "", "/"); globalThis.fetch = realFetch; });

/** answers achilles' never-sent read; `settle` lets that answer render */
function unsentRead(reply: () => Response) {
  globalThis.fetch = (async (url: string) => {
    if (url !== "/api/chats/unsent") throw new Error(`unexpected fetch ${url}`);
    return reply();
  }) as unknown as typeof fetch;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const catalogTitles = () => [...screen.getByRole("region", { name: "session catalog" }).querySelectorAll(".sessions-rows strong")].map((node) => node.textContent);

const state = (id: string, open: number) => ({ session_id: id, status: "idle", child_count: 0, background_count: 0, attention_open: open });
function mount(open: Record<string, number>, path = "/", extra: Record<string, object> = {}, continueSession = async (_id: string) => null) {
  const ids = Object.keys(open);
  const client = {
    features: ["list_sessions_paging", "state_read_v1"],
    request: async (method: string, params: { session_id?: string; collection?: string }) => {
      if (method === "list_sessions") return { sessions: ids.map((id) => ({ session_id: id, name: `synthetic ${id}`, project_id: null, ...extra[id] })), next_offset: null };
      if (method === "state_sessions") return { items: ids.map((id) => state(id, open[id]!)), next_cursor: null };
      if (method === "state_session") return { collection: params.collection, session: state(params.session_id!, open[params.session_id!]!), items: [], next_cursor: null };
      if (method === "status") return { session: null };
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as ZetaClient;
  history.replaceState(null, "", path);
  return render(createElement(SessionsModule, { client, connecting: false, retry: () => {}, newChat: () => {}, chats: [], continueSession, advertised: () => true }));
}

const field = async (label: string) => (await screen.findByText(label, { selector: "dt" })).nextElementSibling as HTMLElement;

test("detail: zero open attention is plain text, more than zero links to the attention place", async () => {
  mount({ none: 0, some: 3 }, "/sessions/none");
  const zero = await field("attention");
  expect([zero.textContent, !!within(zero).queryByRole("link")]).toEqual(["0", false]);
  cleanup();
  mount({ none: 0, some: 3 }, "/sessions/some");
  const link = within(await field("attention")).getByRole("link", { name: "3 open" });
  expect(link.getAttribute("href")).toBe("/sessions/some/attention");
});

test("catalog rows show an open attention count only when it is above zero", async () => {
  mount({ none: 0, one: 1, some: 3 });
  const row = async (id: string) => (await screen.findByText(`synthetic ${id}`)).closest("a")!;
  expect((await row("some")).textContent).toContain("3 open decisions");
  expect((await row("one")).textContent).toContain("1 open decision");
  expect((await row("one")).textContent).not.toContain("decisions");
  expect((await row("none")).textContent).not.toContain("open");
});

test("continue in chat stays enabled for a session in this zeta's reconnect grace", async () => {
  const continued: string[] = [];
  mount({ grace: 0 }, "/sessions/grace", { grace: { in_use: true, resident: true } }, async (id) => { continued.push(id); return null; });
  const button = await screen.findByRole("button", { name: "continue in chat" });
  expect([button.hasAttribute("disabled"), screen.queryByText(sessionOwned)]).toEqual([false, null]);
  button.click();
  expect(continued).toEqual(["grace"]);
});

test("a session held by another process keeps the owned notice", async () => {
  mount({ other: 0 }, "/sessions/other", { other: { in_use: true, resident: false } });
  const button = await screen.findByRole("button", { name: "continue in chat" });
  expect([button.hasAttribute("disabled"), !!(await screen.findByText(sessionOwned))]).toEqual([true, true]);
});

test("a never-sent achilles chat is hidden from the catalog", async () => {
  unsentRead(() => Response.json({ session_ids: ["draft"] }));
  mount({ sent: 0, draft: 0 });
  await screen.findByText("synthetic sent");
  await settle();
  expect(catalogTitles()).toEqual(["synthetic sent"]);
});

test("the selected never-sent chat stays listed while other never-sent chats hide", async () => {
  unsentRead(() => Response.json({ session_ids: ["draft", "other"] }));
  mount({ sent: 0, draft: 0, other: 0 }, "/sessions/draft");
  await screen.findByText("synthetic sent");
  await settle();
  expect(catalogTitles().sort()).toEqual(["synthetic draft", "synthetic sent"]);
});

test("a failed never-sent read hides nothing", async () => {
  unsentRead(() => new Response("down", { status: 500 }));
  mount({ sent: 0, draft: 0 });
  await screen.findByText("synthetic sent");
  await settle();
  expect(catalogTitles().sort()).toEqual(["synthetic draft", "synthetic sent"]);
});

test("a session with no name and no first message is labelled, not shown by its bare id", async () => {
  mount({ "0123456789abcdef": 0 }, "/", { "0123456789abcdef": { name: null } });
  await screen.findByRole("region", { name: "session catalog" });
  expect(catalogTitles()).toEqual(["no user message · 01234567"]);
});
