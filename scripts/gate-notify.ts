import type { Browser, BrowserContext, Page } from "../apps/web/node_modules/playwright";

type Shown = { title: string; tag?: string };
declare global { interface Window { __notes: Shown[]; __asks: number; __visibility: DocumentVisibilityState; __clickNote(index: number): void } }

// The browser side of each tab: a Notification that records what it shows (the permission starts unanswered and the first
// ask grants it), and a visibility the gate sets, because every headless page reports "visible".
function fakeBrowser() {
  const notes: Shown[] = [];
  const objects: { onclick: ((event: Event) => void) | null }[] = [];
  let permission: NotificationPermission = localStorage.getItem("gate:permission") as NotificationPermission | null ?? "default";
  class GateNotification extends EventTarget {
    onclick: ((event: Event) => void) | null = null;
    static get permission() { return permission; }
    static async requestPermission() { window.__asks++; permission = "granted"; localStorage.setItem("gate:permission", permission); return permission; }
    constructor(title: string, options?: NotificationOptions) { super(); notes.push({ title, tag: options?.tag }); objects.push(this); }
    close() {}
  }
  Object.assign(window, { Notification: GateNotification, __notes: notes, __asks: 0, __visibility: sessionStorage.getItem("gate:visibility") ?? "visible",
    __clickNote: (index: number) => objects[index]!.onclick?.(new Event("click")) });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__visibility });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__visibility === "hidden" });
}

const setVisibility = (page: Page, state: DocumentVisibilityState) => page.evaluate((state) => {
  window.__visibility = state;
  sessionStorage.setItem("gate:visibility", state);
  document.dispatchEvent(new Event("visibilitychange"));
}, state);
const notes = (page: Page) => page.evaluate(() => window.__notes.map((note) => note.title)).catch(() => [] as string[]);

/**
 * Browser notifications (A2) on the Pages place, which lists chats without a zeta turn: two chats change state as another
 * tab's writes do (PATCH plus the achilles:chats broadcast). Proves: off by default, one permission ask, a hidden tab shows
 * "<title> needs you" once, a click opens the chat with the approval intent, a visible tab shows nothing, list reloads and a
 * page reload repeat nothing, only the leader of two tabs notifies, and a closed leader hands over. Returns the chat ids.
 */
