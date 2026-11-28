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

// `control.hold` keeps the next account_list in flight; `control.fail` makes it throw.
function mount(accounts: unknown[], started: unknown = { state: "succeeded" }) {
  const requests: unknown[] = [];
  const control = { hold: null as Promise<void> | null, fail: false };
  const client = { features: [ACCOUNT_LIST_IDLE_FEATURE], authority: "controller", onClose: () => () => {},
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "login_start") return started;
      await control.hold;
      if (control.fail) throw new Error("synthetic read failure");
      return { revision: "a".repeat(64), data: { accounts } };
    } } as unknown as ZetaClient;
  const connection = { client, retryNow() {}, withControl: async <T,>(read: (reader: ZetaClient) => Promise<T>) => ({ value: await read(client) }) };
  const popup = { opener: {}, closed: false, close() {}, location: { replace() {} } };
  const login = createAccountLogin({ client, state: { phase: "connected", authority: "controller" }, takeControl: async () => null } as unknown as Pick<Connection, "client" | "state" | "takeControl">, () => popup);
  return { requests, control, login, ...render(createElement(AccountsModule, { client, connecting: false, connection, login })) };
}
const held = () => { let release = () => {}; const hold = new Promise<void>(resolve => { release = resolve; }); return { hold, release }; };

const row = async (name: string, provider = "anthropic") => within((await screen.findByRole("heading", { name: `${provider}:${name}` })).closest("li")!);
const windowLine = (scope: ReturnType<typeof within>) => scope.getByText(/· last read/).textContent;

test("a window whose reset passed says so with how long ago it was read, a muted bar, and no Available", async () => {
  mount([account("passed", 100, "2026-11-15T04:00:00Z")]);
  const passed = await row("passed");
  expect(windowLine(passed)).toBe("Reset passed · last read 14 days ago");
  expect(passed.getByText(/% used$/).textContent).toBe("Was 100% used");
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
  { name: "autherror", used: 0, reset: "2026-12-09T10:59:00Z", options: { error: "authentication failed; log in again", provider: "codex" }, label: "Sign-in expired" },
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

const orchardRow = () => account("orchard", 0, "2026-12-09T10:59:00Z", { error: "authentication failed; log in again", provider: "codex", read: "2026-11-09T15:59:00Z" });
// The auth error reads as one status, one read-time line, and one sign-in action; zeta's "log in" wording never shows.
async function expectSignInExpired(orchard: ReturnType<typeof within>) {
  expect(orchard.getByText("Sign-in expired").className).toBe("account-availability");
  expect(orchard.getByRole("heading").closest("li")!.textContent).not.toMatch(/log in|authentication failed|refresh failed/i);
  expect(windowLine(orchard)).toBe(`Resets ${at.format(Date.parse("2026-12-09T10:59:00Z"))} · last read 18 days ago`);
  expect(orchard.getByRole("button", { name: "Sign in again to codex:orchard" }).textContent).toBe("Sign in again");
}

test("a usage refresh that failed on sign-in says so once, with the read time and a sign-in action", async () => {
  mount([orchardRow()]);
  const orchard = await row("orchard", "codex");
  expect(orchard.queryByText(/^available$/i)).toBeNull();
  // m-4: the action sits with the status, not in a row of its own (casing checked below)
  expect(orchard.getByRole("button", { name: /^sign in again to codex:orchard$/i }).parentElement!.className).toBe("account-identity");
  await expectSignInExpired(orchard);
  expect(orchard.getByRole("meter").closest(".account-window")!.getAttribute("data-stale")).toBe("true");
  fireEvent.click(orchard.getByRole("button", { name: "Sign in again to codex:orchard" }));
  const dialog = await screen.findByRole("dialog", { name: "Review browser sign-in" });
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
  const { requests, control } = mount([account("soon", 100, new Date(now + 10 * 60_000).toISOString(), { read: recent })]);
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
  const read = held();
  control.hold = read.hold;
  try {
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(requests).toHaveLength(3), { timeout: 500 });
    // the wake read is in flight: the rows stay, with no loading state
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByText("Loading accounts…")).toBeNull();
    expect(screen.getByRole("list", { name: "Model accounts" })).toBeTruthy();
  } finally { read.release(); }
});

