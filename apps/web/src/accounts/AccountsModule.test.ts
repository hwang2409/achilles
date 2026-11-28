import "../test-dom";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createElement } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ACCOUNT_LIST_IDLE_FEATURE, type Connection } from "../zeta";
import { createAccountLogin } from "./accountLogin";

// after test-dom: React must see the registered DOM.
const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { AccountsModule } = await import("./AccountsModule");

// The page reads the clock through Date.now; each test pins it and restores the real clock after.
const now = Date.parse("2026-11-28T12:00:00Z");
beforeEach(() => setSystemTime(now));
afterEach(() => { cleanup(); setSystemTime(); });

const at = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23" });
const old = "2026-11-14T10:00:00Z";
const recent = new Date(now - 5 * 60_000).toISOString();
// Synthetic accounts only. One seven-day window each; `read` is the snapshot time.
const account = (name: string, used: number, reset: string, { read = old, error = null as string | null, available = true, provider = "anthropic", flags = {} } = {}) => ({
  account: `${provider}:${name}`, label: name, detail: null, available, current: false, default: false, ...flags,
  usage: { freshness: now - Date.parse(read) > 15 * 60_000 ? "stale" : "now", error, snapshot: { version: 1, captured_at: read, source: "usage_endpoint", windows: [
    { kind: "seven_day", used_percent: used, window_minutes: 10080, resets_at: reset },
  ] } },
});

function mount(accounts: unknown[]) {
  const requests: unknown[] = [];
  const client = { features: [ACCOUNT_LIST_IDLE_FEATURE], authority: "controller",
    request: async (method: string, params: unknown) => { requests.push({ method, params }); return { revision: "a".repeat(64), data: { accounts } }; } } as unknown as ZetaClient;
  const connection = { client, retryNow() {}, withControl: async <T,>(read: (reader: ZetaClient) => Promise<T>) => ({ value: await read(client) }) };
  const login = createAccountLogin({ client: null, state: { phase: "connecting" }, takeControl: async () => null } as unknown as Pick<Connection, "client" | "state" | "takeControl">);
  return { requests, ...render(createElement(AccountsModule, { client, connecting: false, connection, login })) };
}

const row = async (name: string, provider = "anthropic") => within((await screen.findByRole("heading", { name: `${provider}:${name}` })).closest("li")!);
const windowLine = (scope: ReturnType<typeof within>) => scope.getByText(/· last read/).textContent;

test("a window whose reset passed says so with how long ago it was read, a muted bar, and no Available", async () => {
  mount([account("passed", 100, "2026-11-15T04:00:00Z")]);
  const passed = await row("passed");
  expect(windowLine(passed)).toBe("Reset passed · last read 14 days ago");
  expect(passed.getByText("14 days ago").getAttribute("title")).toBe(at.format(Date.parse(old)));
  expect(passed.getByText("14 days ago").getAttribute("datetime")).toBe(new Date(old).toISOString());
  expect(passed.queryByText(/resets/i)).toBeNull();
  expect(passed.getByRole("meter").hasAttribute("high")).toBe(false);
  expect(passed.getByRole("meter").closest(".account-window")!.getAttribute("data-stale")).toBe("true");
  // old usage does not block the account, but it does not read as available either
  expect(passed.getByText("Signed in").className).toBe("account-availability");
});

test("a full current window reads Limit reached once, a fresh normal window as Available, both with last read", async () => {
  mount([account("full", 100, "2026-11-30T10:35:00Z", { read: recent }), account("normal", 5, "2026-11-29T09:59:00Z", { read: recent })]);
  const full = await row("full");
  expect(full.getAllByText(/limit reached/i)).toHaveLength(1);
  expect(full.queryByText("Available")).toBeNull();
  expect(full.getByText("Limit reached").className).toBe("account-availability");
  expect(windowLine(full)).toBe(`Resets ${at.format(Date.parse("2026-11-30T10:35:00Z"))} · last read 5 minutes ago`);
  expect(full.getByRole("meter").getAttribute("high")).toBe("95");
  const normal = await row("normal");
  expect(normal.getByText("Available")).toBeTruthy();
  expect(windowLine(normal)).toBe(`Resets ${at.format(Date.parse("2026-11-29T09:59:00Z"))} · last read 5 minutes ago`);
});

test("a window turns to reset passed when its reset time arrives while the page is open", async () => {
  mount([account("soon", 100, new Date(now + 1_000).toISOString(), { read: recent })]);
  const soon = await row("soon");
  expect(soon.getByText("Limit reached")).toBeTruthy();
  setSystemTime(now + 60_000);
  await waitFor(() => expect(windowLine(soon)).toBe("Reset passed · last read 6 minutes ago"), { timeout: 3_000 });
  expect(soon.getByText("Signed in")).toBeTruthy();
});

