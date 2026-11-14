import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Route } from "playwright";

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
  const setVim = async (enabled: boolean) => {
    await page.evaluate((value) => localStorage.setItem("achilles-settings", JSON.stringify({ vim: value })), enabled);
    const toggle = page.getByRole("button", { name: /create mode/ }).first();
    await toggle.click();
    await waitFor(async () => !(await toggle.isDisabled()), "create mode toggle");
  };
  const withDeadline = async <T>(promise: Promise<T>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish within 10 seconds`)), 10_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const stockField = page.getByRole("textbox", { name: "message", exact: true });
  await stockField.fill("first\n\n  third");
  let releaseChunk = () => {};
  const chunkReleased = new Promise<void>((resolve) => { releaseChunk = resolve; });
  let heldChunk: Route | null = null;
  let finishChunk = () => {};
  const chunkFinished = new Promise<void>((resolve) => { finishChunk = resolve; });
  const holdVimChunk = async (route: Route) => { heldChunk = route; await chunkReleased; try { await route.continue(); } finally { finishChunk(); } };
  await page.route("**/assets/VimComposer-*.js", holdVimChunk);
  try {
    await setVim(true);
    await waitFor(async () => heldChunk !== null, "lazy vim chunk request");
    const loadingField = page.getByRole("textbox", { name: "message", exact: true });
    await loadingField.fill("typed during vim load").catch(() => {});
    if (!(await loadingField.isDisabled())) throw new Error("vim loading fallback accepted typed input");
  } finally {
    releaseChunk();
    try {
      if (heldChunk) await withDeadline(chunkFinished, "held vim chunk");
    } finally {
      await page.unroute("**/assets/VimComposer-*.js", holdVimChunk);
    }
  }
  const composer = page.locator('.vim-composer[data-part="composer"]');
  const field = page.getByRole("textbox", { name: "message", exact: true });
  const vimDraft = () => composer.locator('[data-part="composer-field"]').getAttribute("data-value");
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  if (await vimDraft() !== "first\n\n  third") throw new Error(`vim did not preserve the multiline stock draft: ${JSON.stringify(await vimDraft())}`);
  await page.locator('.vim-composer[data-state="idle"]').waitFor({ state: "visible", timeout: 20_000 });
  await field.fill("path");
  await field.press("/");
  if (await vimDraft() !== "path/") throw new Error(`vim insert slash was stolen by a global shortcut: ${JSON.stringify(await vimDraft())}`);
  if (await page.locator(".chat-search input").evaluate((element) => element === document.activeElement)) throw new Error("vim insert slash opened chat search");
  await field.fill("helo");
  await screenshot("insert");
  await field.press("Escape");
  await field.press("0");
  await field.press("l");
  await field.press("a");
  await field.press("l");
  await field.press("Escape");
  if (await vimDraft() !== "hello") throw new Error(`vim edit produced ${JSON.stringify(await vimDraft())}, not "hello"`);
  await screenshot("normal");
  await field.press("v");
  await field.press("l");
  await screenshot("visual");
  await field.press("Escape");
  await field.press("Escape");
  await screenshot("normal-blurred");
  if (await field.evaluate((element) => element === document.activeElement)) throw new Error("second vim escape did not blur the composer");
  const blurredDraft = await vimDraft();
  if (blurredDraft !== "hello") throw new Error(`vim escape changed the draft: ${JSON.stringify(blurredDraft)}`);
  await page.keyboard.press("i");
  if (!(await field.evaluate((element) => element === document.activeElement))) throw new Error("page-level i did not refocus the composer");
  if (await vimDraft() !== "hello") throw new Error("refocusing the vim composer changed the draft");
  const before = JSON.parse(await Bun.file(control).text());
  await field.press("Escape");
  await field.press("Enter");
  await waitFor(async () => {
    const current = JSON.parse(await Bun.file(control).text());
    return current.request_count === (before.request_count ?? 0) + 1 && current.last_message.includes("hello");
  }, "vim message on this backend turn");
  const current = JSON.parse(await Bun.file(control).text());
  if (current.last_message.includes("helo") || !current.last_message.includes("hello")) throw new Error(`vim backend message was not exactly "hello": ${current.last_message}`);
  await waitFor(async () => await vimDraft() === "", "confirmed vim send to clear its draft");
  await setVim(false);
  const stockAfterSend = page.locator('textarea[aria-label="message"]');
  await stockAfterSend.waitFor({ state: "visible", timeout: 20_000 });
  if (await stockAfterSend.inputValue() !== "") throw new Error(`switching after confirmed send restored stale text: ${JSON.stringify(await stockAfterSend.inputValue())}`);

  await stockAfterSend.fill("remove\nkeep");
  await setVim(true);
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  if (await vimDraft() !== "remove\nkeep") throw new Error(`vim did not inherit the exact stock draft before dd: ${JSON.stringify(await vimDraft())}`);
  await field.press("Escape");
  await field.press("d");
  await field.press("d");
  if (await vimDraft() !== "keep") throw new Error(`vim dd did not update the logical draft: ${JSON.stringify(await vimDraft())}`);
  await setVim(false);
  const stockAfterOperator = page.locator('textarea[aria-label="message"]');
  await stockAfterOperator.waitFor({ state: "visible", timeout: 20_000 });
  if (await stockAfterOperator.inputValue() !== "keep") throw new Error(`switching after vim dd restored a stale draft: ${JSON.stringify(await stockAfterOperator.inputValue())}`);

  await setVim(true);
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await field.fill("kept draft");
  await whileDisconnected(async () => {
    await page.getByRole("alert").filter({ hasText: "connection to zeta was lost" }).waitFor({ state: "visible", timeout: 20_000 });
    const keptDraft = await vimDraft().catch(() => null);
    if (keptDraft !== "kept draft") throw new Error(`vim read-only draft-kept assertion failed: expected "kept draft", got ${JSON.stringify(keptDraft)}`);
    await page.locator('.vim-composer[data-state="read-only"]').waitFor({ state: "visible", timeout: 20_000 });
    await screenshot("connection-lost");
  });
  const retry = page.getByRole("button", { name: "retry now" });
  if (await retry.isVisible().catch(() => false)) await retry.click();
  await page.locator('.vim-composer[data-state="idle"]').waitFor({ state: "visible", timeout: 20_000 });
  const reconnectedDraft = await vimDraft();
  if (reconnectedDraft !== "kept draft") throw new Error(`vim reconnect changed the kept draft: ${JSON.stringify(reconnectedDraft)}`);
  await setVim(false);
  const restoredStock = page.locator('textarea[aria-label="message"]');
  await restoredStock.waitFor({ state: "visible", timeout: 20_000 });
  if (await restoredStock.inputValue() !== "kept draft") throw new Error("switching vim off changed the reconnected draft");
}
