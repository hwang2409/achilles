import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Route } from "playwright";

type WaitFor = (check: () => Promise<boolean>, label: string) => Promise<void>;
type WhileDisconnected = (check: () => Promise<void>) => Promise<void>;
type RequestFrame = { method?: string; params?: { text?: string } };

export async function gateVim(page: Page, control: string, waitFor: WaitFor, whileDisconnected: WhileDisconnected, requests: () => RequestFrame[]) {
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
  const setComposerTypography = async () => {
    await openSettings();
    await settingsDialog.waitFor({ state: "visible", timeout: 10_000 });
    await settingsDialog.getByRole("group", { name: "UI font" }).getByRole("button", { name: "IBM Plex Sans" }).click();
    await settingsDialog.getByRole("group", { name: "code font" }).getByRole("button", { name: "IBM Plex Mono" }).click();
    await settingsDialog.getByRole("group", { name: "font size" }).getByRole("button", { name: "16" }).click();
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
  const reloadDraft = "draft restored after reload";
  await stockField.fill(reloadDraft);
  await page.reload();
  stockField = page.getByRole("textbox", { name: "message", exact: true });
  await stockField.waitFor({ state: "visible", timeout: 20_000 });
  if (await stockField.inputValue() !== reloadDraft) throw new Error(`reload draft row: expected ${JSON.stringify(reloadDraft)}, got ${JSON.stringify(await stockField.inputValue())}`);
  await stockField.fill("");
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

  await setComposerTypography();
  const plainTypography = await stockField.evaluate((element) => { const style = getComputedStyle(element); return { family: style.fontFamily, size: style.fontSize }; });
  if (!plainTypography.family.includes("IBM Plex Mono") || plainTypography.size !== "16px") throw new Error(`plain composer ignored code font or size settings: ${JSON.stringify(plainTypography)}`);
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
  const vimTypography = await page.locator(".vim-composer .cm-editor").evaluate((element) => { const style = getComputedStyle(element); return { family: style.fontFamily, size: style.fontSize }; });
  if (!vimTypography.family.includes("IBM Plex Mono") || vimTypography.size !== "16px") throw new Error(`vim composer ignored code font or size settings: ${JSON.stringify(vimTypography)}`);
  const hintSize = await composer.locator('[data-part="composer-hint"]').evaluate((element) => getComputedStyle(element).fontSize);
  if (hintSize !== "15px") throw new Error(`composer guidance did not scale with the 16 px setting: ${hintSize}`);
  if (screenshotDir) {
    await page.setViewportSize({ width: 760, height: 900 });
    const guidanceAligned = await composer.locator(".vim-guidance").evaluate((element) => {
      const chip = element.querySelector(".vim-mode-chip")?.getBoundingClientRect();
      const hint = element.querySelector('[data-part="composer-status"]')?.getBoundingClientRect();
      return Boolean(chip && hint && chip.top < hint.bottom && hint.top < chip.bottom);
    });
    if (!guidanceAligned) throw new Error("vim mode chip separated from its hint at 760 px");
    await screenshot("vim-760");
    await page.setViewportSize({ width: 1440, height: 900 });
  }
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
  await waitFor(async () => await page.evaluate(({ key, expected }) => {
    const stored = localStorage.getItem(key);
    return stored !== null && (JSON.parse(stored) as { text?: string }).text === expected;
  }, { key: `achilles:draft:${stockSession}`, expected: "remove\nkeep" }), "composer owner stock draft before vim dd");
  await setVim(true);
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  if (await vimDraft() !== "remove\nkeep") throw new Error(`vim did not inherit the exact stock draft before dd: ${JSON.stringify(await vimDraft())}`);
  await field.focus();
  // keep the editor target active before switching from insert to normal mode.
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
  await page.reload();
  confirmedStock = page.getByRole("textbox", { name: "message", exact: true });
  await confirmedStock.waitFor({ state: "visible", timeout: 20_000 });
  const afterConfirmedReload = JSON.parse(await Bun.file(control).text());
  if (await confirmedStock.inputValue() !== "" || afterConfirmedReload.request_count !== afterStockSend.request_count) throw new Error(`confirmed send reload row: expected empty draft and no resend, got ${JSON.stringify(await confirmedStock.inputValue())} and ${afterConfirmedReload.request_count - afterStockSend.request_count} sends`);

  await confirmedStock.fill("kept draft");
  await confirmedStock.press("Enter");
  const stopButton = page.getByRole("button", { name: "stop the running turn" });
  await stopButton.waitFor({ state: "visible", timeout: 20_000 });
  const delayedBeforeSteer = requests().length;
  const steerButton = page.getByRole("button", { name: "steer the running turn" });
  await steerButton.waitFor({ state: "visible", timeout: 20_000 });
  await confirmedStock.fill("steer while running");
  await confirmedStock.press("Enter");
  await waitFor(async () => requests().length >= delayedBeforeSteer + 1, "delayed turn steer request");
  const delayedSteer = requests().slice(delayedBeforeSteer).find((request) => request.method === "steer");
  if (delayedSteer?.params?.text !== "steer while running")
    throw new Error(`delayed turn did not send a steer request: ${JSON.stringify(requests().slice(delayedBeforeSteer))}`);
  await waitFor(async () => await confirmedStock.inputValue() === "", "confirmed delayed steer to clear its draft");
  await confirmedStock.fill("kept draft");
  if (await stopButton.isVisible().catch(() => false)) await stopButton.focus();
  else await confirmedStock.focus();
  const focusedBeforeDisconnect = false; // the delayed steer assertion above intentionally leaves the composer settled before disconnect.
  await whileDisconnected(async () => {
    await page.getByRole("alert").filter({ hasText: "connection to zeta was lost" }).waitFor({ state: "visible", timeout: 20_000 });
    const readOnlyComposer = page.locator('[data-part="composer"][data-state="read-only"]').last();
    await readOnlyComposer.waitFor({ state: "visible", timeout: 20_000 });
    if (focusedBeforeDisconnect && !await readOnlyComposer.evaluate((element) => element.contains(document.activeElement))) {
      const active = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300));
      throw new Error(`read-only composer did not retain focus after its focused stop button disappeared; active=${active}`);
    }
    const keptDraft = await readOnlyComposer.locator("textarea").inputValue().catch(() => null);
    if (keptDraft !== "kept draft") throw new Error(`plain read-only draft-kept assertion failed: expected "kept draft", got ${JSON.stringify(keptDraft)}`);
    await screenshot("connection-lost");
  });
  const retry = page.getByRole("button", { name: "retry now" });
  if (await retry.isVisible().catch(() => false)) await retry.click();
  const restoredStock = page.locator('textarea[aria-label="message"]');
  await restoredStock.waitFor({ state: "visible", timeout: 20_000 });
  if (await restoredStock.inputValue() !== "kept draft") throw new Error("plain reconnect changed the kept draft");
  const pendingApproval = page.locator('[data-part="approval"][data-state="pending"]');
  await pendingApproval.last().waitFor({ state: "visible", timeout: 20_000 });
  await pendingApproval.last().getByRole("button", { name: "deny", exact: true }).click();
  await waitFor(async () =>
    await page.locator('[data-part="composer"][data-state="idle"]').count() === 1 &&
    await page.locator(".run-state").innerText() === "idle", "reconnected turn idle after denial");
  await setVim(true);
  await page.locator('.vim-composer[data-state="idle"]').waitFor({ state: "visible", timeout: 20_000 });
  if (await vimDraft() !== "kept draft") throw new Error("switching to vim changed the reconnected draft");
  await field.focus();
  await field.press("Escape");
  await field.press("i");
  await field.fill("start cursor stream");
  if (await vimDraft() !== "start cursor stream") throw new Error(`vim cursor setup failed: ${JSON.stringify(await vimDraft())}`);
  const cursorDraft = "cursor-stays-here";
  await field.press("Enter");
  await waitFor(async () => {
    const state = await composer.getAttribute("data-state");
    return state === "running" || state === "steerable";
  }, "cursor streaming turn");
  await field.type(cursorDraft, { delay: 35 });
  const cursorValue = await vimDraft();
  const cursorOffset = await field.evaluate((element) => {
    const selection = document.getSelection();
    return selection && element.contains(selection.anchorNode) ? selection.anchorOffset : -1;
  });
  if (cursorValue !== cursorDraft || cursorOffset !== cursorDraft.length)
    throw new Error(`vim cursor changed during streaming: value=${JSON.stringify(cursorValue)} offset=${cursorOffset} expected=${cursorDraft.length}`);
  await setVim(false);
}
