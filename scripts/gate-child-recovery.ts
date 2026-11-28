import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "../apps/web/node_modules/playwright";
import type { Discovery } from "./gate-agent-controls";
import { assertAgentsBackInPanel } from "./gate-geometry";

export const childRecoveryArtifacts = ["child-suspended-1440.png", "child-suspended-390.png", "child-suspended-notice-1440.png", "agents-suspended-1440.png", "agents-suspended-390.png", "child-recovered-1440.png"];
const task = "summarize a synthetic report";
const paused = '.transcript [data-part="child-recovery"][data-kind="child_suspended"]';
const resumed = '.transcript [data-part="child-recovery"][data-kind="child_recovered"]';

// scripts/child-recovery-server.py: the child's provider fails until `online` exists, so zeta suspends the child and
// probes it at +5 s, +10 s, … . the chat shows the suspended row with its retry time and the paused notice; after the
// flag, the resumed notice and a row that is no longer suspended; after a reload, history shows each notice once.
export async function gateChildRecovery(browser: Browser, origin: string, discovery: Discovery, online: string, hidden: string[],
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>, screenshots?: string) {
  const main = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  main.setDefaultTimeout(10_000);
  const hellos: { asked: unknown; granted: unknown }[] = [];
  main.on("websocket", (socket) => {
    let id: unknown;
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.method === "hello") { id = frame.id; hellos.push({ asked: frame.params?.features, granted: undefined }); }
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (id !== undefined && frame.id === id) hellos[hellos.length - 1]!.granted = frame.result?.capabilities?.features;
    });
  });
  await main.route("**/api/zeta/discovery", (route) => route.fulfill({ json: discovery }));
  const capture = (tab: Page, label: string) => screenshots ? tab.screenshot({ path: join(screenshots, `${label}.png`) }) : undefined;
  const openAgents = async () => {
    await main.getByRole("button", { name: "Agents", exact: true }).click();
    const dialog = main.locator("dialog.chat-agents");
    await dialog.waitFor();
    return dialog;
  };
  const noLeaks = async (label: string) => {
    const text = await main.locator("body").innerText();
    if (/child_suspended|child_recovered/.test(text)) throw new Error(`${label}: a raw notice label is on the page`);
    const leak = hidden.find((value) => text.includes(value));
    if (leak) throw new Error(`${label}: the page shows a local path`);
  };
  try {
    await main.goto(`${origin}/#new-chat`);
    const composer = main.getByRole("textbox", { name: "message" });
    await composer.fill("start a synthetic parent", { timeout: 20_000 });
    await composer.press("Enter");
    await main.getByText("parent reply").first().waitFor({ timeout: 20_000 });
    await main.getByRole("button", { name: "stop the running turn" }).waitFor({ state: "hidden" });
    if (!hellos.some(({ asked, granted }) => Array.isArray(asked) && asked.includes("child_recovery") && Array.isArray(granted) && granted.includes("child_recovery")))
      throw new Error(`zeta did not negotiate child_recovery: ${JSON.stringify(hellos)}`);
    const agents = await openAgents();
    await agents.getByRole("button", { name: "+ spawn agent" }).click();
    const picker = agents.getByRole("combobox", { name: "profile" });
    await picker.getByRole("option", { name: "run", exact: true }).waitFor({ state: "attached" });
    await picker.selectOption("run");
    await agents.getByRole("textbox", { name: "task" }).fill(task);
    await agents.locator('[data-write-surface="agents.spawn"]').click();
    const review = main.locator("dialog.confirmation-dialog");
    await review.getByRole("checkbox", { name: "i reviewed the scope" }).check();
    await review.getByRole("button", { name: "spawn agent" }).click();
    await main.getByText(/spawned run:/).waitFor();
    // the dialog rereads when the paused notice lands; refresh covers a notice that came before the dialog read
    const row = agents.locator(".chat-agents-runs .agents-row", { hasText: task });
    await waitFor(async () => {
      if (await row.locator('.agents-state[data-status="suspended"]').count() === 1 && /retries in \d/.test(await row.innerText())) return true;
      const refresh = agents.getByRole("button", { name: "refresh", exact: true });
      if (await refresh.isEnabled()) await refresh.click();
      return false;
    }, "suspended child row with its retry time");
    await row.click();
    await agents.locator(".agents-run-head", { hasText: "gives up at" }).waitFor();
    // a child with no turn yet never shows "0s", and its history read ends
    if (/elapsed\s+0s/.test(await agents.locator(".agents-run-head").innerText())) throw new Error("a child that never ran a turn shows 0s elapsed");
    await agents.locator('.agents-activity [data-state="loading"]').waitFor({ state: "detached" });
    // zeta f5efa62d: child_run_list says a provider-suspended child this server owns accepts a send, which wakes it
    await agents.locator(".agents-composer", { hasText: "sending wakes it now." }).waitFor();
    if (await agents.locator('[data-write-surface="agents.cancel"]').count() !== 1) throw new Error("a suspended child has no cancel");
    await capture(main, "child-suspended-1440");
    await main.setViewportSize({ width: 390, height: 844 });
    await Bun.sleep(350);
    await capture(main, "child-suspended-390");
    await main.setViewportSize({ width: 1440, height: 900 });
    await agents.getByRole("button", { name: "close", exact: true }).click();
    await main.locator(paused).waitFor();
    if (!/ paused · provider unavailable · retries at /.test(await main.locator(paused).innerText())) throw new Error("the paused notice does not say when zeta retries");
    await noLeaks("suspended");
    await capture(main, "child-suspended-notice-1440");
    // the Agents place reads the same row from the run catalog
    const place = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      place.setDefaultTimeout(10_000);
      await place.route("**/api/zeta/discovery", (route) => route.fulfill({ json: discovery }));
      await place.goto(`${origin}/agents`);
      const listed = place.locator(".agents-catalog .agents-row", { hasText: task });
      await listed.filter({ hasText: /retries in \d/ }).waitFor();
      if (!(await place.getByRole("combobox", { name: "state" }).locator("option").allTextContents()).includes("suspended")) throw new Error("the state filter has no suspended choice");
      await listed.click();
      await place.locator(".agents-run-head", { hasText: "gives up at" }).waitFor();
      await place.locator('.agents-activity [data-state="loading"]').waitFor({ state: "detached" });
      await assertAgentsBackInPanel(place);
      await capture(place, "agents-suspended-1440");
      await place.setViewportSize({ width: 390, height: 844 });
      await Bun.sleep(350);
      await capture(place, "agents-suspended-390");
    } finally { await place.close(); }
    // a message wakes the child at once: send it with the provider back, well before zeta's next probe
    const dialog = await openAgents();
    const pausedRow = dialog.locator(".chat-agents-runs .agents-row", { hasText: task });
    await pausedRow.click();
    const box = dialog.getByRole("textbox", { name: "message run" });
    await box.waitFor();
    let probeAt = 0;
    await waitFor(async () => {
      probeAt = Date.parse(await pausedRow.locator("time").getAttribute("dateTime") ?? "");
      if (probeAt - Date.now() >= 4000) return true;
      const refresh = dialog.getByRole("button", { name: "refresh", exact: true });
      if (await refresh.isEnabled()) await refresh.click();
      return false;
    }, "next probe at least 4 s away");
    await writeFile(online, "online\n");
    await box.fill("synthetic wake-up message");
    await dialog.locator('[data-write-surface="agents.send"]').click();
    await dialog.getByText("message accepted by zeta.").waitFor();
    await main.locator(resumed).waitFor({ state: "attached", timeout: Math.max(1000, probeAt - Date.now()) });
    if (Date.now() >= probeAt) throw new Error("the child recovered only at zeta's probe time, not from the message");
    console.log(`child recovery: a message to the suspended child woke it ${probeAt - Date.now()} ms before zeta's next probe`);
    const again = dialog;
    const done = again.locator(".chat-agents-runs .agents-row", { hasText: task });
    // the dialog read the list when it opened; it also rereads on the resumed notice
    await waitFor(async () => await done.locator(".agents-state").getAttribute("data-status") !== "suspended", "recovered child leaves suspended");
    await capture(main, "child-recovered-1440");
    await again.getByRole("button", { name: "close", exact: true }).click();
    const root = await main.locator(".chat-header [data-session-id]").getAttribute("data-session-id");
    if (!root) throw new Error("the chat header has no session id");
    await main.goto(`${origin}/?chat=${encodeURIComponent(root)}`);
    await main.locator(resumed).waitFor({ timeout: 20_000 });
    const counts = [await main.locator(paused).count(), await main.locator(resumed).count()];
    if (counts[0] !== 1 || counts[1] !== 1) throw new Error(`history shows ${counts[0]} paused and ${counts[1]} resumed notices, expected 1 each`);
    await noLeaks("history");
    console.log("child recovery: suspended row with retry time → paused notice → resumed notice → row left suspended; history shows 1 + 1 notices");
    await main.close();
    // evidence for zeta, not a gate check: does a client without child_recovery get these notices in history?
    const legacy = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await legacy.route("**/api/zeta/discovery", (route) => route.fulfill({ json: discovery }));
      await legacy.routeWebSocket((url) => url.hostname === "127.0.0.1", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((payload) => {
          const frame = JSON.parse(String(payload));
          if (frame.method === "hello" && Array.isArray(frame.params?.features)) frame.params.features = frame.params.features.filter((name: string) => name !== "child_recovery");
          server.send(JSON.stringify(frame));
        });
      });
      await legacy.goto(`${origin}/?chat=${encodeURIComponent(root)}`);
      await legacy.getByText("parent reply").first().waitFor({ timeout: 20_000 });
      await Bun.sleep(1000);
      const text = await legacy.locator(".transcript").innerText();
      console.log(`child recovery legacy history (no child_recovery feature): paused text ${text.includes("suspended: provider unavailable") ? "shown" : "absent"}, recovered text ${text.includes("child recovered") ? "shown" : "absent"}`);
    } finally { await legacy.close(); }
  } finally { if (!main.isClosed()) await main.close(); }
}
