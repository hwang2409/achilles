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
  const settingsDialog = page.getByRole("dialog", { name: "settings" });
  const openSettings = () => page.locator("aside.sidebar").getByRole("button", { name: /settings/ }).click();
  const setVim = async (enabled: boolean) => {
    await openSettings();
    await settingsDialog.waitFor({ state: "visible", timeout: 10_000 });
    const toggle = settingsDialog.getByRole("switch", { name: "vim mode" });
    if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) await toggle.click();
    await settingsDialog.getByRole("button", { name: "esc" }).click();
    await settingsDialog.waitFor({ state: "hidden", timeout: 10_000 });
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
  const sessionId = () => page.locator("[data-session-id]").getAttribute("data-session-id");
  const switchTo = async (id: string) => {
    await page.locator(`.chat-row[href*="chat=${id}"]`).click();
    await waitFor(async () => await sessionId() === id, `chat ${id}`);
    await page.getByRole("textbox", { name: "message", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  };
  const originalSession = await sessionId();
  if (!originalSession) throw new Error("stock composer session id missing");
  let stockField = page.getByRole("textbox", { name: "message", exact: true });
  await stockField.focus();
  await page.keyboard.press("Meta+b");
  if (!(await page.locator(".app-shell").getAttribute("class"))?.includes("sidebar-collapsed")) throw new Error("modifier row: command+B did not collapse the sidebar with stock composer focus");
  await page.keyboard.press("Meta+b");
  await page.keyboard.press("Meta+Shift+o");
  await waitFor(async () => Boolean(await sessionId()) && await sessionId() !== originalSession, "command+shift+O from stock composer");
  const stockSession = await sessionId();
  if (!stockSession) throw new Error("modifier row: command+shift+O did not create a chat with stock composer focus");

  const multilineStockDraft = "stock first\n\n  stock third";
  stockField = page.getByRole("textbox", { name: "message", exact: true });
  await stockField.fill(multilineStockDraft);
  await switchTo(originalSession);
  await switchTo(stockSession);
  stockField = page.getByRole("textbox", { name: "message", exact: true });
  if (await stockField.inputValue() !== multilineStockDraft) throw new Error(`stock remount row: expected ${JSON.stringify(multilineStockDraft)}, got ${JSON.stringify(await stockField.inputValue())}`);

  await screenshot("plain-after");
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
  await field.focus();
  if (await composer.getAttribute("data-mode") !== "insert") throw new Error("vim did not start in INSERT");
  await openSettings();
  await settingsDialog.waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.press("Escape");
  await settingsDialog.waitFor({ state: "hidden", timeout: 10_000 });
  if (await composer.getAttribute("data-mode") !== "insert") throw new Error("closing settings with escape changed vim mode");
  await page.keyboard.press("Control+b");
  if (!(await page.locator(".app-shell").getAttribute("class"))?.includes("sidebar-collapsed")) throw new Error("modifier row: control+B did not collapse the sidebar with vim composer focus");
  await page.keyboard.press("Control+b");
  const vimSession = await sessionId();
  await page.keyboard.press("Control+Shift+o");
  await waitFor(async () => Boolean(await sessionId()) && await sessionId() !== vimSession, "control+shift+O from vim composer");
  if (!vimSession) throw new Error("vim composer session id missing before modifier shortcut");
  await switchTo(vimSession);
  if (await vimDraft() !== "first\n\n  third") throw new Error("modifier chat creation changed the vim draft");
  await field.fill("path");
  await field.press("/");
  if (await vimDraft() !== "path/") throw new Error(`vim insert slash was stolen by a global shortcut: ${JSON.stringify(await vimDraft())}`);
  if (await page.locator(".chat-search input").evaluate((element) => element === document.activeElement)) throw new Error("vim insert slash opened chat search");
  await field.fill("helo");
  await screenshot("insert");
  await field.press("Escape");
  if (await composer.getAttribute("data-mode") !== "normal") throw new Error("escape in vim INSERT did not enter NORMAL");
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

  await stockAfterOperator.fill("stock confirmed once");
  await setVim(true);
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await setVim(false);
  let confirmedStock = page.getByRole("textbox", { name: "message", exact: true });
  await confirmedStock.waitFor({ state: "visible", timeout: 20_000 });
  const beforeStockSend = JSON.parse(await Bun.file(control).text());
  await confirmedStock.press("Enter");
  await waitFor(async () => {
    const current = JSON.parse(await Bun.file(control).text());
    return current.request_count === (beforeStockSend.request_count ?? 0) + 1 && current.last_message.includes("stock confirmed once");
  }, "stock message on this backend turn");
  await waitFor(async () => await confirmedStock.inputValue() === "", "confirmed stock send to clear its draft");
  await switchTo(originalSession);
  await switchTo(stockSession);
  confirmedStock = page.getByRole("textbox", { name: "message", exact: true });
  const afterStockSend = JSON.parse(await Bun.file(control).text());
  if (await confirmedStock.inputValue() !== "" || afterStockSend.request_count !== (beforeStockSend.request_count ?? 0) + 1) throw new Error(`duplicate-send row: expected empty draft and exactly one send, got ${JSON.stringify(await confirmedStock.inputValue())} and ${afterStockSend.request_count - (beforeStockSend.request_count ?? 0)} sends`);

  await confirmedStock.fill("kept draft");
  await confirmedStock.press("Enter");
  const stopButton = page.getByRole("button", { name: "stop the running turn" });
  await stopButton.waitFor({ state: "visible", timeout: 20_000 });
  await stopButton.focus();
  await whileDisconnected(async () => {
    await page.getByRole("alert").filter({ hasText: "connection to zeta was lost" }).waitFor({ state: "visible", timeout: 20_000 });
    const readOnlyComposer = page.locator('[data-part="composer"][data-state="read-only"]').last();
    await readOnlyComposer.waitFor({ state: "visible", timeout: 20_000 });
    if (!await readOnlyComposer.evaluate((element) => element.contains(document.activeElement))) throw new Error("read-only composer did not retain focus after its focused stop button disappeared");
    const keptDraft = await readOnlyComposer.locator("textarea").inputValue().catch(() => null);
    if (keptDraft !== "kept draft") throw new Error(`plain read-only draft-kept assertion failed: expected "kept draft", got ${JSON.stringify(keptDraft)}`);
    await screenshot("connection-lost");
  });
  const retry = page.getByRole("button", { name: "retry now" });
  if (await retry.isVisible().catch(() => false)) await retry.click();
  const restoredStock = page.locator('textarea[aria-label="message"]');
  await restoredStock.waitFor({ state: "visible", timeout: 20_000 });
  if (await restoredStock.inputValue() !== "kept draft") throw new Error("plain reconnect changed the kept draft");
  await setVim(true);
  await page.locator('.vim-composer[data-state="idle"]').waitFor({ state: "visible", timeout: 20_000 });
  if (await vimDraft() !== "kept draft") throw new Error("switching to vim changed the reconnected draft");
  await setVim(false);
}
