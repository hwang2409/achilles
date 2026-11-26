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
  await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set("theme", "g1-light"); history.replaceState({}, "", url); });
  const places = page.getByRole("navigation", { name: "places" });
  const grouped = await places.locator("section").evaluateAll((sections) => sections.map((section) => [section.getAttribute("aria-label"), [...section.querySelectorAll("a")].map((link) => link.querySelector("span")?.textContent)]));
  const expected = [["work", ["chats", "pages", "agents", "sessions", "projects", "telemetry"]], ["library", ["skills", "agent profiles"]], ["manage", ["settings", "accounts", "connections"]]];
  if (JSON.stringify(grouped) !== JSON.stringify(expected)) throw new Error(`unexpected place order: ${JSON.stringify(grouped)}`);
  if (!(await places.getByRole("link", { name: "chats", exact: true }).getAttribute("aria-current"))) throw new Error("home did not select chats");
  if (await page.locator(".sidebar .page-list").count() || await page.locator(".sidebar").getByRole("button", { name: "settings", exact: true }).count()) throw new Error("sidebar duplicated a stable place");
  if (await places.locator("small:not(.waiting-count)").count()) throw new Error("a place shows a catalog count");
  await page.keyboard.press(appShortcut("k"));
  const palette = page.getByRole("dialog", { name: "command palette" });
  const catalogPlaces = await palette.getByRole("option").evaluateAll((options) => options.flatMap((option) => {
    const path = option.textContent?.match(/\/(?:chats|pages|agents|sessions|projects|telemetry|skills|agent-profiles|settings|accounts|connections|create)$/)?.[0];
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
  if (selectedUrl.searchParams.get("theme") !== "g1-light")
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
  if (new URL(page.url()).searchParams.get("theme") !== "g1-light")
    throw new Error("chat selection discarded the theme query");

  await page.goto(`${new URL(page.url()).origin}/?theme=g1-light&chat=foreign-session`);
  await gateWait.playwright(page.getByRole("alert").filter({ hasText: "this chat no longer exists" }), "waitFor", { timeout: 20_000 });
  await gateWait.playwright(page.getByRole("main").getByRole("button", { name: "new chat", exact: true }), "waitFor", { timeout: 20_000 });
  if (new URL(page.url()).searchParams.get("chat") !== "foreign-session")
    throw new Error("missing chat state discarded the selected chat query");
  await page.goto(`${new URL(page.url()).origin}/?theme=g1-light&chat=${firstSessionId}`);
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });

  await page.setViewportSize({ width: 1280, height: 900 });
  const sidebarWidth = () => page.locator("aside.sidebar").evaluate((element) => element.getBoundingClientRect().width);
  const resizer = page.getByRole("separator", { name: "resize sidebar" });
  const grip = (await resizer.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 300);
  await page.mouse.down();
  await page.mouse.move(360, grip.y + 300, { steps: 4 });
  await page.mouse.up();
  if (await sidebarWidth() !== 360 || await places.getByRole("link").count() !== 11) throw new Error(`dragging the sidebar edge to 360px gave ${await sidebarWidth()}px`);
  await capture("v5-wide-sidebar-chat-1280x900-light.png");
  await page.reload();
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });
  if (await sidebarWidth() !== 360) throw new Error("the dragged sidebar width did not survive a reload");
  await resizer.dblclick();
  if (await sidebarWidth() !== 280) throw new Error("double-clicking the sidebar edge did not reset it to 280px");
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
  if (await page.getByRole("separator", { name: "resize sidebar" }).count())
    throw new Error("the drawer must not expose the desktop resize handle at narrow widths");
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
    if (await page.locator(".menu-button").getAttribute("aria-expanded") !== "true") throw new Error("keyboard did not open the drawer at 200% zoom");
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
  // the chat's modes live in the composer at every width, never behind a menu
  const docked = await page.locator(".page-chat-head").count() > 0;
  if (docked) await page.locator(".page-chat-bar").click();
  for (const surface of ["composer.create-mode", "composer.auto-approve"]) {
    if (!(await page.locator(`[data-part="composer-modes"] [data-write-surface="${surface}"]`).isVisible())) throw new Error(`narrow composer did not show ${surface}`);
  }
  if (await page.locator(".chat-header [aria-pressed], .page-chat-head [role=menuitemcheckbox]").count()) throw new Error("a chat header still has a mode control");
  await capture("09-narrow-chat-modes-390x844.png");
  if (docked) await page.getByRole("button", { name: "close page chat" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  return secondSessionId;
}

// Use a separate read-only tab so captures do not attach a second chat or disturb the controller journey.
export async function gateStablePlace(tab: Page, origin: string, gateWait: GateWait) {
  let sockets = 0;
  tab.on("websocket", () => { sockets += 1; });
  await tab.goto(`${origin}/agents?theme=g1-dark`);
  const frame = tab.locator(".module-frame");
  await gateWait.playwright(frame.getByRole("heading", { name: "Agents", exact: true, level: 1 }), "waitFor");
  await gateWait.playwright(tab.locator('.surface-connection[data-connected="true"]'), "waitFor");
  if (sockets !== 1) throw new Error(`agents opened ${sockets} zeta connections`);
  if (await frame.getByRole("heading", { name: "not available in this build" }).count() || await tab.getByText("page not found", { exact: true }).count()) throw new Error("agents rendered a placeholder or page-not-found state");
  if (await tab.locator('.place-nav [aria-current="page"]').innerText() !== "Agents") throw new Error("agents route did not select agents");
  if (!process.env.SCREENSHOT_DIR) return;
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await tab.goto(`${origin}/agents?theme=g1-light`);
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

export async function gateCreatePlace(tab: Page, origin: string, gateWait: GateWait) {
  type Rpc = { method?: string; params?: { session_id?: string; delivery_id?: string; text?: string } };
  const requests: Rpc[] = [];
  tab.on("websocket", (socket) => socket.on("framesent", ({ payload }) => requests.push(JSON.parse(String(payload)) as Rpc)));
  const capture = async (state: string, width: number, height = width === 390 ? 844 : 900) => {
    if (process.env.SCREENSHOT_DIR) await tab.screenshot({ path: `${process.env.SCREENSHOT_DIR}/v5-create-${state}-${width}x${height}.png`, animations: "disabled" });
  };
  const theme = "?theme=g1-dark";
  const landingUrl = `${origin}/create${theme}`;
  const readHome = async () => {
    const response = await tab.request.get(`${origin}/api/pages/home`);
    if (!response.ok()) throw new Error(`home lookup failed: ${response.status()}`);
    return await response.json() as { id: string; create_mode: boolean; approval_mode?: string };
  };
  await tab.setViewportSize({ width: 1440, height: 900 });
  await tab.goto(landingUrl);
  const connected = tab.locator('.surface-connection[data-connected="true"]');
  await gateWait.playwright(connected, "waitFor", { state: "attached" });
  if (await tab.locator('.create-split a[aria-current="page"]').getAttribute("href") !== `/create${theme}` || await tab.locator(".create-split button").count()) throw new Error("create is not selected as a place without a switch");
  await gateWait.playwright(tab.locator('.chat-list[data-list-state="ready"]'), "waitFor", { state: "attached" });
  const newChat = tab.locator(".surface-actions").getByRole("button", { name: "new chat", exact: true });
  const assertNewChat = async () => {
    // A navigation from the controller can reconnect as observer before its old socket closes.
    const enabled = newChat.and(tab.locator(":enabled:not([aria-disabled=true])"));
    const takeover = tab.getByRole("button", { name: "take control", exact: true });
    await gateWait.playwright(enabled.or(takeover).first(), "waitFor");
    if (await takeover.isVisible()) await takeover.click();
    await gateWait.playwright(enabled, "waitFor");
    if (!await newChat.evaluate((button) => button.nextElementSibling?.querySelector('a[href^="/create"]') != null)) throw new Error("enabled new chat must be directly before the create link");
  };
  await assertNewChat();
  const home = await readHome();
  const registrations: Array<{ pageId: string; sessionId: string }> = [];
  tab.on("request", (request) => {
    const path = new URL(request.url()).pathname.match(/^\/api\/pages\/([^/]+)\/chats$/);
    if (path && request.method() === "POST") registrations.push({ pageId: path[1], sessionId: request.postDataJSON().session_id });
  });
  await tab.setViewportSize({ width: 1440, height: 900 });
  await tab.goto(`${origin}/settings${theme}`);
  await assertNewChat();
  await capture("new-chat-settings", 1440);
  for (const place of ["create", "pages"]) {
    await tab.goto(`${origin}/${place}${theme}`);
    await assertNewChat();
    if (place === "pages") await capture("new-chat-pages", 1440);
    const requestCount = requests.filter(({ method }) => method === "new_session").length;
    const registrationCount = registrations.length;
    if (place === "create") await newChat.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    else await newChat.click();
    await gateWait.playwright(tab, "waitForURL", (url) => url.pathname === "/" && Boolean(url.searchParams.get("chat")) && !url.hash, { waitUntil: "commit" });
    const latest = new URL(tab.url()).searchParams.get("chat");
    if (registrations.length !== registrationCount + 1 || registrations.at(-1)?.sessionId !== latest || registrations.at(-1)?.pageId !== home.id || requests.filter(({ method }) => method === "new_session").length !== requestCount + 1) throw new Error(`new chat from /${place} did not register one home chat`);
  }
  await tab.goto(landingUrl);
  await assertNewChat();
  const sessionBaseline = requests.filter(({ method }) => method === "new_session").length;
  registrations.length = 0;

  const facts = tab.getByTestId("build-facts");
  const savedApproval = await tab.evaluate(() => JSON.parse(localStorage.getItem("achilles-settings") ?? "{}").autoApproveDefault);
  const expectedApproval = (await readHome()).approval_mode === "ask" || savedApproval === false ? "ask before running tools" : "auto-approve tools";
  const expectedFacts = `create on · runs in a new chat · ${expectedApproval}`;
  await gateWait.playwright(facts.filter({ hasText: expectedFacts }), "waitFor");
  const build = tab.locator(".create-form-actions button[type=submit]");
  const actionWidths = () => tab.locator(".new-chat, .create-form-actions button[type=submit]").evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().width));
  const prompt = tab.getByRole("textbox", { name: "describe your page" });
  await tab.setViewportSize({ width: 390, height: 844 });
  await tab.getByRole("button", { name: "a reading list with statuses" }).click();
  if (await prompt.inputValue() !== "a reading list with statuses" || !await prompt.evaluate((element) => element === document.activeElement) || requests.some(({ method }) => method === "send") || requests.filter(({ method }) => method === "new_session").length !== sessionBaseline) throw new Error("starter did more than fill and focus the prompt");
  const measure: number[] = [];
  const readyWidths = new Map<number, number[]>();
  for (const width of [390, 1280, 1440, 1920]) {
    const height = width === 390 ? 844 : 900;
    await tab.setViewportSize({ width, height });
    await tab.evaluate(() => document.fonts.ready.then(() => undefined));
    if (await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`create page overflow at ${width}px`);
    readyWidths.set(width, await actionWidths());
    measure.push((await tab.locator(".create-landing").boundingBox())!.width);
    await capture("landing", width);
    if (width === 390) {
      await tab.getByRole("button", { name: "open menu" }).press("Enter");
      await capture("drawer", width);
      await tab.keyboard.press("Escape");
      await tab.setViewportSize({ width, height: 430 });
      await prompt.focus();
      await build.scrollIntoViewIfNeeded();
      if (!(await build.evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight))) throw new Error("build button is unreachable in a short mobile viewport");
    }
  }
  if (measure[2] !== measure[3]) throw new Error(`create content stretched: ${measure.join(", ")}`);
  await tab.setViewportSize({ width: 1440, height: 900 });
  const draft = "  a synthetic reading list\nwith tags  ";
  await prompt.fill(draft);
  const modePath = `${origin}/api/pages/${home.id}/create-mode`;
  if (home.create_mode) {
    const disabled = await tab.request.post(modePath, { data: { enabled: false } });
    if (!disabled.ok()) throw new Error("could not set up create-off home fixture");
  }
  const mode: unknown[] = [];
  await tab.route(modePath, async (route) => {
    mode.push(route.request().postDataJSON());
    if (mode.length === 1) {
      if (await facts.innerText() !== expectedFacts) throw new Error("pending build omitted or changed its execution facts");
      if (!await build.isDisabled() || !await newChat.isDisabled() || await build.innerText() !== "starting…" || await newChat.locator("b").innerText() !== "Starting…") throw new Error("pending build did not show both actions are busy");
      await capture("pending", 1440);
      for (const width of [1440, 390]) {
        await tab.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const pendingWidths = await actionWidths();
        if (pendingWidths.some((size, index) => Math.abs(size - readyWidths.get(width)![index]) > 1)) throw new Error(`busy action changed width at ${width}px`);
        if (width === 390) await capture("pending", width);
      }
      await tab.setViewportSize({ width: 1440, height: 900 });
      await route.fulfill({ status: 503, json: { error: "synthetic refusal" } });
    } else await route.continue();
  });
  await build.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await gateWait.playwright(tab.getByRole("alert").filter({ hasText: "could not update create mode (503)" }), "waitFor");
  if (tab.url() !== landingUrl || await prompt.inputValue() !== draft || registrations.length !== 1 || requests.filter(({ method }) => method === "new_session").length !== sessionBaseline + 1 || requests.some(({ method }) => method === "send") || mode.length !== 1) throw new Error("refused build changed route/draft or duplicated a write");
  await gateWait.playwright(tab, "waitForFunction", () => document.activeElement?.getAttribute("aria-label") === "describe your page");
  await capture("refused", 1440);
  await tab.getByRole("button", { name: "retry build" }).click();
  const sessionId = registrations[0].sessionId;
  const target = `${origin}/${theme}&chat=${encodeURIComponent(sessionId)}`;
  await gateWait.playwright(tab, "waitForURL", target);
  await gateWait.playwright(tab.locator(`[data-session-id="${sessionId}"]`).first(), "waitFor", { state: "visible" });
  const sends = requests.filter(({ method }) => method === "send" || method === "steer");
  if (registrations.length !== 1 || registrations[0].pageId !== home.id || requests.filter(({ method }) => method === "new_session").length !== sessionBaseline + 1 || JSON.stringify(mode) !== '[{"enabled":true},{"enabled":true}]' || !(await readHome()).create_mode || sends.length !== 1 || sends[0].params?.session_id !== sessionId || sends[0].params?.text !== draft || !/^[0-9a-f-]{36}$/.test(sends[0].params?.delivery_id ?? "")) throw new Error("build did not deliver exactly once to its registered home chat in create mode");
  const toggle = tab.locator('[data-write-surface="composer.create-mode"]');
  if (await toggle.getAttribute("aria-checked") !== "true") throw new Error("composer switch did not reflect build mode");
  await capture("chat-on", 1440);
  await tab.setViewportSize({ width: 390, height: 844 });
  await capture("chat-on", 390);
  await tab.setViewportSize({ width: 1280, height: 900 });
  await gateWait.playwright(tab.locator(".run-state.state-running"), "waitFor", { state: "hidden" });
  await toggle.click();
  await gateWait.playwright(tab.locator('[data-write-surface="composer.create-mode"][aria-checked="false"]'), "waitFor");
  await capture("chat-off", 1280);

}

