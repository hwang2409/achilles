import { join } from "node:path";
import type { Browser, Page } from "../apps/web/node_modules/playwright";

export type Discovery = { url: string; controller_token: string; observer_token: string };
export const agentControlArtifacts = ["spawn-review-1440.png", "spawn-observer-refusal-1440.png", "cancel-review-1440.png", "cancel-review-390.png", "cancel-review-390-200pct.png", "canceled-run-390.png"];
const task = "inspect a synthetic child run";
const spawnButton = '[data-write-surface="agents.spawn"]';
const cancelButton = '[data-write-surface="agents.cancel"]';

export async function gateAgentControls(browser: Browser, origin: string, discovery: Discovery,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>, screenshots?: string) {
  const main = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  main.setDefaultTimeout(10_000);
  let driver: WebSocket | undefined;
  const frames: { role?: string; method: string; params: Record<string, unknown> }[] = [];
  function watch(tab: Page) {
    tab.on("websocket", (socket) => {
      let role: string | undefined;
      socket.on("framesent", ({ payload }) => {
        const { method, params } = JSON.parse(String(payload));
        if (method === "hello") role = params.role;
        if (method === "child_run_spawn" || method === "child_run_cancel" || method === "abort") frames.push({ role, method, params });
      });
    });
  }
  await main.route("**/api/zeta/discovery", (route) => route.fulfill({ json: discovery }));
  watch(main);
  const capture = (tab: Page, label: string) => screenshots ? tab.screenshot({ path: join(screenshots, `${label}.png`) }) : undefined;
  const openDriver = () => new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(discovery.url, { protocols: ["zeta.v1", `zeta.bearer.${discovery.controller_token}`], headers: { Origin: origin } });
    driver = ws;
    const timer = setTimeout(() => { ws.close(); reject(new Error("agent gate controller open timeout")); }, 5000);
    ws.onerror = () => { clearTimeout(timer); reject(new Error("agent gate socket error")); };
    ws.onopen = () => { clearTimeout(timer); resolve(); };
  });
  let id = 0;
  const request = (method: string, params: object) => new Promise<Record<string, any>>((resolve, reject) => {
    const ws = driver!;
    const requestId = ++id;
    const receive = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      if (frame.id !== requestId) return;
      clearTimeout(timer);
      ws.removeEventListener("message", receive);
      if (frame.error) reject(new Error(`${method}: ${frame.error.code}`)); else resolve(frame.result);
    };
    const timer = setTimeout(() => { ws.removeEventListener("message", receive); reject(new Error(`${method}: no reply`)); }, 5000);
    ws.addEventListener("message", receive);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
  });
  const closeDriver = () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("agent gate controller close timeout")), 5000);
    driver!.onclose = () => { clearTimeout(timer); resolve(); };
    driver!.close();
  });
  const hello = () => request("hello", { client_version: "1.2", protocol_version: "1.2", features: ["serve_observers", "child_run_control_v1"], role: "controller" });
  try {
    await openDriver();
    await hello();
    const session = await request("new_session", {});
    const root: unknown = session.session?.session_id;
    if (typeof root !== "string") throw new Error("missing fixture root session");
    await main.goto(`${origin}/agents`);
    await main.getByRole("button", { name: "+ spawn agent" }).click();
    const picker = main.getByRole("combobox", { name: "profile" });
    await main.getByText("reading the active session…", { exact: true }).waitFor({ state: "hidden" });
    await picker.click();
    await main.getByRole("option", { name: "run", exact: true }).click();
    await main.getByRole("textbox", { name: "task" }).fill(task);
    await main.locator(spawnButton).click();
    const dialog = main.getByRole("dialog");
    await dialog.getByText(root, { exact: true }).waitFor();
    await dialog.getByText("inherited cwd", { exact: true }).waitFor();
    await capture(main, "spawn-review-1440");
    await dialog.getByRole("checkbox", { name: "i reviewed the scope" }).check();
    await dialog.getByRole("button", { name: "spawn agent" }).click();
    await dialog.getByText(/another tab had control/).waitFor();
    await capture(main, "spawn-observer-refusal-1440");
    if (frames.length) throw new Error("observer refusal sent a child write");
    await request("send", { text: "hold a synthetic parent turn" });
    await waitFor(async () => (await request("status", {})).state === "running", "parent turn active");
    await dialog.getByRole("button", { name: "spawn agent" }).click();
    await dialog.getByText(/another tab had control/).waitFor();
    if (frames.length) throw new Error("mid-turn refusal sent a child write");
    await request("abort", {});
    await waitFor(async () => (await request("status", {})).state === "idle", "parent turn idle");
    await closeDriver();
    await dialog.getByRole("button", { name: "spawn agent" }).click();
    await main.getByText(/spawned run as/).waitFor();
    const run = main.getByRole("link", { name: new RegExp(task) });
    await run.click();
    const review = main.locator(cancelButton);
    // The form is no longer needed; preserve room for the selected run in narrow layouts.
    await main.getByRole("button", { name: "close spawn form" }).click();
    const name = async (tab: Page) => (await tab.getByRole("dialog").locator(".confirmation-proof strong").innerText()).trim();
    await review.click();
    await capture(main, "cancel-review-1440");
    await main.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (!await review.evaluate(node => node === document.activeElement)) throw new Error("cancel review did not restore opener focus");
    await main.setViewportSize({ width: 390, height: 844 });
    await Bun.sleep(350);
    await review.click();
    if ((await dialog.boundingBox())?.height !== 844) throw new Error("390 cancel review is not full height");
    await capture(main, "cancel-review-390");
    const zoom = await browser.newPage({ viewport: { width: 195, height: 422 }, deviceScaleFactor: 2 });
    try {
      await zoom.route("**/api/zeta/discovery", route => route.fulfill({ json: discovery }));
      await zoom.goto(main.url());
      await zoom.locator(cancelButton).click();
      await zoom.getByRole("textbox", { name: /^type/ }).fill(await name(zoom));
      await Bun.sleep(350);
      await capture(zoom, "cancel-review-390-200pct");
    } finally { await zoom.close(); }
    await dialog.getByRole("textbox", { name: /^type/ }).fill(await name(main));
    await dialog.getByRole("button", { name: "cancel run" }).click();
    await main.getByText("cancellation requested.", { exact: false }).waitFor();
    await waitFor(async () => await main.locator("[data-agent-run-heading] [data-agent-state][data-status=canceled]").count() === 1, "terminal canceled row after refresh");
    await capture(main, "canceled-run-390");
    const [spawn, cancel] = frames;
    if (frames.length !== 2 || spawn?.role !== "controller" || spawn.method !== "child_run_spawn" || spawn.params.session_id !== root || spawn.params.background !== true ||
      cancel?.role !== "controller" || cancel.method !== "child_run_cancel" || cancel.params.session_id !== root || cancel.params.reason !== "user_cancelled")
      throw new Error("agent control frames do not match confirmed controller requests");
    console.log("agent controls: observer and mid-turn refusal; controller child_run_spawn → child_run_cancel → canceled");
    return ["agents.spawn", "agents.cancel"];
  } finally { driver?.close(); await main.close(); }
}
