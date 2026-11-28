import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import type { GateWait } from "./gate-diagnostics";

type WaitFor = (check: () => Promise<boolean>, label: string) => Promise<void>;
type Frame = { id?: number | string; method?: string; params?: { text?: string }; result?: { kind?: string; text?: string; commands?: { name?: string }[] } };

// the "/" menu: slash_list fills it, arrows and escape send nothing, enter runs /help (read-only) through slash_run
export async function gateSlashCommands(page: Page, requests: () => Frame[], waitFor: WaitFor, gateWait: GateWait) {
  const shots = process.env.SLASH_SCREENSHOT_DIR;
  const capture = async (name: string) => {
    if (!shots) return;
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 900 });
  const field = page.getByRole("textbox", { name: "message", exact: true });
  const menu = page.getByRole("listbox", { name: "commands" });
  const since = requests().length;
  const runs = () => requests().slice(since).filter((frame) => frame.method === "slash_run");

  await field.fill("/");
  await gateWait.playwright(menu.getByRole("option", { name: /^\/help/ }), "waitFor", { timeout: 20_000 });
  const listed = requests().slice(since).find((frame) => frame.result?.commands)?.result?.commands?.map((row) => row.name) ?? [];
  if (!listed.includes("help")) throw new Error(`slash_list did not list help: ${JSON.stringify(listed)}`);
  if (await menu.getByRole("option").count() !== listed.length) throw new Error("the menu does not show every listed command");
  await field.press("ArrowDown");
  await field.press("ArrowUp");
  await capture("slash-menu-1440x900");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("slash-menu-390x844");
  await page.setViewportSize({ width: 1440, height: 900 });
  await field.fill("/hel");
  await waitFor(async () => (await menu.getByRole("option", { selected: true }).innerText()).startsWith("/help"), "the menu chooses /help");
  await field.press("Escape");
  await gateWait.playwright(menu, "waitFor", { state: "hidden", timeout: 10_000 });
  if (await field.inputValue() !== "/hel") throw new Error("escape changed the draft");
  if (runs().length) throw new Error("the menu ran a command without enter");

  await field.fill("/he");
  await gateWait.playwright(menu, "waitFor", { state: "visible", timeout: 10_000 });
  await field.press("Enter");
  const result = page.getByRole("group", { name: "composer command result" }).getByRole("status");
  await waitFor(async () => (await result.count()) === 1 && (await result.innerText()).startsWith("built-in commands:"), "/help output shows inline");
  const run = runs();
  if (run.length !== 1 || run[0]!.params?.text !== "/help") throw new Error(`enter sent ${JSON.stringify(run.map((frame) => frame.params?.text))}, not one /help`);
  const reply = requests().slice(since).find((frame) => frame.id === run[0]!.id && frame.result);
  if (reply?.result?.kind !== "output") throw new Error(`slash_run /help did not return output: ${JSON.stringify(reply?.result ?? null)}`);
  if (await field.inputValue() !== "") throw new Error("a run command stayed in the draft");
  await capture("slash-result-1440x900");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("slash-result-390x844");
  await field.press("Escape");
  await gateWait.playwright(result, "waitFor", { state: "detached", timeout: 10_000 });
  if (viewport) await page.setViewportSize(viewport);
}