// Invariant: whatever the account's shape, "Available" never sits next to a full or stale bar.
const shapes = [
  { name: "passed", used: 100, reset: "2026-11-15T04:00:00Z", options: {}, label: "Signed in" },
  { name: "full", used: 100, reset: "2026-11-30T10:35:00Z", options: { read: recent }, label: "Limit reached" },
  { name: "fullold", used: 100, reset: "2026-11-30T10:35:00Z", options: {}, label: "Limit reached" },
  { name: "staleread", used: 40, reset: "2026-12-09T10:59:00Z", options: {}, label: "Signed in" },
  { name: "autherror", used: 0, reset: "2026-12-09T10:59:00Z", options: { error: "authentication failed; log in again", provider: "codex" }, label: "Sign-in failed" },
  { name: "nologin", used: 0, reset: "2026-12-09T10:59:00Z", options: { available: false, read: recent }, label: "Needs sign-in" },
  { name: "normal", used: 47, reset: "2026-11-29T09:59:00Z", options: { read: recent }, label: "Available" },
] as const;

test("no row shows Available together with a full or stale bar", async () => {
  mount(shapes.map(({ name, used, reset, options }) => account(name, used, reset, options)));
  for (const { name, label, options } of shapes) {
    const scope = await row(name, "provider" in options ? options.provider : "anthropic");
    const meter = scope.getByRole("meter") as HTMLMeterElement;
    // a passed or old reading has no live limit colour (base marked it with data-reset-passed)
    const stale = meter.closest(".account-window")!.matches('[data-stale="true"], [data-reset-passed="true"]');
    if (scope.queryByText(/^available$/i)) expect([name, meter.value >= 100 || stale]).toEqual([name, false]);
    expect([name, scope.getByText(label, { selector: ".account-availability" }).textContent]).toEqual([name, label]);
  }
  expect(screen.getAllByText("Available")).toHaveLength(1);
});

test("a usage refresh that failed on sign-in says so, with the reason and a sign-in action", async () => {
  mount([account("orchard", 0, "2026-12-09T10:59:00Z", { error: "authentication failed; log in again", provider: "codex", read: "2026-11-09T15:59:00Z" })]);
  const orchard = await row("orchard", "codex");
  expect(orchard.queryByText(/^available$/i)).toBeNull();
  expect(orchard.getByText("Sign-in failed").className).toBe("account-availability");
  expect(orchard.getByText(/^Usage refresh failed/).textContent).toBe("Usage refresh failed: authentication failed; log in again");
  expect(windowLine(orchard)).toBe(`Resets ${at.format(Date.parse("2026-12-09T10:59:00Z"))} · last read 18 days ago`);
  expect(orchard.getByRole("meter").closest(".account-window")!.getAttribute("data-stale")).toBe("true");
  fireEvent.click(orchard.getByRole("button", { name: "sign in again to codex:orchard" }));
  const dialog = await screen.findByRole("dialog", { name: "review browser sign-in" });
  expect(dialog.textContent).toContain("start browser sign-in for codex:orchard");
  expect(dialog.textContent).toContain("signed in, but zeta reports authentication failed");
});

test("the stale banner counts the accounts it means", async () => {
  mount([account("a", 5, "2026-11-29T09:59:00Z"), account("b", 5, "2026-11-29T09:59:00Z"), account("c", 5, "2026-11-29T09:59:00Z", { read: recent })]);
  await row("a");
  expect(screen.getByText(/may be out of date/).textContent).toBe("Usage data for 2 of 3 accounts may be out of date.");
  cleanup();
  mount([account("a", 5, "2026-11-29T09:59:00Z"), account("b", 5, "2026-11-29T09:59:00Z")]);
  await row("a");
  expect(screen.getByText(/may be out of date/).textContent).toBe("Usage data for all 2 accounts may be out of date.");
});

test("coming back to the tab re-reads the clock at once and the accounts at most every 30 s", async () => {
  const { requests } = mount([account("soon", 100, new Date(now + 10 * 60_000).toISOString(), { read: recent })]);
  const soon = await row("soon");
  expect(requests).toHaveLength(1);
  // a sleep: the clock jumped past the reset, the 10 min timer has not fired yet
  setSystemTime(now + 11 * 60_000);
  fireEvent.focus(window);
  await waitFor(() => expect(requests).toHaveLength(2), { timeout: 500 });
  await waitFor(() => expect(windowLine(soon)).toBe("Reset passed · last read 16 minutes ago"), { timeout: 500 });
  fireEvent(document, new Event("visibilitychange"));
  fireEvent.focus(window);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(requests).toHaveLength(2);
  setSystemTime(now + 11 * 60_000 + 30_000);
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(requests).toHaveLength(3), { timeout: 500 });
  expect(screen.queryByText("Loading accounts…")).toBeNull();
});

test("arriving on the page moves focus to its title", async () => {
  mount([account("normal", 5, "2026-11-29T09:59:00Z", { read: recent })]);
  await row("normal");
  expect(document.activeElement?.tagName).toBe("H1");
  expect(document.activeElement?.textContent).toBe("Accounts");
});

test("the page has one title and one accounts label, in sentence case", async () => {
  mount([account("normal", 5, "2026-11-29T09:59:00Z", { read: recent, flags: { default: true, current: true } })]);
  const normal = await row("normal");
  expect(screen.getAllByRole("heading").filter(heading => heading.tagName !== "H3").map(heading => heading.textContent)).toEqual(["Accounts"]);
  expect(screen.getAllByLabelText(/^model accounts$/i).map(node => node.getAttribute("aria-label"))).toEqual(["Model accounts"]);
  expect([...normal.getByRole("heading").nextElementSibling!.children].map(node => node.textContent)).toEqual(["Available", "Default", "In use"]);
});
