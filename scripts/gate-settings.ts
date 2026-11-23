import type { Page } from "playwright";
import { focusable } from "../apps/web/src/focusable";
import { appShortcut, type GateWait } from "./gate-diagnostics";

const theme = (page: Page) => page.locator("html").getAttribute("data-achilles-theme");
const openSettings = async (page: Page, gateWait: GateWait) => {
  await page.keyboard.press(appShortcut("Comma"));
  await gateWait.playwright(page.getByRole("dialog", { name: "settings" }), "waitFor", { state: "visible" });
};

export async function gateSettings(page: Page, origin: string, gateWait: GateWait): Promise<void> {
  const screenshots = process.env.SETTINGS_SCREENSHOT_DIR ?? process.env.SCREENSHOT_DIR;
  await page.setViewportSize({ width: 1440, height: 900 });
  const assertAppearance = async (scheme: "light" | "dark") => {
    const appearance = await page.locator("html").evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        scheme: style.colorScheme,
        background: style.backgroundColor,
        syntax: style.getPropertyValue("--fulcrum-tok-function").trim(),
        ansi: style.getPropertyValue("--fulcrum-ansi-blue").trim(),
      };
    });
    const background = scheme === "light" ? "rgb(255, 255, 255)" : "rgb(11, 11, 13)";
    if (appearance.scheme !== scheme || appearance.background !== background || !appearance.syntax || !appearance.ansi)
      throw new Error(`wrong ${scheme} appearance: ${JSON.stringify(appearance)}`);
  };
  const fresh = await page.locator("html").evaluate((node) => {
    const style = getComputedStyle(node);
    return { ui: style.fontFamily, mono: style.getPropertyValue("--achilles-code-font"), size: style.fontSize };
  });
  if (!fresh.ui.includes("BlinkMacSystemFont") || fresh.mono.trim() !== 'ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace' || fresh.size !== "15px")
    throw new Error(`wrong fresh typography: ${JSON.stringify(fresh)}`);
  const jetBrainsFaces = () => page.evaluate(() => [...document.fonts].filter(face => face.family.includes("JetBrains Mono")).length);
  if (await jetBrainsFaces()) throw new Error("JetBrains Mono was registered with default settings");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await assertAppearance(colorScheme);
  }
  if (screenshots) await page.screenshot({ path: `${screenshots}/default.png` });
  await openSettings(page, gateWait);
  const unnamedControls = await page.getByRole("dialog", { name: "settings" }).locator("button, input, select, textarea").evaluateAll((controls) => controls.filter((control) => !(control.getAttribute("aria-label") || control.getAttribute("aria-labelledby") || control.textContent?.trim())).map((control) => control.outerHTML));
  if (unnamedControls.length) throw new Error(`settings controls have no accessible name: ${unnamedControls.join(", ")}`);
  await gateWait.playwright(page.getByRole("switch", { name: "vim mode" }), "waitFor");
  await gateWait.playwright(page.getByRole("switch", { name: "auto-approve default" }), "waitFor");
  const switchSizes = await page.getByRole("switch").evaluateAll((switches) => switches.map((control) => ({ width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height })));
  if (switchSizes.some(({ width, height }) => width !== 38 || height < 24)) throw new Error(`settings switches have the wrong target size: ${JSON.stringify(switchSizes)}`);
  if (screenshots) await page.screenshot({ path: `${screenshots}/04-settings-dialog.png` });
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "IBM Plex Sans" }).click();
  await page.getByRole("button", { name: "JetBrains Mono", exact: true }).last().click();
  const checkSavedMono = async () => {
    await page.waitForFunction(() => [...document.fonts].some(face => face.family.includes("JetBrains Mono")));
    const loaded = await page.evaluate(async () => {
      const faces = await document.fonts.load('14px "JetBrains Mono"', "text");
      return faces.some(face => face.status === "loaded") && getComputedStyle(document.documentElement).getPropertyValue("--achilles-code-font").includes("JetBrains Mono");
    });
    if (!loaded) throw new Error("saved JetBrains Mono did not load and apply");
  };
  await checkSavedMono();
  if (await theme(page) !== "g1-light") throw new Error("g1-light did not apply live");
  await assertAppearance("light");
  await page.getByRole("button", { name: "esc" }).click();
  if (screenshots) await page.screenshot({ path: `${screenshots}/12-g1-light-plex-sans.png` });

  await page.reload();
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });
  if (await theme(page) !== "g1-light") throw new Error("stored theme did not survive reload");
  const uiFont = await page.locator("html").evaluate((node) => getComputedStyle(node).getPropertyValue("--achilles-ui-font"));
  if (!uiFont.includes("IBM Plex Sans")) throw new Error("stored UI font did not survive reload");
  await checkSavedMono();

  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${origin}/allow?theme=g1-dark`);
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });
  if (await theme(page) !== "g1-dark") throw new Error("query theme did not override stored theme");
  await assertAppearance("dark");
  await page.emulateMedia({ colorScheme: null });

  await page.goto(`${origin}/allow`);
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });
  await openSettings(page, gateWait);
  // reset keeps auto-approve as it is: off stays off, on stays on
  const settingsDialog = page.getByRole("dialog", { name: "settings" });
  await gateWait.playwright(settingsDialog.getByText("auto-approve is not reset."), "waitFor");
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? document.activeElement?.tagName);
  const resetKeeps = async (autoApproveDefault: boolean) => {
    await page.getByRole("button", { name: "reset to defaults" }).click();
    if (await theme(page) !== null) throw new Error("reset did not restore the automatic theme");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("achilles-settings") ?? "null"));
    if (saved?.theme !== "auto" || saved.uiFont !== "system" || saved.codeFont !== "system-mono" || saved.size !== 15 || saved.autoApproveDefault !== autoApproveDefault) throw new Error(`reset saved the wrong defaults: ${JSON.stringify(saved)}`);
    if (await focused() !== "reset to defaults") throw new Error(`reset dropped focus to ${await focused()}`);
  };
  await page.getByRole("switch", { name: "auto-approve default" }).click();
  if (await focused() !== "auto-approve default") throw new Error(`turning auto-approve off dropped focus to ${await focused()}`);
  await resetKeeps(false);
  await page.getByRole("switch", { name: "auto-approve default" }).click();
  await settingsDialog.getByRole("group").getByRole("button", { name: "allow without asking" }).click();
  if (await focused() !== "auto-approve default") throw new Error(`confirming auto-approve dropped focus to ${await focused()}`);
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await resetKeeps(true);
  await page.getByRole("button", { name: "esc" }).click();
  await page.keyboard.press(appShortcut("Comma"));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const desktopDialog = page.getByRole("dialog", { name: "settings", exact: true });
  const roleDialogs = await desktopDialog.evaluateAll((dialogs) => dialogs.map((dialog) => {
    const labelledBy = dialog.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ") ?? null;
    return { tagName: dialog.tagName, ariaLabel: dialog.getAttribute("aria-label"), labelledBy, open: dialog instanceof HTMLDialogElement ? dialog.open : null, hidden: dialog.hidden || dialog.getAttribute("aria-hidden"), outerHTML: dialog.outerHTML.slice(0, 150) };
  }));
  const domDialogs = await page.locator("dialog.settings-dialog").evaluateAll((dialogs) => dialogs.map((dialog) => ({ open: (dialog as HTMLDialogElement).open, hidden: dialog.hidden || dialog.getAttribute("aria-hidden"), outerHTML: dialog.outerHTML.slice(0, 150) })));
  if (roleDialogs.length !== 1 || domDialogs.length !== 1 || !domDialogs[0]?.open) throw new Error(`open while settings was closing left the wrong dialog state: role count=${roleDialogs.length} matches=${JSON.stringify(roleDialogs)} dom=${JSON.stringify(domDialogs)}`);
  await page.keyboard.press("Escape");
  await gateWait.playwright(desktopDialog, "waitFor", { state: "hidden" });

  const composer = page.getByRole("textbox", { name: "message" });
  await composer.focus();
  await openSettings(page, gateWait);
  await page.keyboard.press("Escape");
  await gateWait.playwright(page, "waitForFunction", () => document.activeElement?.getAttribute("aria-label") === "message").catch(() => { throw new Error("desktop settings escape did not restore opener focus"); });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  await gateWait.playwright(page, "waitForFunction", () => document.activeElement === document.body, undefined, { timeout: 2_000 }).catch(async () => {
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      return { tagName: element?.tagName ?? null, ariaLabel: element?.getAttribute("aria-label") ?? null };
    });
    throw new Error(`could not move focus to body: focused ${focused.tagName ?? "none"}${focused.ariaLabel ? ` (${focused.ariaLabel})` : ""}`);
  });
  await openSettings(page, gateWait);
  await page.keyboard.press("Escape");
  await gateWait.playwright(page, "waitForFunction", () => document.activeElement?.getAttribute("aria-label") === "message").catch(() => { throw new Error("body-opened settings escape did not focus the composer"); });

  await page.setViewportSize({ width: 390, height: 844 });
  await gateWait.playwright(page, "waitForFunction", () => document.querySelector(".sidebar")?.getAttribute("aria-hidden") === "true");
  const menuButton = page.getByRole("button", { name: "open menu" });
  await menuButton.click();
  const settingsLink = page.getByRole("navigation", { name: "places" }).getByRole("link", { name: "settings", exact: true });
  await settingsLink.focus();
  await openSettings(page, gateWait);
  const narrowDialog = page.getByRole("dialog", { name: "settings" });
  if (await narrowDialog.count() !== 1) throw new Error("narrow settings button did not expose a named dialog");
  const narrowTargets = await narrowDialog.locator("button").evaluateAll((controls) => controls.map((control) => ({ width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height })));
  if (narrowTargets.some(({ width, height }) => width < 44 || height < 44)) throw new Error(`narrow settings target is smaller than 44px: ${JSON.stringify(narrowTargets)}`);
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
  await gateWait.playwright(page, "waitForFunction", () => document.activeElement?.getAttribute("href")?.startsWith("/settings")).catch(() => { throw new Error("narrow settings escape did not restore opener focus"); });
  await page.keyboard.press("Escape");
  if (await page.locator("aside.sidebar").getAttribute("aria-hidden") !== "true") throw new Error("second escape did not close the drawer");
  await gateWait.playwright(page, "waitForFunction", () => document.activeElement?.getAttribute("aria-label") === "open menu").catch(() => { throw new Error("drawer escape did not restore menu focus"); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/allow`);
  const menu = page.getByRole("button", { name: "open menu" });
  await menu.click();
  await page.getByRole("button", { name: "close menu" }).click({ position: { x: 370, y: 400 } });
  await gateWait.playwright(page, "waitForFunction", () => document.activeElement?.getAttribute("aria-label") === "open menu");
  await menu.click();
  const sidebar = page.locator(".sidebar");
  // hold the drawer at the first frame of its slide-in, so Tab is pressed while the drawer is still off screen.
  await sidebar.evaluate((element) => Promise.all(element.getAnimations().map(async (animation) => { animation.pause(); await animation.ready; animation.currentTime = 0; })));
  await gateWait.playwright(page, "waitForFunction", () => document.querySelector(".sidebar")?.contains(document.activeElement)).catch(() => { throw new Error("opening the drawer did not move focus into it"); });
  const first = await page.evaluateHandle(() => document.activeElement);
  const last = await sidebar.evaluateHandle((element, selector) => Array.from(element.querySelectorAll<HTMLElement>(selector)).filter((control) => control.tabIndex >= 0 && control.checkVisibility({ visibilityProperty: true })).at(-1)!, focusable);
  await last.focus();
  await page.keyboard.press("Tab");
  if (!await first.evaluate((node) => node === document.activeElement)) throw new Error("drawer Tab from the last control escaped the sidebar (last control)");
  await page.keyboard.press("Shift+Tab");
  if (!await last.evaluate((node) => node === document.activeElement)) throw new Error("drawer reverse Tab did not wrap to the last control");
  await sidebar.evaluate((element) => element.getAnimations().forEach((animation) => animation.finish()));
  await openSettings(page, gateWait);
  const drawerSettings = page.getByRole("dialog", { name: "settings" });
  await gateWait.playwright(drawerSettings, "waitFor", { state: "visible" });
  const drawerSettingsInitial = drawerSettings.locator("button:not(:disabled):not([tabindex='-1']), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])").first();
  await drawerSettingsInitial.focus();
  await drawerSettingsInitial.evaluate((node) => { if (document.activeElement !== node) throw new Error("settings initial focus was not stable"); });
  const drawerSettingsBeforeTabHandle = await page.evaluateHandle(() => document.activeElement);
  const drawerSettingsBeforeTab = await page.evaluate(() => ({ name: document.activeElement?.getAttribute("aria-label"), id: document.activeElement?.id, outerHTML: document.activeElement?.outerHTML }));
  await page.keyboard.press("Tab");
  const drawerSettingsAfterTab = await page.evaluate(() => ({ name: document.activeElement?.getAttribute("aria-label"), id: document.activeElement?.id, outerHTML: document.activeElement?.outerHTML }));
  const drawerSettingsInsideAfterTab = await drawerSettings.evaluate((dialog) => dialog.contains(document.activeElement));
  if (!drawerSettingsInsideAfterTab) throw new Error(`native settings Tab did not advance inside the open drawer: before=${JSON.stringify(drawerSettingsBeforeTab)} active=${JSON.stringify(drawerSettingsAfterTab)}`);
  if (await drawerSettingsBeforeTabHandle.evaluate((node) => node === document.activeElement)) throw new Error(`native settings focus did not advance in the open drawer: before=${JSON.stringify(drawerSettingsBeforeTab)} active=${JSON.stringify(drawerSettingsAfterTab)}`);
  const drawerSettingsAfterTabHandle = await page.evaluateHandle(() => document.activeElement);
  await page.keyboard.press("Shift+Tab");
  const drawerSettingsAfterShiftTab = await page.evaluate(() => ({ name: document.activeElement?.getAttribute("aria-label"), id: document.activeElement?.id, outerHTML: document.activeElement?.outerHTML }));
  if (!await drawerSettings.evaluate((dialog) => dialog.contains(document.activeElement)) || await drawerSettingsAfterTabHandle.evaluate((node) => node === document.activeElement)) throw new Error(`native settings reverse Tab did not advance inside the open drawer: before=${JSON.stringify(drawerSettingsBeforeTab)} afterTab=${JSON.stringify(drawerSettingsAfterTab)} active=${JSON.stringify(drawerSettingsAfterShiftTab)}`);
  await page.keyboard.press("Escape");
  await gateWait.playwright(drawerSettings, "waitFor", { state: "hidden" });
  await last.focus();
  await page.keyboard.press("Tab");
  if (!await first.evaluate((node) => node === document.activeElement)) throw new Error("drawer focus trap did not resume after native settings closed");
  await sidebar.evaluate((element) => element.getAnimations().forEach((animation) => animation.finish()));
  if (screenshots) await page.screenshot({ path: `${screenshots}/drawer-focus.png` });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("settings gate passed: live theme, persistence, query override, reset, layered escape, focus return, and drawer focus wrap");
}

