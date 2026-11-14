import type { Page } from "playwright";

const theme = (page: Page) => page.locator("html").getAttribute("data-fulcrum-theme");
const openSettings = async (page: Page) => {
  await page.keyboard.press("Control+Comma");
  await page.getByRole("dialog", { name: "settings" }).waitFor({ state: "visible" });
};

export async function gateSettings(page: Page, origin: string): Promise<void> {
  const screenshots = process.env.SETTINGS_SCREENSHOT_DIR ?? process.env.SCREENSHOT_DIR;
  await page.setViewportSize({ width: 1440, height: 900 });
  if (screenshots) await page.screenshot({ path: `${screenshots}/default.png` });
  await openSettings(page);
  const unnamedControls = await page.getByRole("dialog", { name: "settings" }).locator("button, input, select, textarea").evaluateAll((controls) => controls.filter((control) => !(control.getAttribute("aria-label") || control.getAttribute("aria-labelledby") || control.textContent?.trim())).map((control) => control.outerHTML));
  if (unnamedControls.length) throw new Error(`settings controls have no accessible name: ${unnamedControls.join(", ")}`);
  await page.getByRole("switch", { name: "vim mode" }).waitFor();
  await page.getByRole("switch", { name: "auto-approve default" }).waitFor();
  const switchSizes = await page.getByRole("switch").evaluateAll((switches) => switches.map((control) => ({ width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height })));
  if (switchSizes.some(({ width, height }) => width !== 38 || height < 24)) throw new Error(`settings switches have the wrong target size: ${JSON.stringify(switchSizes)}`);
  if (screenshots) await page.screenshot({ path: `${screenshots}/04-settings-dialog.png` });
  await page.getByRole("option", { name: /gruvbox-light/ }).click();
  await page.getByRole("button", { name: "IBM Plex Sans" }).click();
  if (await theme(page) !== "gruvbox-light") throw new Error("gruvbox-light did not apply live");
  await page.getByRole("button", { name: "esc" }).click();
  if (screenshots) await page.screenshot({ path: `${screenshots}/12-gruvbox-light-plex-sans.png` });

  await page.reload();
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });
  if (await theme(page) !== "gruvbox-light") throw new Error("stored theme did not survive reload");
  const uiFont = await page.locator("html").evaluate((node) => getComputedStyle(node).getPropertyValue("--achilles-ui-font"));
  if (!uiFont.includes("IBM Plex Sans")) throw new Error("stored UI font did not survive reload");

  await page.goto(`${origin}/allow?theme=dracula`);
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });
  if (await theme(page) !== "dracula") throw new Error("query theme did not override stored theme");

  await page.goto(`${origin}/allow`);
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });
  await openSettings(page);
  await page.getByRole("button", { name: "reset to defaults" }).click();
  if (await theme(page) !== null) throw new Error("reset did not restore the automatic theme");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("achilles-settings") ?? "null"));
  if (saved?.theme !== "auto" || saved?.autoApproveDefault !== true) throw new Error(`reset saved the wrong defaults: ${JSON.stringify(saved)}`);
  await page.getByRole("button", { name: "esc" }).click();

  const composer = page.getByRole("textbox", { name: "message" });
  await composer.focus();
  await openSettings(page);
  await page.keyboard.press("Escape");
  if (!await composer.evaluate((node) => node === document.activeElement)) throw new Error("desktop settings escape did not restore opener focus");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector(".sidebar")?.getAttribute("aria-hidden") === "true");
  const menuButton = page.getByRole("button", { name: "open menu" });
  await menuButton.click();
  const settingsButton = page.locator("aside.sidebar").getByRole("button", { name: /settings/ });
  await settingsButton.click();
  const narrowDialog = page.getByRole("dialog", { name: "settings" });
  if (await narrowDialog.count() !== 1) throw new Error("narrow settings button did not expose a named dialog");
  const narrowTargets = await narrowDialog.locator("button").evaluateAll((controls) => controls.map((control) => ({ width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height })));
  if (narrowTargets.some(({ width, height }) => width < 40 || height < 40)) throw new Error(`narrow settings target is smaller than 40px: ${JSON.stringify(narrowTargets)}`);
  if (screenshots) await page.screenshot({ path: `${screenshots}/settings-narrow-390x844.png` });
  const enabledControls = narrowDialog.locator("button:not(:disabled):not([tabindex='-1']), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])");
  const firstControl = enabledControls.first();
  const lastControl = enabledControls.last();
  await firstControl.focus();
  await page.keyboard.press("Shift+Tab");
  if (!await lastControl.evaluate((node) => node === document.activeElement)) throw new Error("settings focus did not wrap backward to the last enabled control");
  await page.keyboard.press("Tab");
  if (!await firstControl.evaluate((node) => node === document.activeElement && document.activeElement !== document.body)) throw new Error("settings focus did not wrap forward to the first enabled control");
  await page.keyboard.press("Escape");
  if (await narrowDialog.isVisible()) throw new Error("narrow settings escape did not close the dialog");
  if (await page.locator("aside.sidebar").getAttribute("aria-hidden") === "true") throw new Error("settings escape closed the drawer before the dialog");
  if (!await settingsButton.evaluate((node) => node === document.activeElement)) throw new Error("narrow settings escape did not restore opener focus");
  await page.keyboard.press("Escape");
  if (await page.locator("aside.sidebar").getAttribute("aria-hidden") !== "true") throw new Error("second escape did not close the drawer");
  if (!await menuButton.evaluate((node) => node === document.activeElement)) throw new Error("drawer escape did not restore menu focus");
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("settings gate passed: live theme, persistence, query override, reset, layered escape, and focus return");
}

