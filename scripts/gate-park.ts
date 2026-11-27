import { join } from "node:path";
import type { Browser, Page } from "../apps/web/node_modules/playwright";
import type { Discovery } from "./gate-agent-controls";

export const parkArtifacts = ["park-limit-1440.png", "park-limit-390.png"];
type Frame = { dir: "sent" | "received"; socket: number; id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };

// session_park against a zeta whose turns stay busy until `release` exists: one tab keeps 3 chats running and is refused a
// 4th (parked_limit) with the chats named; stay keeps the shown chat; stop-oldest-and-switch sends resume, abort, then the
// swap; a reload takes the parked chats back; another tab reads a parked chat live while its turn finishes.
export async function gateParkedChats(browser: Browser, origin: string, discovery: Discovery, release: string,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>, screenshots?: string) {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const reader = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  tab.setDefaultTimeout(20_000);
  reader.setDefaultTimeout(20_000);
  const frames: Frame[] = [];
  let sockets = 0;
  tab.on("websocket", (socket) => {
    const id = ++sockets;
    const record = (dir: Frame["dir"]) => ({ payload }: { payload: string | Buffer }) => {
      try { frames.push({ dir, socket: id, ...JSON.parse(String(payload)) }); } catch { /* not json */ }
    };
    socket.on("framesent", record("sent"));
    socket.on("framereceived", record("received"));
  });
  for (const page of [tab, reader]) await page.route("**/api/zeta/discovery", (route) => route.fulfill({ json: discovery }));
  const composer = tab.getByRole("textbox", { name: "message" });
  const newChat = tab.getByRole("button", { name: "new chat" }).first();
  const shown = () => tab.locator(".chat-header [data-session-id]").getAttribute("data-session-id").catch(() => null);
  const urlChat = () => new URL(tab.url()).searchParams.get("chat");
  const rowMeta = (id: string) => tab.locator(`a[data-chat-id="${id}"] .chat-row-meta`).textContent({ timeout: 1_000 }).catch(() => null);
  // the chat's row is listed and shows no state
  const rowIdle = async (id: string) => await tab.locator(`a[data-chat-id="${id}"]`).count() === 1 && await tab.locator(`a[data-chat-id="${id}"] .chat-row-meta`).count() === 0;
  const sentSince = (since: number) => frames.slice(since).filter((frame) => frame.dir === "sent");
  const lastParked = (since: number) => frames.slice(since).filter((frame) => Array.isArray(frame.result?.parked_sessions)).at(-1)?.result!.parked_sessions as { session_id: string }[] | undefined;
  const notice = tab.getByRole("alert").filter({ hasText: "this tab already keeps 3 chats running" });
  try {
    // four chats, each with a busy turn: switching away from each of the first three parks it
    const ids: string[] = [];
    await tab.goto(`${origin}/#new-chat`);
    for (let n = 1; n <= 4; n++) {
      if (n > 1) {
        await newChat.click();
        await tab.locator(".empty-chat").waitFor();
      }
      await composer.fill(`park hold ${n}`);
      await composer.press("Enter");
      await waitFor(async () => { const id = await shown(); return Boolean(id) && !ids.includes(id!); }, `park chat ${n} opened`);
      ids.push((await shown())!);
      await tab.getByRole("button", { name: "stop the running turn" }).waitFor();
    }
    for (const id of ids.slice(0, 3)) await waitFor(async () => await rowMeta(id) === "running in this tab", `parked row ${id} says running in this tab`);
    // a 4th park is refused: the notice names the 3 chats; stay keeps the shown chat
    await newChat.click();
    await notice.waitFor({ timeout: 30_000 });
    const text = await notice.innerText();
    if (![1, 2, 3].every((n) => text.includes(`"park hold ${n}"`)) || text.includes("park hold 4")) throw new Error(`parked_limit notice does not name the 3 parked chats: ${text}`);
    if (screenshots) await tab.screenshot({ path: join(screenshots, "park-limit-1440.png") });
    await tab.setViewportSize({ width: 390, height: 844 });
    if (screenshots) await tab.screenshot({ path: join(screenshots, "park-limit-390.png") });
    await tab.setViewportSize({ width: 1440, height: 900 });
    await notice.getByRole("button", { name: "stay", exact: true }).click();
    await waitFor(async () => urlChat() === ids[3] && await shown() === ids[3] && await notice.count() === 0, "stay keeps the shown chat");
    // stop the oldest and switch: resume it, abort it, then the refused swap again
    await newChat.click();
    await notice.waitFor({ timeout: 30_000 });
    const beforeStop = frames.length;
    await notice.getByRole("button", { name: 'stop "park hold 1" and switch', exact: true }).click();
    // the shown chat stays under the notice until the swap lands: wait for the new chat itself, its id in the url, the notice gone
    await waitFor(async () => !ids.includes(urlChat() ?? ids[0]!) && await notice.count() === 0, "stop-oldest opened the new chat");
    const stopFrames = sentSince(beforeStop);
    const resumeAt = stopFrames.findIndex((frame) => frame.method === "resume" && frame.params?.session_id === ids[0]);
    const abortAt = stopFrames.findIndex((frame) => frame.method === "abort" && frame.params?.session_id === ids[0]);
    const swapAt = stopFrames.findIndex((frame, at) => at > abortAt && frame.method === "new_session");
    if (resumeAt < 0 || abortAt < resumeAt || swapAt < abortAt) throw new Error(`stop-oldest frames out of order: resume ${resumeAt}, abort ${abortAt}, new_session ${swapAt}`);
    const abortReply = frames.slice(beforeStop).find((frame) => frame.dir === "received" && frame.id === stopFrames[abortAt]!.id);
    if (!abortReply || abortReply.error) throw new Error(`abort of the oldest parked chat failed: ${JSON.stringify(abortReply ?? null)}`);
    await waitFor(() => rowIdle(ids[0]!), "the stopped chat's row shows no state");
    // a reload takes the 3 parked chats back (oldest first, each with its page binding) before the shown chat opens
    const fifth = urlChat();
    if (!fifth || ids.includes(fifth)) throw new Error("the new chat is not named in the url");
    const beforeReload = frames.length;
    await tab.reload();
    await composer.waitFor();
    const reload = sentSince(beforeReload).filter((frame) => frame.method === "resume");
    const order = reload.map((frame) => frame.params?.session_id);
    const expected = [ids[1], ids[2], ids[3], fifth];
    if (JSON.stringify(order.slice(0, 4)) !== JSON.stringify(expected) || reload.slice(0, 3).some((frame) => !(frame.params?.mcp_bindings as unknown[] | undefined)?.length))
      throw new Error(`reload did not reclaim the parked chats first: ${JSON.stringify(order)}`);
    await waitFor(async () => JSON.stringify(lastParked(beforeReload)?.map((row) => row.session_id)) === JSON.stringify(ids.slice(1)), "status lists the reclaimed chats as parked");
    for (const id of ids.slice(1)) await waitFor(async () => await rowMeta(id) === "running in this tab", `reclaimed row ${id} says running in this tab`);
    // another tab opens a parked chat: read-only, and the parked turn's new text streams there (zeta G9)
    await reader.goto(`${origin}/?chat=${ids[1]}`);
    await reader.getByText("this chat is open or kept running in another tab. you can read it here.", { exact: true }).waitFor();
    await Bun.write(release, "release");
    await reader.getByText(/park finished/).waitFor({ timeout: 30_000 }).catch(() => {
      throw new Error("G9: a parked chat's live reply did not reach the other tab that reads it");
    });
    // the turns end: zeta closes the parked chats, and their rows show no state (not a stale "running")
    for (const id of ids.slice(1)) await waitFor(() => rowIdle(id), `finished chat ${id} shows no state`);
    if ((await tab.locator("body").innerText()).includes("parked_session_changed")) throw new Error("a parked_session_changed event reached the page");
    console.log("session_park limit: notice names 3 parked chats; stay; stop oldest = resume, abort, new_session; reload reclaims 3; reader tab streams a parked chat");
    return ids;
  } finally {
    await tab.close();
    await reader.close();
  }
}
