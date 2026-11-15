import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { EmptyChat } from "./EmptyChat";
import { draftStore } from "./draftStore";
import type { Page } from "./useActiveChat";

const originalFetch = globalThis.fetch;

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(cleanup);

afterAll(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

// usePageTools and useHasWaitingChat both fetch; stub both so the generic (create-mode) starters
// render with no waiting-chat starter in the mix.
function stubFetch() {
  globalThis.fetch = ((url: string) => {
    if (String(url).includes("/tools")) return Promise.resolve(new Response(JSON.stringify({ tools: [] }), { headers: { "content-type": "application/json" } }));
    if (String(url).includes("/api/chats")) return Promise.resolve(new Response(JSON.stringify({ approval_count: 0 }), { headers: { "content-type": "application/json" } }));
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  }) as typeof fetch;
}

function page(createMode: boolean): Page {
  return { id: "page-1", route: "/", title: "home", zeta_session_id: null, workspace: "default", create_mode: createMode, layout: { blocks: [] } };
}

async function renderEmptyChat(props: {
  sessionId: string | null;
  send: (text: string, intent: { steer: boolean }, track: (id: string) => void) => Promise<void>;
  toggleCreateMode: () => Promise<void>;
  createMode?: boolean;
}) {
  stubFetch();
  const result = render(React.createElement(EmptyChat, {
    page: page(props.createMode ?? false),
    sessionId: props.sessionId,
    send: props.send,
    continueWaiting: async () => {},
    toggleCreateMode: props.toggleCreateMode,
    credential: `cred-${Math.random()}`,
    refreshKey: "0:0",
  }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return result;
}

describe("EmptyChat starters", () => {
  test("keeps the starter's text as the composer draft when the toggle is already blocked and send rejects", async () => {
    const toggleCreateMode = async () => {}; // same shape as the ready-phase header toggle: resolves even though it left the send path blocked
    const send = async () => { throw new Error("send is off until page tools refresh. retry create mode."); };
    const result = await renderEmptyChat({ sessionId: "session-1", send, toggleCreateMode });
    const button = result.getAllByRole("button")[0];

    expect(draftStore.get("session-1")).toBe("");
    await act(async () => { fireEvent.click(button); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(draftStore.get("session-1")).toBe("make a page that tracks something you care about");
  });

  test("ignores a second click while the first starter is still sending", async () => {
    let resolveSend!: () => void;
    let calls = 0;
    const send = () => { calls += 1; return new Promise<void>((resolve) => { resolveSend = resolve; }); };
    const toggleCreateMode = async () => {};
    const result = await renderEmptyChat({ sessionId: "session-2", send, toggleCreateMode });
    const button = result.getAllByRole("button")[0];

    await act(async () => { fireEvent.click(button); await Promise.resolve(); });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(calls).toBe(1);

    await act(async () => { resolveSend(); await Promise.resolve(); await Promise.resolve(); });
    expect(button.hasAttribute("disabled")).toBe(false);
  });
});