type Frame = { method?: string; params?: { session_id?: string }; id?: unknown; result?: { approval_mode?: string } };
type ApprovalModeResponse = (method: "session_settings" | "set_settings", sessionId: string) => string | undefined;

const sessionId = (page: Page) => page.locator("[data-session-id]").getAttribute("data-session-id");
const settingsWrites = (frames: Frame[], id: string) => frames.filter((frame) => frame.method === "set_settings" && frame.params?.session_id === id).length;

export async function assertServerAskWins(page: Page, id: string, frames: Frame[], approvalModeResponse: ApprovalModeResponse): Promise<void> {
  if (approvalModeResponse("session_settings", id) !== "ask") throw new Error("server-forced ask session did not report ask settings");
  if (settingsWrites(frames, id)) throw new Error("server-forced ask session sent a no-op set_settings frame");
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("server-forced ask session showed the auto-approve marker");
}

export async function gateCreationApprovalDefaults(page: Page, frames: () => Frame[], approvalModeResponse: ApprovalModeResponse): Promise<void> {
  const initial = await sessionId(page);
  await page.getByRole("button", { name: "new chat" }).click();
  await page.waitForFunction((previous) => document.querySelector("[data-session-id]")?.getAttribute("data-session-id") !== previous, initial);
  const allowId = await sessionId(page);
  if (!allowId || approvalModeResponse("set_settings", allowId) !== "allow") throw new Error("default-on new chat did not use allow mode");
  await page.getByLabel("auto-approve", { exact: true }).waitFor({ state: "visible" });

  await openSettings(page);
  const approvalDefault = page.getByRole("switch", { name: "auto-approve default" });
  if (await approvalDefault.getAttribute("aria-checked") !== "true") throw new Error("auto-approve default was not on after reset");
  await approvalDefault.click();
  await page.getByRole("button", { name: "esc" }).click();

  await page.getByRole("button", { name: "new chat" }).click();
  await page.waitForFunction((previous) => document.querySelector("[data-session-id]")?.getAttribute("data-session-id") !== previous, allowId);
  const askId = await sessionId(page);
  if (!askId || approvalModeResponse("session_settings", askId) !== "ask") throw new Error("default-off new chat did not use ask mode");
  if (settingsWrites(frames(), askId)) throw new Error("default-off new chat sent a set_settings frame");
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("default-off new chat showed the auto-approve marker");

  await openSettings(page);
  await page.getByRole("switch", { name: "auto-approve default" }).click();
  await page.getByRole("button", { name: "esc" }).click();
  const writesBeforeReopen = settingsWrites(frames(), askId);
  await page.reload();
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });
  if (await sessionId(page) !== askId) throw new Error("reopening after changing the default changed the chat id");
  if (approvalModeResponse("session_settings", askId) !== "ask") throw new Error("reopening after changing the default changed ask mode");
  if (settingsWrites(frames(), askId) !== writesBeforeReopen) throw new Error("reopening after changing the default sent set_settings");
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("reopened ask chat showed the auto-approve marker");
  console.log("settings approval gate passed: default allow, default ask, and reopen preservation");
}