export async function gateNotifications(browser: Browser, origin: string, waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>) {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(fakeBrowser);
  const ids = [`gate-notify-${crypto.randomUUID()}`, `gate-notify-${crypto.randomUUID()}`];
  try {
    const [a, b, writer] = [await context.newPage(), await context.newPage(), await context.newPage()];
    for (const page of [a, b, writer]) page.setDefaultTimeout(20_000);
    // the writer is a same-origin document that is not the app, so it never notifies
    await writer.goto(`${origin}/api/chats?limit=1`);
    const write = (id: string, body: object) => writer.evaluate(async ({ id, body }) => {
      const response = await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`PATCH ${id} answered ${response.status}`);
      const channel = new BroadcastChannel("achilles:chats");
      channel.postMessage(id);
      channel.close();
    }, { id, body });
    for (const [index, id] of ids.entries()) {
      const created = await writer.evaluate(async (id) => (await fetch("/api/pages/home/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: id, purpose: "chat" }) })).status, id);
      if (created !== 200) throw new Error(`could not register ${id}: ${created}`);
      await write(id, { message: true, first_message: `notify fixture ${index + 1}`, last_state: "running" });
    }
    const listed = (page: Page, id: string, meta: string | null) => async () => {
      const row = page.locator(`a[data-chat-id="${id}"]`);
      if (await row.count() !== 1) return false;
      const text = await row.locator(".chat-row-meta").textContent({ timeout: 500 }).catch(() => null);
      return meta === null || (text ?? "").includes(meta);
    };
    await a.goto(`${origin}/pages`);
    await waitFor(listed(a, ids[0]!, null), "tab a lists the notify fixtures");

    // off by default: a hidden tab shows nothing
    await setVisibility(a, "hidden");
    await write(ids[0]!, { last_state: "approval" });
    await waitFor(listed(a, ids[0]!, "needs you"), "tab a sees the first approval");
    if ((await notes(a)).length) throw new Error(`notifications are on by default: ${await notes(a)}`);
    await write(ids[0]!, { last_state: "running" });
    await setVisibility(a, "visible");

    // turning it on asks the browser once; off and on again does not ask again (display settings open from the settings place)
    const toggle = a.getByRole("switch", { name: "notifications" });
    await a.goto(`${origin}/settings`);
    await a.getByRole("button", { name: "Display settings" }).click();
    if (await toggle.getAttribute("aria-checked") !== "false") throw new Error("the notifications switch is not off by default");
    await toggle.click();
    await waitFor(async () => await toggle.getAttribute("aria-checked") === "true", "notifications switch turns on");
    await toggle.click();
    await waitFor(async () => await toggle.getAttribute("aria-checked") === "false", "notifications switch turns off");
    await toggle.click();
    await waitFor(async () => await toggle.getAttribute("aria-checked") === "true", "notifications switch turns on again");
    if (await a.evaluate(() => window.__asks) !== 1) throw new Error(`the browser was asked ${await a.evaluate(() => window.__asks)} times, not once`);
    await a.keyboard.press("Escape");
    await a.goto(`${origin}/pages`);
    await waitFor(listed(a, ids[0]!, "running"), "tab a lists the notify fixtures again");

    // b opens last, so it leads; with both hidden, one approval shows one notification, in b
    await b.goto(`${origin}/pages`);
    await waitFor(listed(b, ids[0]!, null), "tab b lists the notify fixtures");
    for (const page of [a, b]) await setVisibility(page, "hidden");
    await write(ids[0]!, { last_state: "approval" });
    await waitFor(async () => (await notes(b)).length > 0, "the leader tab shows a notification");
    // the other tab saw the same write: give its list time to load before counting
    await waitFor(listed(a, ids[0]!, "needs you"), "tab a sees the approval");
    await waitFor(listed(b, ids[0]!, "needs you"), "tab b sees the approval");
    const shown = [await notes(a), await notes(b)];
    if (JSON.stringify(shown) !== JSON.stringify([[], ["notify fixture 1 needs you"]])) throw new Error(`expected one notification in the leader tab: ${JSON.stringify(shown)}`);

    // reloads of the list (another write's broadcast, focus) and a page reload of b repeat nothing
    await write(ids[1]!, { title: "notify fixture 2" });
    for (const page of [a, b]) await page.evaluate(() => dispatchEvent(new Event("focus")));
    await b.reload();
    await waitFor(listed(b, ids[0]!, "needs you"), "tab b lists the approval after a reload");
    await write(ids[1]!, { title: null });
    await a.waitForTimeout(1_000);
    if ((await notes(a)).length || (await notes(b)).length) throw new Error(`a reload repeated a notification: ${JSON.stringify([await notes(a), await notes(b)])}`);

    // a visible leader shows nothing: b reloaded hidden; now b is shown, so it leads, and a stays hidden
    await setVisibility(b, "visible");
    await write(ids[1]!, { last_state: "approval" });
    await waitFor(listed(a, ids[1]!, "needs you"), "tab a sees the second approval");
    await waitFor(listed(b, ids[1]!, "needs you"), "tab b sees the second approval");
    await a.waitForTimeout(500);
    if ((await notes(a)).length || (await notes(b)).length) throw new Error(`a notification showed while an achilles tab was visible: ${JSON.stringify([await notes(a), await notes(b)])}`);

    // the leader closes: a leads; a finished run (approval, running, idle) says "finished" once
    await b.close();
    await write(ids[1]!, { last_state: "running" });
    await waitFor(listed(a, ids[1]!, "running"), "tab a sees the second chat run");
    await write(ids[1]!, { last_state: "idle" });
    await waitFor(async () => (await notes(a)).length > 0, "the new leader shows a notification");
    await a.waitForTimeout(500);
    if (JSON.stringify(await notes(a)) !== JSON.stringify(["notify fixture 2 finished"])) throw new Error(`expected one finished notification in tab a: ${JSON.stringify(await notes(a))}`);

    // a new approval of the first chat, then a click: the tab opens that chat with the approval intent
    await write(ids[0]!, { last_state: "running" });
    await waitFor(listed(a, ids[0]!, "running"), "tab a sees the first chat run again");
    await write(ids[0]!, { last_state: "approval" });
    await waitFor(async () => (await notes(a)).length === 2, "a second approval shows a second notification");
    // the opened chat is not loaded: it is a fixture row with no zeta session behind it
    await a.route((url) => url.searchParams.get("chat") === ids[0], (route) => route.fulfill({ contentType: "text/html", body: "<title>opened</title>" }));
    const opened = a.waitForURL((url) => url.pathname === "/" && url.searchParams.get("chat") === ids[0] && url.hash === "#approval", { waitUntil: "commit" });
    await a.evaluate(() => window.__clickNote(1));
    await opened;
    console.log("notifications: off by default, one permission ask, one notification in the hidden leader, none while visible, none repeated on reload, handover on close, click opens the chat at its approval");
    return ids;
  } finally {
    await context.close();
  }
}
