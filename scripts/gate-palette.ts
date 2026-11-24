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
  const vimDraft = () => page.locator('.vim-composer [data-part="composer-field"]').getAttribute("data-value");
  const runCommand = async (query: string, option: string) => {
    await paletteInput.fill(query);
    await waitFor(async () => (await palette.getByRole("option", { selected: true }).innerText()).startsWith(option), `palette selects ${option}`);
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
  const composer = page.locator(".vim-composer");
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

  await page.keyboard.press("?");
  await gateWait.playwright(sheet, "waitFor", { state: "visible", timeout: 10_000 });
  await capture("shortcuts-sheet-1440x900.png");
  await page.keyboard.press("Escape");
  await gateWait.playwright(sheet, "waitFor", { state: "hidden", timeout: 10_000 });

  await page.keyboard.press("ControlOrMeta+k");
  await runCommand("display settings", "display settings");
  await gateWait.playwright(settings, "waitFor", { state: "visible", timeout: 10_000 });
  await page.keyboard.press("ControlOrMeta+k");
  await runCommand("keyboard shortcuts", "keyboard shortcuts");
  await gateWait.playwright(sheet, "waitFor", { state: "visible", timeout: 10_000 });
  await page.keyboard.press("Escape");
  await gateWait.playwright(sheet, "waitFor", { state: "hidden", timeout: 10_000 });
  if (!(await settings.isVisible())) throw new Error("escape closed settings under the shortcuts sheet");
  await page.keyboard.press("Escape");
  await gateWait.playwright(settings, "waitFor", { state: "hidden", timeout: 10_000 });

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
  const otherPage = await palette.getByRole("group", { name: "pages" }).getByRole("option").evaluateAll((options) => options.find((option) => option.querySelector("small")?.textContent !== "/")?.querySelector("span")?.textContent);
  if (!otherPage) throw new Error("no second page in the palette");
  await runCommand(otherPage, otherPage);
  await waitFor(async () => new URL(page.url()).pathname !== "/" && await page.getByRole("textbox", { name: "message", exact: true }).count() === 1, `palette goes to page ${otherPage}`);
  await page.keyboard.press("ControlOrMeta+k");
  await runCommand("prove chat", "prove chat");
  await waitFor(async () => await page.locator("[data-session-id]").getAttribute("data-session-id") === chatId, "palette opens a chat");
  await page.keyboard.press("ControlOrMeta+k");
  await runCommand("toggle vim", "toggle vim mode");
  await gateWait.playwright(page.locator(".vim-composer"), "waitFor", { state: "detached", timeout: 20_000 });
  if (viewport) await page.setViewportSize(viewport);
}
