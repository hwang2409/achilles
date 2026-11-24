import { expect, test } from "bun:test";
import { createElement } from "react";
import { fireEvent, render } from "@testing-library/react";
import type { ZetaClient } from "@fulcrum/zeta";
import { SessionsModule } from "./SessionsModule";

test("opening a session or its transcript focuses the back link", async () => {
  const previous = location.href;
  history.replaceState(null, "", "/sessions");
  const client = {
    features: [],
    request: async (method: string) => {
      if (method === "list_sessions") return { sessions: [{ session_id: "sample", name: "Fixture session" }] };
      if (method === "status") return { session: { session_id: "sample" } };
      return {};
    },
  } as unknown as ZetaClient;
  const view = render(createElement(SessionsModule, { client, connecting: false, retry: () => {}, newChat: () => {}, chats: [], continueSession: async () => null }));
  try {
    fireEvent.click(await view.findByRole("link", { name: /Fixture session/ }));
    expect(document.activeElement === view.getByRole("link", { name: "← sessions" })).toBe(true);
    fireEvent.click(await view.findByRole("link", { name: "read transcript" }));
    expect(document.activeElement === view.getByRole("link", { name: "← session detail" })).toBe(true);
    fireEvent.click(view.getByRole("link", { name: "← session detail" }));
    fireEvent.click(view.getByRole("link", { name: "← sessions" }));
    expect(document.activeElement === view.getByRole("link", { name: /Fixture session/ })).toBe(true);
  } finally {
    view.unmount();
    history.replaceState(null, "", previous);
  }
});
