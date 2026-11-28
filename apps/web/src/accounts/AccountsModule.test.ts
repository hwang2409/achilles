import "../test-dom";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createElement } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ACCOUNT_LIST_IDLE_FEATURE, type Connection } from "../zeta";
import { createAccountLogin } from "./accountLogin";

// after test-dom: React must see the registered DOM.
const { cleanup, render, screen, waitFor, within } = await import("@testing-library/react");
const { AccountsModule } = await import("./AccountsModule");

// The page reads the clock through Date.now; each test pins it and restores the real clock after.
const now = Date.parse("2026-11-28T12:00:00Z");
beforeEach(() => setSystemTime(now));
afterEach(() => { cleanup(); setSystemTime(); });

const at = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23" });
const captured = "2026-11-14T10:00:00Z";
// Synthetic accounts only: one window whose reset passed, one full current window, one normal window.
const account = (name: string, used: number, reset: string) => ({
  account: `anthropic:${name}`, label: name, detail: null, available: true, current: false, default: false,
  usage: { freshness: "now", error: null, snapshot: { version: 1, captured_at: captured, source: "usage_endpoint", windows: [
    { kind: "seven_day", used_percent: used, window_minutes: 10080, resets_at: reset },
  ] } },
});

function mount(accounts: unknown[]) {
  const client = { features: [ACCOUNT_LIST_IDLE_FEATURE], authority: "controller",
    request: async () => ({ revision: "a".repeat(64), data: { accounts } }) } as unknown as ZetaClient;
  const connection = { client, retryNow() {}, withControl: async <T,>(read: (reader: ZetaClient) => Promise<T>) => ({ value: await read(client) }) };
  const login = createAccountLogin({ client: null, state: { phase: "connecting" }, takeControl: async () => null } as unknown as Pick<Connection, "client" | "state" | "takeControl">);
  return render(createElement(AccountsModule, { client, connecting: false, connection, login }));
}

const row = async (name: string) => within((await screen.findByRole("heading", { name: `anthropic:${name}` })).closest("li")!);

test("a window whose reset passed says so with the read time and a neutral bar", async () => {
  mount([account("stale", 100, "2026-11-15T04:00:00Z")]);
  const stale = await row("stale");
  expect(stale.getByText(/^reset passed · last read/).textContent).toBe(`reset passed · last read ${at.format(Date.parse(captured))}`);
  expect(stale.queryByText(/resets/)).toBeNull();
  expect(stale.getByRole("meter").hasAttribute("high")).toBe(false);
  // old usage does not block the account
  expect(stale.getByText("available")).toBeTruthy();
});

test("a full current window reads as limit reached, a normal window as available", async () => {
  mount([account("full", 100, "2026-11-30T10:35:00Z"), account("normal", 5, "2026-11-29T09:59:00Z")]);
  const full = await row("full");
  expect(full.queryByText("available")).toBeNull();
  expect(full.getByText("limit reached").className).toBe("account-availability");
  expect(full.getByText(/^limit reached · resets/).textContent).toBe(`limit reached · resets ${at.format(Date.parse("2026-11-30T10:35:00Z"))}`);
  expect(full.getByRole("meter").getAttribute("high")).toBe("95");
  const normal = await row("normal");
  expect(normal.getByText("available")).toBeTruthy();
  expect(normal.getByText(/^resets/).textContent).toBe(`resets ${at.format(Date.parse("2026-11-29T09:59:00Z"))}`);
});

test("a window turns to reset passed when its reset time arrives while the page is open", async () => {
  mount([account("soon", 100, new Date(now + 50).toISOString())]);
  const soon = await row("soon");
  expect(soon.getByText("limit reached")).toBeTruthy();
  setSystemTime(now + 60_000);
  await waitFor(() => expect(soon.getByText(/^reset passed · last read/)).toBeTruthy(), { timeout: 2_000 });
  expect(soon.getByText("available")).toBeTruthy();
});

test("the page has one title", async () => {
  mount([account("normal", 5, "2026-11-29T09:59:00Z")]);
  await row("normal");
  expect(screen.getAllByRole("heading").filter(heading => heading.tagName !== "H3").map(heading => heading.textContent)).toEqual(["Accounts"]);
});
