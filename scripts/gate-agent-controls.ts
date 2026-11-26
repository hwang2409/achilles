import { join } from "node:path";
import type { Browser, Page } from "../apps/web/node_modules/playwright";

export type Discovery = { url: string; controller_token: string; observer_token: string };
export const agentControlArtifacts = ["spawn-review-1440.png", "spawn-busy-refusal-1440.png", "chat-agents-1440.png", "cancel-review-1440.png", "cancel-review-390.png", "cancel-review-390-200pct.png", "canceled-run-390.png"];
const task = "inspect a synthetic child run";
const spawnButton = '[data-write-surface="agents.spawn"]';
const cancelButton = '[data-write-surface="agents.cancel"]';

// drives agent controls from the chat tab that holds the parent session: header "Agents" → spawn; sub-agent row → cancel.
export async function gateAgentControls(browser: Browser, origin: string, discovery: Discovery,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>, screenshots?: string) {
  const main = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  main.setDefaultTimeout(10_000);
  const frames: { role?: string; method: string; params: Record<string, unknown> }[] = [];
  function watch(tab: Page) {
    tab.on("websocket", (socket) => {
      let role: string | undefined;
      socket.on("framesent", ({ payload }) => {
        const { method, params } = JSON.parse(String(payload));
        if (method === "hello") role = params.role;
        if (method === "child_run_spawn" || method === "child_run_cancel") frames.push({ role, method, params });
      });
    });
  }
  await main.route("**/api/zeta/discovery", (route) => route.fulfill({ json: discovery }));
  watch(main);
  const capture = (tab: Page, label: string) => screenshots ? tab.screenshot({ path: join(screenshots, `${label}.png`) }) : undefined;
  const openAgents = async (tab: Page) => {
    await tab.getByRole("button", { name: "Agents", exact: true }).click();
    const dialog = tab.locator("dialog.chat-agents");
    await dialog.waitFor();
    return dialog;
  };
  try {
    await main.goto(`${origin}/#new-chat`);
    const composer = main.getByRole("textbox", { name: "message" });
    await composer.fill("hold a synthetic parent turn", { timeout: 30_000 });
    await composer.press("Enter");
    // the fixture provider holds the parent turn open: spawn is refused while it runs
    const stop = main.getByRole("button", { name: "stop the running turn" });
    await stop.waitFor();
    const root = await main.locator(".chat-header [data-session-id]").getAttribute("data-session-id");
    if (!root) throw new Error("the chat header has no session id");
    if (new URL(main.url()).searchParams.get("chat") !== root) await main.goto(`${origin}/?chat=${encodeURIComponent(root)}`);
    const agents = await openAgents(main);
    await agents.getByText("no agents in this chat yet.").waitFor();
    await agents.getByRole("button", { name: "+ spawn agent" }).click();
    const picker = agents.getByRole("combobox", { name: "profile" });
    await picker.getByRole("option", { name: "run", exact: true }).waitFor({ state: "attached" });
    await picker.selectOption("run");
    await agents.getByRole("textbox", { name: "task" }).fill(task);
    await agents.locator(spawnButton).click();
    const review = main.locator("dialog.confirmation-dialog");
    await review.getByText(root, { exact: true }).waitFor();
    await review.getByText("inherited cwd", { exact: true }).waitFor();
    await capture(main, "spawn-review-1440");
    await review.getByRole("checkbox", { name: "i reviewed the scope" }).check();
    await review.getByRole("button", { name: "spawn agent" }).click();
    await review.getByText(/zeta is busy/).waitFor();
    await capture(main, "spawn-busy-refusal-1440");
    await main.keyboard.press("Escape");
    await review.waitFor({ state: "hidden" });
    await agents.getByRole("button", { name: "close", exact: true }).click();
    await stop.click();
    await stop.waitFor({ state: "hidden" });
    const again = await openAgents(main);
    await again.getByRole("button", { name: "+ spawn agent" }).click();
    await again.getByRole("combobox", { name: "profile" }).getByRole("option", { name: "run", exact: true }).waitFor({ state: "attached" });
    await again.getByRole("combobox", { name: "profile" }).selectOption("run");
    await again.getByRole("textbox", { name: "task" }).fill(task);
    await again.locator(spawnButton).click();
    await review.getByRole("checkbox", { name: "i reviewed the scope" }).check();
    await review.getByRole("button", { name: "spawn agent" }).click();
    await main.getByText(/spawned run as/).waitFor();
    await again.getByRole("button", { name: new RegExp(task) }).waitFor();
    await capture(main, "chat-agents-1440");
    await again.getByRole("button", { name: "close", exact: true }).click();
    await again.waitFor({ state: "hidden" });
    // the transcript's sub-agent row opens the same dialog on that run
    await main.locator('button[data-part="sub-agent"]').first().click();
    const detail = main.locator("dialog.chat-agents");
    const cancel = detail.locator(cancelButton);
    await cancel.waitFor();
    const name = async (tab: Page) => (await tab.locator("dialog.confirmation-dialog .confirmation-proof strong").innerText()).trim();
    await cancel.click();
    await capture(main, "cancel-review-1440");
    await main.keyboard.press("Escape");
    await review.waitFor({ state: "hidden" });
    if (!await cancel.evaluate(node => node === document.activeElement)) throw new Error("cancel review did not restore opener focus");
    if (!await detail.isVisible()) throw new Error("escape on the cancel review closed the agents dialog");
    await main.setViewportSize({ width: 390, height: 844 });
    await Bun.sleep(350);
    await cancel.click();
    if ((await review.boundingBox())?.height !== 844) throw new Error("390 cancel review is not full height");
    await capture(main, "cancel-review-390");
    const zoom = await browser.newPage({ viewport: { width: 195, height: 422 }, deviceScaleFactor: 2 });
    try {
      await zoom.route("**/api/zeta/discovery", route => route.fulfill({ json: discovery }));
      await zoom.goto(`${origin}/?chat=${encodeURIComponent(root)}`);
      const zoomAgents = await openAgents(zoom);
      await zoomAgents.getByRole("button", { name: new RegExp(task) }).click();
      await zoomAgents.locator(cancelButton).click();
      await zoom.getByRole("textbox", { name: /^type/ }).fill(await name(zoom));
      await Bun.sleep(350);
      await capture(zoom, "cancel-review-390-200pct");
    } finally { await zoom.close(); }
    await review.getByRole("textbox", { name: /^type/ }).fill(await name(main));
    await review.getByRole("button", { name: "cancel run" }).click();
    await main.getByText("cancellation requested.", { exact: false }).waitFor();
    await waitFor(async () => {
      if (await detail.locator(".agents-run-head .agents-state[data-status=canceled]").count() === 1) return true;
      const refresh = detail.getByRole("button", { name: "refresh", exact: true });
      if (await refresh.isEnabled()) await refresh.click();
      return false;
    }, "terminal canceled run after refresh");
    await capture(main, "canceled-run-390");
    const [spawn, done] = frames;
    if (frames.length !== 2 || spawn?.role !== "controller" || spawn.method !== "child_run_spawn" || spawn.params.session_id !== root || spawn.params.background !== true ||
      done?.role !== "controller" || done.method !== "child_run_cancel" || done.params.session_id !== root || done.params.reason !== "user_cancelled")
      throw new Error(`agent control frames do not match confirmed requests from the chat tab: ${JSON.stringify(frames)}`);
    console.log("agent controls from the chat tab: busy refusal; child_run_spawn → sub-agent row → child_run_cancel → canceled");
    return ["agents.spawn", "agents.cancel"];
  } finally { await main.close(); }
}