type Frame = { method?: string; params?: { session_id?: string }; id?: unknown; result?: { approval_mode?: string } };
type ApprovalMethod = "session_settings" | "set_settings";
// one waiting owner for every approval-mode reply read: the client re-fetches session_settings on each
// resume/reload/restart, so the newest request's reply can still be in flight. callers wait, bounded, for
// the newest reply and assert it, so a wrong reply fails at once and a missing reply fails at the bound.
export type AwaitApprovalMode = (method: ApprovalMethod, sessionId: string, expected: string, label: string) => Promise<void>;

const sessionId = (page: Page) => page.locator("[data-session-id]").getAttribute("data-session-id");
const settingsWrites = (frames: Frame[], id: string) => frames.filter((frame) => frame.method === "set_settings" && frame.params?.session_id === id).length;

type WaitFor = (check: () => Promise<boolean>, label: string) => Promise<void>;

export function approvalModeWaiter(frames: () => Frame[], waitFor: WaitFor): AwaitApprovalMode {
  // the newest matching request's reply, or undefined while that reply is still in flight
  const approvalModeResponse = (method: ApprovalMethod, sessionId: string): string | undefined => {
    const messages = frames();
    const request = messages.findLast((frame) => frame.method === method && frame.params?.session_id === sessionId);
    if (!request) return undefined;
    return messages.slice(messages.indexOf(request) + 1).find((frame) => frame.id === request.id && frame.result)?.result?.approval_mode;
  };
  return async (method, sessionId, expected, label) => {
    await waitFor(async () => approvalModeResponse(method, sessionId) !== undefined, `${label} (${method} reply)`);
    const mode = approvalModeResponse(method, sessionId);
    if (mode !== expected) throw new Error(`${label}: expected ${method} approval_mode "${expected}", got "${mode ?? "none"}"`);
  };
}

