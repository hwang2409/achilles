import type { Page } from "playwright";
import type { GateWait } from "./gate-diagnostics";

type WaitFor = (check: () => Promise<boolean>, label: string) => Promise<void>;

// ⌘K palette and ? sheet: key routing from the composer (vim off and on), Escape layers, focus return
export async function gatePalette(page: Page, chatId: string, waitFor: WaitFor, gateWait: GateWait) {
  const capture = async (name: string) => { if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}` }); };
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 900 });
  const palette = page.getByRole("dialog", { name: "command palette" });
  const sheet = page.getByRole("dialog", { name: "keyboard shortcuts" });
  const settings = page.getByRole("dialog", { name: "settings" });
  const paletteInput = palette.getByRole("combobox");
  const field = page.getByRole("textbox", { name: "message", exact: true });
  const isFocused = async (locator: typeof field) => await locator.count() === 1 && await locator.evaluate((element) => element === document.activeElement);
  const vimDraft = () => page.locator('[data-vim-composer] [data-part="composer-field"]').getAttribute("data-value");
  const runCommand = async (query: string, option: string) => {
    await paletteInput.fill(query);
    await waitFor(async () => {
      const [text, ...extra] = await palette.getByRole("option", { selected: true }).allTextContents();
      return extra.length === 0 && Boolean(text?.startsWith(option));
    }, `palette selects ${option}`).catch(async (error) => {
      throw new Error(`${error}; options=${JSON.stringify(await palette.getByRole("option").evaluateAll(items => items.map(item => [item.textContent, item.getAttribute("aria-selected")])))}`);
    });
    await paletteInput.press("Enter");
    await gateWait.playwright(palette, "waitFor", { state: "hidden", timeout: 10_000 });
  };

  await field.fill("plain draft");
  await field.press("ControlOrMeta+k");
  await gateWait.playwright(palette, "waitFor", { state: "visible", timeout: 10_000 });
  await waitFor(() => isFocused(paletteInput), "palette input focus");
  await waitFor(async () => await palette.getByRole("option").count() > 3, "palette lists commands, pages, chats");
  await capture("palette-open-1440x900.png");
  await paletteInput.press("Escape");
  await gateWait.playwright(palette, "waitFor", { state: "hidden", timeout: 10_000 });
  await waitFor(() => isFocused(field), "escape returns focus to the plain composer");
  if (await field.inputValue() !== "plain draft") throw new Error(`cmd-k changed the plain draft: ${JSON.stringify(await field.inputValue())}`);
  await field.press("?");
  if (await sheet.count()) throw new Error("? in the composer opened the shortcuts sheet");
  if (await field.inputValue() !== "plain draft?") throw new Error("? in the composer was not typed");
  await field.fill("");

  await field.press("ControlOrMeta+k");
  await paletteInput.fill("chat");
  await waitFor(async () => await palette.getByRole("option").filter({ has: page.locator("mark") }).count() > 1, "filtered palette highlights");
  await capture("palette-filtered-1440x900.png");
  await runCommand("toggle vim", "toggle vim mode");
  const composer = page.locator("[data-vim-composer]");
  await gateWait.playwright(composer, "waitFor", { state: "visible", timeout: 20_000 });
  await waitFor(() => isFocused(field), "palette command returns focus to the vim composer");

  await field.pressSequentially("vim draft");
  await field.press("ControlOrMeta+k");
  await gateWait.playwright(palette, "waitFor", { state: "visible", timeout: 10_000 });
  await paletteInput.press("Escape");
  await gateWait.playwright(palette, "waitFor", { state: "hidden", timeout: 10_000 });
  await waitFor(() => isFocused(field), "escape returns focus to the vim INSERT composer");
  if (await composer.getAttribute("data-mode") !== "insert") throw new Error("palette escape changed the vim mode");
  await field.press("Escape");
  await waitFor(async () => await composer.getAttribute("data-mode") === "normal", "vim NORMAL");
  await field.press("ControlOrMeta+k");
  await gateWait.playwright(palette, "waitFor", { state: "visible", timeout: 10_000 });
  await paletteInput.press("Escape");
  await gateWait.playwright(palette, "waitFor", { state: "hidden", timeout: 10_000 });
  await waitFor(() => isFocused(field), "escape returns focus to the vim NORMAL composer");
  if (await composer.getAttribute("data-mode") !== "normal") throw new Error("palette escape left vim NORMAL");
  if (await vimDraft() !== "vim draft") throw new Error(`cmd-k changed the vim draft: ${JSON.stringify(await vimDraft())}`);
  await field.press("Escape");
  await waitFor(async () => !(await isFocused(field)), "esc in NORMAL leaves the composer");

  const settingsKey = () => page.keyboard.press("ControlOrMeta+Comma");
  const prepareSettings = async () => {
    await settingsKey();
    await settings.waitFor({ timeout: 5_000 });
    await waitFor(() => settings.evaluate(dialog => dialog.contains(document.activeElement)), "settings ready for layered shortcut");
  };
  const paletteKey = () => page.keyboard.press("ControlOrMeta+k");
  const paletteButton = page.getByRole("button", { name: "command palette", exact: true });
  const paletteCommand = (name: string) => async () => { await paletteKey(); await runCommand(name, name); };
  const closeButton = sheet.getByRole("button", { name: "esc", exact: true });
  const cases = [
    { name: "question mark", act: () => page.keyboard.press("?"), top: sheet, focus: closeButton },
    { name: "settings shortcut", act: settingsKey, top: settings },
    { name: "palette shortcut", act: paletteKey, top: palette, focus: paletteInput },
    { name: "palette button", act: () => paletteButton.click(), top: palette, focus: paletteInput },
    { name: "palette settings command", act: paletteCommand("display settings"), top: settings },
    { name: "settings shortcut over palette", prepare: paletteKey, act: settingsKey, top: settings },
    { name: "palette while settings closes", prepare: prepareSettings, act: async () => { await page.keyboard.press("Escape"); await paletteKey(); }, top: palette, focus: paletteInput },
    { name: "reopen closing settings", prepare: prepareSettings, act: async () => {
      // Dispatch both events in the same browser turn, before close autofocus can run.
      await settings.evaluate(dialog => {
        const control = dialog.querySelector("button")!;
        control.focus();
        control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        control.dispatchEvent(new KeyboardEvent("keydown", { key: ",", bubbles: true, metaKey: navigator.platform.includes("Mac"), ctrlKey: !navigator.platform.includes("Mac") }));
      });
    }, top: settings },
    { name: "return to settings below shortcuts and palette", prepare: async () => {
      await prepareSettings();
      await paletteCommand("keyboard shortcuts")();
      await closeButton.waitFor();
    }, act: async () => {
      await paletteCommand("display settings")();
      await palette.waitFor({ state: "hidden", timeout: 5_000 });
      await sheet.waitFor({ state: "hidden", timeout: 5_000 });
    }, top: settings },
    { name: "palette over settings", prepare: prepareSettings, act: paletteKey, top: palette, focus: paletteInput, underlying: settings },
    { name: "palette shortcuts command", act: paletteCommand("keyboard shortcuts"), top: sheet, focus: closeButton },
    { name: "palette shortcuts over settings", prepare: prepareSettings, act: paletteCommand("keyboard shortcuts"), top: sheet, focus: closeButton, underlying: settings },
  ];
  for (const { name, prepare, act, top, focus, underlying } of cases) {
    await page.locator("main[data-main-pane]").focus();
    await prepare?.();
    await act();
    await top.waitFor({ state: "visible", timeout: 5_000 });
    if (await top.getAttribute("data-state") !== "open") throw new Error(`${name}: top overlay is closing`);
    await waitFor(() => focus ? isFocused(focus) : top.evaluate(dialog => dialog.contains(document.activeElement)), `${name} moved focus into the top overlay`);
    if (name === "question mark") await capture("shortcuts-sheet-1440x900.png");
    await page.keyboard.press("Escape");
    await top.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => { throw new Error(`${name}: Escape left the top overlay open`); });
    if (underlying) {
      await waitFor(() => underlying.isVisible(), `${name}: underlying settings stayed open after Escape`);
      await page.keyboard.press("Escape");
      await underlying.waitFor({ state: "hidden", timeout: 5_000 });
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("ControlOrMeta+k");
  await gateWait.playwright(palette, "waitFor", { state: "visible", timeout: 10_000 });
  await capture("palette-open-390x844.png");
  await paletteInput.fill("chat");
  await waitFor(async () => await palette.getByRole("option").filter({ has: page.locator("mark") }).count() > 1, "narrow filtered palette");
  await capture("palette-filtered-390x844.png");
  const width = await palette.evaluate((element) => element.getBoundingClientRect().width);
  if (Math.abs(width - 390) > 1) throw new Error(`narrow palette is ${width}px wide, not full width`);
  await page.keyboard.press("Escape");
  await gateWait.playwright(palette, "waitFor", { state: "hidden", timeout: 10_000 });
  await page.keyboard.press("?");
  await gateWait.playwright(sheet, "waitFor", { state: "visible", timeout: 10_000 });
  await capture("shortcuts-sheet-390x844.png");
  await page.keyboard.press("Escape");
  await gateWait.playwright(sheet, "waitFor", { state: "hidden", timeout: 10_000 });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.keyboard.press("ControlOrMeta+k");
  await gateWait.playwright(palette, "waitFor", { state: "visible", timeout: 10_000 });
  const otherPage = await palette.getByRole("group", { name: "pages" }).getByRole("option").evaluateAll((options) => options.find((option) => option.querySelector("small")?.textContent !== "/")?.querySelector("span")?.textContent);
  if (!otherPage) throw new Error("no second page in the palette");
  await runCommand(otherPage, otherPage);
  await waitFor(async () => new URL(page.url()).pathname !== "/" && await page.getByRole("textbox", { name: "message", exact: true }).count() === 1, `palette goes to page ${otherPage}`);
  await page.keyboard.press("ControlOrMeta+k");
  await paletteInput.fill("prove chat");
  await palette.getByRole("option", { name: /^prove chat/, selected: true }).waitFor({ timeout: 5_000 });
  await paletteInput.fill("no matching chat fixture");
  await paletteInput.press("Enter");
  if (!await palette.isVisible() || new URL(page.url()).searchParams.get("chat") === chatId) throw new Error("Enter opened a stale chat result");
  await runCommand("prove chat", "prove chat");
  await waitFor(async () => await page.locator("[data-session-id]").getAttribute("data-session-id") === chatId, "palette opens a chat");
  await page.keyboard.press("ControlOrMeta+k");
  await runCommand("toggle vim", "toggle vim mode");
  await gateWait.playwright(page.locator("[data-vim-composer]"), "waitFor", { state: "detached", timeout: 20_000 });
  if (viewport) await page.setViewportSize(viewport);
}
