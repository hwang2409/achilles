import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { AppShell } from "../AppShell";
import { modKey } from "../keyboard";
import { useAgentNavAdapter } from "./AgentNavAdapter";
import { chatsRoute } from "./routes";
// bun links CommonJS react-dom before this file's imports run, so it loads only after the DOM above exists.
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");

const originalFetch = globalThis.fetch;
beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = (async () => new Response(JSON.stringify({ chats: [], pages: [] }), { status: 200 })) as typeof fetch;
});
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; localStorage.clear(); });

function Shell() {
  const nav = useAgentNavAdapter({ sessionId: null, waiting: 0, canWrite: false, refreshKey: 0, pageRefreshKey: 0 });
  const activity = { rows: [], latestReceipt: null, building: 0, needsYou: 0, announcement: null, markAnnounced: () => {}, onScreen: () => {}, stale: false, refresh: () => {}, dismissReceipt: () => {} };
  return <AppShell activity={activity} current={chatsRoute} nav={nav} newChat={{ available: false, run: () => {} }} connectionStatus={{ label: "zeta connected", connected: true }}><p>main</p></AppShell>;
}

async function mount() {
  let ui!: ReturnType<typeof render>;
  await act(async () => { ui = render(<Shell />); await Promise.resolve(); });
  const shell = ui.container.querySelector<HTMLElement>(".app-shell")!;
  return { ui, shell, handle: ui.queryByRole("separator", { name: "resize sidebar" })!, width: () => shell.style.getPropertyValue("--sidebar-width") };
}

test("the sidebar handle resizes by keyboard, persists, clamps, and resets on double-click", async () => {
  const { handle, width } = await mount();
  expect(width()).toBe("280px");
  await act(async () => { fireEvent.keyDown(handle, { key: "ArrowRight" }); });
  expect(width()).toBe("296px");
  expect(handle.getAttribute("aria-valuenow")).toBe("296");
  expect(localStorage.getItem("achilles-sidebar-width")).toBe("296");
  await act(async () => { fireEvent.doubleClick(handle); });
  expect(width()).toBe("280px");
  expect(localStorage.getItem("achilles-sidebar-width")).toBe("280");
});

test("a stored width outside the limits is clamped on load", async () => {
  localStorage.setItem("achilles-sidebar-width", "9999");
  const { handle, width } = await mount();
  expect(width()).toBe("480px");
  await act(async () => { fireEvent.keyDown(handle, { key: "ArrowRight" }); });
  expect(width()).toBe("480px");
});

test("there is no collapse control, and the app modifier+B does not collapse the sidebar", async () => {
  const { ui, shell } = await mount();
  expect(ui.queryByRole("button", { name: /collapse sidebar|expand sidebar/ })).toBeNull();
  await act(async () => { fireEvent.keyDown(window, { key: "b", metaKey: true, ctrlKey: true }); });
  expect(shell.className).not.toContain("sidebar-collapsed");
});

test("search sits in the brand row with a Search placeholder and the palette hint", async () => {
  const { ui } = await mount();
  const brand = ui.container.querySelector(".brand-row")!;
  const search = ui.getByRole("combobox", { name: "search chats and pages" });
  expect(brand.contains(search)).toBe(true);
  expect(search.getAttribute("placeholder")).toBe("Search");
  expect(brand.querySelector(".palette-button")!.textContent).toBe(modKey("K"));
});