export async function assertServerAskWins(page: Page, id: string, frames: () => Frame[], awaitApprovalMode: AwaitApprovalMode): Promise<void> {
  await awaitApprovalMode("session_settings", id, "ask", "server-forced ask session");
  if (settingsWrites(frames(), id)) throw new Error("server-forced ask session sent a no-op set_settings frame");
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("server-forced ask session showed the auto-approve marker");
}

export async function gateCreationApprovalDefaults(page: Page, frames: () => Frame[], awaitApprovalMode: AwaitApprovalMode, gateWait: GateWait): Promise<void> {
  const initial = await sessionId(page);
  await page.locator("button.new-chat").click();
  await gateWait.playwright(page, "waitForFunction", (previous) => document.querySelector("[data-session-id]")?.getAttribute("data-session-id") !== previous, initial);
  const allowId = await sessionId(page);
  if (!allowId) throw new Error("default-on new chat did not expose a session id");
  await awaitApprovalMode("set_settings", allowId, "allow", "default-on new chat");
  await gateWait.playwright(page.getByLabel("auto-approve", { exact: true }), "waitFor", { state: "visible" });

  await openSettings(page, gateWait);
  const approvalDefault = page.getByRole("switch", { name: "auto-approve default" });
  if (await approvalDefault.getAttribute("aria-checked") !== "true") throw new Error("auto-approve default was not on after reset");
  await approvalDefault.click();
  await page.getByRole("button", { name: "esc" }).click();

  await page.locator("button.new-chat").click();
  await gateWait.playwright(page, "waitForFunction", (previous) => document.querySelector("[data-session-id]")?.getAttribute("data-session-id") !== previous, allowId);
  const askId = await sessionId(page);
  if (!askId) throw new Error("default-off new chat did not expose a session id");
  await awaitApprovalMode("session_settings", askId, "ask", "default-off new chat");
  if (settingsWrites(frames(), askId)) throw new Error("default-off new chat sent a set_settings frame");
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("default-off new chat showed the auto-approve marker");

  await openSettings(page, gateWait);
  // turning the default on goes through a confirm
  const settingsDialog = page.getByRole("dialog", { name: "settings" });
  await page.getByRole("switch", { name: "auto-approve default" }).click();
  await settingsDialog.getByRole("group").getByRole("button", { name: "allow without asking" }).click();
  await gateWait.playwright(page.locator('[role="switch"][aria-label="auto-approve default"][aria-checked="true"]'), "waitFor");
  await page.getByRole("button", { name: "esc" }).click();
  const writesBeforeReopen = settingsWrites(frames(), askId);
  await page.reload();
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });
  if (await sessionId(page) !== askId) throw new Error("reopening after changing the default changed the chat id");
  await awaitApprovalMode("session_settings", askId, "ask", "reopened default-off chat");
  if (settingsWrites(frames(), askId) !== writesBeforeReopen) throw new Error("reopening after changing the default sent set_settings");
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("reopened ask chat showed the auto-approve marker");
  console.log("settings approval gate passed: default allow, default ask, and reopen preservation");
}