export async function gateAccountsPlace(tab: Page, origin: string) {
  const roles: unknown[] = [];
  const reads: { role: unknown; params: unknown }[] = [];
  const sockets: import("playwright").WebSocket[] = [];
  tab.on("websocket", (socket) => {
    sockets.push(socket);
    let role: unknown;
    socket.on("framesent", ({ payload }) => {
      const { method, params } = JSON.parse(String(payload));
      if (method === "hello") { role = params.role; roles.push(role); }
      if (method === "account_list") reads.push({ role, params });
    });
  });
  await tab.goto(`${origin}/accounts`);
  await tab.getByRole("heading", { name: "no model accounts yet", exact: true }).waitFor({ timeout: 10_000 });
  await tab.getByText("no chat is active.", { exact: true }).waitFor({ timeout: 10_000 });
  if (await tab.getByRole("button", { name: "switch chat", exact: true }).isEnabled()) throw new Error("the idle catalog enabled a chat switch with no active chat");
  const controller = sockets[1];
  if (!controller || roles.join() !== "observer,controller,observer" || JSON.stringify(reads) !== '[{"role":"controller","params":{}}]')
    throw new Error("accounts did not borrow control for exactly one sessionless read");
  if (!controller.isClosed()) await controller.waitForEvent("close", { timeout: 10_000 });
}
