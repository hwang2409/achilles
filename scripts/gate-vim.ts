import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

type WaitFor = (check: () => Promise<boolean>, label: string) => Promise<void>;
type WhileDisconnected = (check: () => Promise<void>) => Promise<void>;

export async function gateVim(page: Page, control: string, waitFor: WaitFor, whileDisconnected: WhileDisconnected) {
  const screenshotDir = process.env.VIM_SCREENSHOT_DIR;
  const screenshot = async (name: string) => {
    if (!screenshotDir) return;
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
  };
  if (screenshotDir) await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("achilles-settings", JSON.stringify({ vim: true })));
  await page.reload();
  const composer = page.locator('.vim-composer[data-part="composer"]');
  const field = page.getByRole("textbox", { name: "message" });
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await page.locator('.vim-composer[data-state="idle"]').waitFor({ state: "visible", timeout: 20_000 });
  await field.fill("helo");
  await screenshot("insert");
  await field.press("Escape");
  await field.press("0");
  await field.press("l");
  await field.press("a");
  await field.press("l");
  await field.press("Escape");
  if (await field.textContent() !== "hello") throw new Error(`vim edit produced ${JSON.stringify(await field.textContent())}, not "hello"`);
  await screenshot("normal");
  await field.press("v");
  await field.press("l");
  await screenshot("visual");
  await field.press("Escape");
  await field.press("Escape");
  await screenshot("normal-blurred");
  if (await field.evaluate((element) => element === document.activeElement)) throw new Error("second vim escape did not blur the composer");
  const blurredDraft = await field.textContent();
  if (blurredDraft !== "hello") throw new Error(`vim escape changed the draft: ${JSON.stringify(blurredDraft)}`);
  await page.keyboard.press("i");
  if (!(await field.evaluate((element) => element === document.activeElement))) throw new Error("page-level i did not refocus the composer");
  if (await field.textContent() !== "hello") throw new Error("refocusing the vim composer changed the draft");
  await field.press("Escape");
  const before = JSON.parse(await Bun.file(control).text());
  await field.press("Enter");
  await waitFor(async () => {
    const current = JSON.parse(await Bun.file(control).text());
    return current.request_count === (before.request_count ?? 0) + 1 && current.last_message.includes("hello");
  }, "vim message on this backend turn");
  const current = JSON.parse(await Bun.file(control).text());
  if (current.last_message.includes("helo") || !current.last_message.includes("hello")) throw new Error(`vim backend message was not exactly "hello": ${current.last_message}`);

  await field.fill("kept draft");
  await whileDisconnected(async () => {
    await page.getByRole("alert").filter({ hasText: "connection to zeta was lost" }).waitFor({ state: "visible", timeout: 20_000 });
    const keptDraft = await page.getByRole("textbox", { name: "message" }).textContent().catch(() => null);
    if (keptDraft !== "kept draft") throw new Error(`vim read-only draft-kept assertion failed: expected "kept draft", got ${JSON.stringify(keptDraft)}`);
    await page.locator('.vim-composer[data-state="read-only"]').waitFor({ state: "visible", timeout: 20_000 });
    await screenshot("connection-lost");
  });
  await page.locator('.vim-composer[data-state="idle"]').waitFor({ state: "visible", timeout: 20_000 });
  const reconnectedDraft = await field.textContent();
  if (reconnectedDraft !== "kept draft") throw new Error(`vim reconnect changed the kept draft: ${JSON.stringify(reconnectedDraft)}`);
}