test("a failed wake read keeps the rows and says it could not refresh", async () => {
  const { requests, control } = mount([account("normal", 5, "2026-11-29T09:59:00Z", { read: recent })]);
  await row("normal");
  control.fail = true;
  setSystemTime(now + 30_000);
  fireEvent.focus(window);
  await waitFor(() => expect(requests).toHaveLength(2), { timeout: 500 });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Could not refresh accounts. Showing the last read."), { timeout: 500 });
  expect(screen.queryByText("Could not load accounts")).toBeNull();
  expect(screen.getByRole("list", { name: "Model accounts" })).toBeTruthy();
  expect((await row("normal")).getByText("Available")).toBeTruthy();
  // the next good read clears the note
  control.fail = false;
  setSystemTime(now + 60_000);
  fireEvent.focus(window);
  await waitFor(() => expect(requests).toHaveLength(3), { timeout: 500 });
  await waitFor(() => expect(screen.queryByText(/Could not refresh accounts/)).toBeNull(), { timeout: 500 });
});

test("another usage refresh error keeps its line next to the status", async () => {
  mount([account("busy", 10, "2026-12-09T10:59:00Z", { error: "rate limited; retry later", read: recent })]);
  const busy = await row("busy");
  expect(busy.getByText(/^Usage refresh failed/).textContent).toBe("Usage refresh failed: rate limited; retry later");
  expect(busy.getByText("Available")).toBeTruthy();
});

test("after a good sign-in from this page, the row drops zeta's older auth error from its label and its lines", async () => {
  const { login } = mount([account("orchard", 0, "2026-12-09T10:59:00Z", { error: "authentication failed; log in again", provider: "codex", read: "2026-11-09T15:59:00Z" })]);
  const orchard = await row("orchard", "codex");
  expect(orchard.getByText("Sign-in expired")).toBeTruthy();
  await login.start({ provider: "codex", account: "codex:orchard" });
  // zeta's re-read catalog still carries the error: only a usage refresh rewrites it
  await waitFor(() => expect(screen.getByText(/^signed in at/i)).toBeTruthy(), { timeout: 500 });
  const list = within(screen.getByRole("list", { name: "Model accounts" }));
  const after = within(list.getByRole("heading", { name: "codex:orchard" }).closest("li")!);
  expect(after.getByText("Signed in", { selector: ".account-availability" })).toBeTruthy();
  expect(after.queryByText("Sign-in expired")).toBeNull();
  expect(after.queryByRole("button", { name: "Sign in again to codex:orchard" })).toBeNull();
  // the label and the lines come from one status, so no red auth line stays under "Signed in"
  expect(list.getByRole("listitem").textContent).not.toMatch(/log in|authentication failed|refresh failed/i);
});

// Only a succeeded sign-in to this same account hides zeta's auth error.
const otherSignIns: [string, unknown, { provider: "codex"; account: string }][] = [
  ["a failed sign-in", { state: "failed", error: { code: "login_failed" } }, { provider: "codex", account: "codex:orchard" }],
  ["a cancelled sign-in", { state: "cancelled" }, { provider: "codex", account: "codex:orchard" }],
  ["a sign-in to another account", { state: "succeeded" }, { provider: "codex", account: "codex:other" }],
];
for (const [name, started, target] of otherSignIns) test(`${name} does not hide the auth error`, async () => {
  const { login } = mount([orchardRow()], started);
  await row("orchard", "codex");
  await login.start(target);
  await waitFor(() => expect(login.snapshot() && "at" in login.snapshot()!).toBe(true), { timeout: 500 });
  const list = within(await screen.findByRole("list", { name: "Model accounts" }));
  await expectSignInExpired(within(list.getByRole("heading", { name: "codex:orchard" }).closest("li")!));
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
