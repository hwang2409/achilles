import type { Page } from "playwright";
import { appShortcut, type GateWait } from "./gate-diagnostics";

export async function gateShell(
  page: Page,
  firstSessionId: string,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>,
  gateWait: GateWait,
) {
  const capture = async (name: string) => { if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}`, fullPage: true }); };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set("theme", "gruvbox-light"); history.replaceState({}, "", url); });
  const places = page.getByRole("navigation", { name: "places" });
  const grouped = await places.locator("section").evaluateAll((sections) => sections.map((section) => [section.getAttribute("aria-label"), [...section.querySelectorAll("a")].map((link) => link.textContent)]));
  const expected = [["work", ["chats", "pages", "agents", "sessions", "projects", "telemetry"]], ["library", ["skills", "agent profiles"]], ["manage", ["settings", "accounts", "mcp connections"]]];
  if (JSON.stringify(grouped) !== JSON.stringify(expected)) throw new Error(`unexpected place order: ${JSON.stringify(grouped)}`);
  if (await places.locator('[aria-current="page"]').innerText() !== "chats") throw new Error("home did not select chats");
  await page.keyboard.press(appShortcut("k"));
  const palette = page.getByRole("dialog", { name: "command palette" });
  const catalogPlaces = await palette.getByRole("option").evaluateAll((options) => options.flatMap((option) => {
    const path = option.textContent?.match(/\/(?:chats|pages|agents|sessions|projects|telemetry|skills|agent-profiles|settings|accounts|mcp|create)$/)?.[0];
    return path ? [path] : [];
  }));
  if (catalogPlaces.length !== 12 || new Set(catalogPlaces).size !== 12) throw new Error("palette does not list all stable places exactly once");
  await page.keyboard.press("Escape");
  const chatsBefore = await page.locator(".chat-row").count();
  await page.locator("button.new-chat").click();
  await waitFor(async () => {
    const current = await page.locator("[data-session-id]").getAttribute("data-session-id");
    return Boolean(current && current !== firstSessionId);
  }, "second home chat");
  await waitFor(async () => await page.getByRole("textbox", { name: "message", exact: true }).evaluate((field) => field === document.activeElement), "pointer new chat composer focus");
  const secondSessionId = await page.locator("[data-session-id]").getAttribute("data-session-id");
  const selectedUrl = new URL(page.url());
  if (!secondSessionId || selectedUrl.searchParams.get("chat") !== secondSessionId)
    throw new Error("new chat did not become the selected URL chat");
  if (selectedUrl.searchParams.get("theme") !== "gruvbox-light")
    throw new Error("new chat navigation discarded the theme query");
  await waitFor(async () => await page.locator(".chat-row").count() === chatsBefore + 1, "second home chat in sidebar");
  await capture("02-new-chat-review-1440x900.png");
  if ((await page.locator(".chat-row.current").getAttribute("href"))?.includes(secondSessionId) !== true)
    throw new Error("new chat was not current in the sidebar");

  await page.reload();
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });
  if (new URL(page.url()).searchParams.get("chat") !== secondSessionId)
    throw new Error("reload did not keep the selected chat query");
  await page.keyboard.press(appShortcut("Shift+O"));
  await waitFor(async () => {
    const field = page.getByRole("textbox", { name: "message", exact: true });
    return await field.count() === 1 && await field.evaluate((element) => element === document.activeElement);
  }, "shortcut new chat composer focus");

  const search = page.getByRole("combobox", { name: "search chats and pages" });
  await gateWait.playwright(search, "waitFor", { timeout: 20_000 });
  await search.fill("prove chat");
  await waitFor(async () => await page.locator(".chat-row").count() === 1, "chat title search");
  if (!(await page.locator(".chat-row").innerText()).includes("prove chat"))
    throw new Error("search did not filter by chat title");
  await search.press("ArrowDown");
  if (!(await page.locator(".chat-row").first().evaluate((row) => row.classList.contains("active-result"))))
    throw new Error("search arrow key did not activate a result");
  await search.press("Enter");
  await gateWait.playwright(page.getByText("assistant ready", { exact: true }), "waitFor", { timeout: 20_000 });
  if (await page.locator("[data-session-id]").getAttribute("data-session-id") !== firstSessionId)
    throw new Error("search enter did not open the active result");
  await search.press("Escape");
  if (await search.inputValue()) throw new Error("escape did not clear chat search");
  if (new URL(page.url()).searchParams.get("theme") !== "gruvbox-light")
    throw new Error("chat selection discarded the theme query");

  await page.goto(`${new URL(page.url()).origin}/?theme=gruvbox-light&chat=foreign-session`);
  await gateWait.playwright(page.getByRole("alert").filter({ hasText: "this chat no longer exists" }), "waitFor", { timeout: 20_000 });
  await gateWait.playwright(page.getByRole("button", { name: "new chat", exact: true }), "waitFor", { timeout: 20_000 });
  if (new URL(page.url()).searchParams.get("chat") !== "foreign-session")
    throw new Error("missing chat state discarded the selected chat query");
  await page.goto(`${new URL(page.url()).origin}/?theme=gruvbox-light&chat=${firstSessionId}`);
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "collapse sidebar" }).press("Enter");
  const railWidth = await page.locator("aside.sidebar").evaluate((element) => element.getBoundingClientRect().width);
  if (railWidth !== 56 || await places.getByRole("link").count() !== 11) throw new Error("the 56px rail dropped place links");
  await capture("v5-railed-chat-1280x900-light.png");
  await page.getByRole("button", { name: "expand sidebar" }).press("Enter");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("v5-chat-390x844-light.png");
  const sidebar = page.locator("aside.sidebar");
  await waitFor(async () => (await sidebar.getAttribute("aria-hidden")) === "true", "closed drawer accessibility state");
  const menu = page.getByRole("button", { name: "open menu" });
  const drawerFirstFrameTab = await menu.evaluate((button: HTMLButtonElement) => new Promise<{ dispatched: boolean; prevented: boolean; inside: boolean }>((resolve) => {
    const originalAdd = window.addEventListener;
    const result = { dispatched: false, prevented: false, inside: false };
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      originalAdd.call(window, type, listener, options);
      const drawer = document.querySelector('.drawer-open aside.sidebar:not([inert])');
      if (!result.dispatched && type === "keydown" && options === true && drawer) {
        result.dispatched = true;
        const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
        window.dispatchEvent(event);
        result.prevented = event.defaultPrevented;
        result.inside = drawer.contains(document.activeElement);
      }
    }) as typeof window.addEventListener;
    requestAnimationFrame(() => {
      window.addEventListener = originalAdd;
      resolve(result);
    });
    // Arm and click in the same task; a Playwright click can wait for a frame.
    button.click();
  }));
  if (!drawerFirstFrameTab.dispatched) throw new Error("390px drawer: trap registered after the first frame or the probe never dispatched Shift+Tab");
  if (!drawerFirstFrameTab.prevented || !drawerFirstFrameTab.inside) throw new Error(`390px drawer first-frame Shift+Tab was not trapped inside the drawer: ${JSON.stringify(drawerFirstFrameTab)}`);
  await sidebar.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const main = page.locator("main.main-pane");
  if (!(await main.evaluate((element) => element.inert)) || await main.getAttribute("aria-hidden") !== "true")
    throw new Error("open drawer left the main pane interactive");
  if (!(await sidebar.evaluate((element) => element.contains(document.activeElement))))
    throw new Error("opening the drawer did not move focus into it");
  if (await sidebar.getByRole("button", { name: /collapse sidebar|expand sidebar/ }).count())
    throw new Error("the drawer must not expose the desktop collapse control at narrow widths");
  await page.keyboard.press("Tab");
  if (!(await sidebar.evaluate((element) => element.contains(document.activeElement))))
    throw new Error("drawer tab escaped into the obscured main pane");
  for (const link of await places.getByRole("link").all()) {
    const box = await link.boundingBox();
    if (!box || box.height < 44 || box.width < 44) throw new Error("drawer link is smaller than 44px");
  }
  await capture("10-narrow-drawer-review-390x844.png");
  await page.keyboard.press("Escape");
  if ((await sidebar.getAttribute("aria-hidden")) !== "true") throw new Error("escape did not close the drawer");
  await sidebar.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  if (!(await menu.evaluate((button) => button === document.activeElement))) throw new Error("closing the drawer did not restore menu focus");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  try {
    await page.keyboard.press("Enter");
    if (await menu.getAttribute("aria-expanded") !== "true") throw new Error("keyboard did not open the drawer at 200% zoom");
    if (await sidebar.evaluate((element) => element.getAnimations().length)) throw new Error("drawer animated with reduced motion enabled");
    if (await sidebar.evaluate((element) => element.scrollWidth > element.clientWidth)) throw new Error("drawer overflowed horizontally at 200% zoom");
    await page.keyboard.press("Tab");
    if (!await sidebar.evaluate((element) => element.contains(document.activeElement))) throw new Error("focus escaped the zoomed drawer");
    await capture("v5-drawer-390x844-200percent-reduced-motion.png");
    await page.keyboard.press("Escape");
    if (!await menu.evaluate((button) => button === document.activeElement)) throw new Error("zoomed drawer did not return focus");
  } finally {
    await page.evaluate(() => { document.documentElement.style.zoom = ""; });
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  if (await page.locator(".page-chat-head").count()) {
    await page.locator(".page-chat-bar").click();
    const overflow = page.getByRole("button", { name: "page chat options" });
    await overflow.click();
    const modeMenu = page.getByRole("menu", { name: "page chat options" });
    if (await modeMenu.getByRole("menuitemcheckbox").count() !== 2) throw new Error("docked chat menu must expose exactly the two mode changes");
    await capture("09-narrow-chat-menu-review-390x844.png");
    await page.keyboard.press("Escape");
    if (await modeMenu.count()) throw new Error("escape did not close the docked chat menu");
    await page.keyboard.press("Escape");
  } else {
    const overflow = page.getByRole("button", { name: "chat options" });
    await overflow.click();
    if (!(await page.locator(".header-menu").getByRole("button", { name: /create mode/ }).isVisible())) throw new Error("narrow chat menu did not expose create mode");
    if (!(await page.locator(".header-menu .approval-mode").isVisible())) throw new Error("narrow chat menu did not expose approval mode");
    if (!(await page.locator(".header-menu").getByRole("button", { name: "history" }).isVisible())) throw new Error("narrow chat menu did not expose history");
    await capture("09-narrow-chat-menu-review-390x844.png");
    await page.keyboard.press("Escape");
    if (await page.locator(".header-menu").count()) throw new Error("escape did not close the narrow chat menu");
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  return secondSessionId;
}

// Use a separate read-only tab so captures do not attach a second chat or disturb the controller journey.
export async function gateStablePlace(tab: Page, origin: string, gateWait: GateWait) {
  let sockets = 0;
  tab.on("websocket", () => { sockets += 1; });
  await tab.goto(`${origin}/agents?theme=gruvbox-dark`);
  const frame = tab.locator(".module-frame");
  await gateWait.playwright(frame.getByRole("heading", { name: "not available in this build" }), "waitFor");
  await gateWait.playwright(tab.locator('.surface-connection[data-connected="true"]'), "waitFor");
  if (sockets !== 1) throw new Error(`reserved route opened ${sockets} zeta connections`);
  if (await frame.getByRole("button").count() || await frame.getByRole("link").count()) throw new Error("reserved route renders placeholder controls");
  if (await tab.locator('.place-nav [aria-current="page"]').innerText() !== "agents") throw new Error("reserved route did not select agents");
  if (!process.env.SCREENSHOT_DIR) return;
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await tab.goto(`${origin}/agents?theme=gruvbox-light`);
    await gateWait.playwright(tab.locator('.surface-connection[data-connected="true"]'), "waitFor");
    await gateWait.playwright(tab.locator('.chat-list[data-list-state="ready"]'), "waitFor");
    for (const width of [390, 1280, 1440, 1920]) {
      const height = width === 390 ? 844 : 900;
      await tab.setViewportSize({ width, height });
      await tab.evaluate(() => document.fonts.ready.then(() => undefined));
      if (await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`stable place overflow at ${width}px`);
      const capture = (suffix = "") => tab.screenshot({ path: `${process.env.SCREENSHOT_DIR}/v5-agents-${width}x${height}-${theme}${suffix}.png`, animations: "disabled" });
      await capture();
      if (width === 390) {
        await tab.getByRole("button", { name: "open menu" }).press("Enter");
        await capture("-drawer");
        await tab.keyboard.press("Escape");
      }
    }
  }
}
