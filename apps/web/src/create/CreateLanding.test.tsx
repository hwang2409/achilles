import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { ACCOUNT_LIST_IDLE_FEATURE } from "../zeta/accounts";
import { CreateLanding } from "./CreateLanding";

const { createElement } = await import("react");
const { fireEvent, render, waitFor } = await import("@testing-library/react");

test("a guessed missing login shows a hint but keeps the build button and submit", async () => {
  // claude with no anthropic account: an API-key setup looks exactly like this, so the guess must not block the build
  const client = {
    features: [ACCOUNT_LIST_IDLE_FEATURE],
    request: async (method: string) => method === "state_settings"
      ? { model: null, provider: "claude", approval_mode: "ask", max_depth: 3 }
      : { revision: "0".repeat(64), data: { accounts: [] } },
  } as unknown as ZetaClient;
  let starts = 0;
  const build = { draft: "a reading list", setDraft() {}, start: async () => { starts += 1; }, pending: false, locked: false, unavailable: false, error: null, approvalMode: "ask" };
  const nav = { catalog: { items: [], error: null, loading: false, reload() {} }, pageCatalog: { items: [], error: null } };
  const activity = { rows: [], stale: false, refresh() {}, onScreen() {} };
  const view = render(createElement(CreateLanding, { client, build, nav, activity } as unknown as Parameters<typeof CreateLanding>[0]));
  try {
    await waitFor(() => expect(view.getByTestId("login-hint").textContent).toContain("zeta login anthropic"), { timeout: 1000 });
    fireEvent.click(view.getByRole("button", { name: "build page" }));
    expect(starts).toBe(1);
  } finally {
    view.unmount();
  }
});
