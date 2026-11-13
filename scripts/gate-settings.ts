import type { Page } from "playwright";

const theme = (page: Page) => page.locator("html").getAttribute("data-fulcrum-theme");
const openSettings = async (page: Page) => {
  await page.keyboard.press("Control+Comma");
  await page.getByRole("dialog", { name: "settings" }).waitFor({ state: "visible" });
};

export async function gateSettings(page: Page, origin: string): Promise<void> {
  const screenshots = process.env.SETTINGS_SCREENSHOT_DIR;
  await page.setViewportSize({ width: 1440, height: 900 });
  if (screenshots) await page.screenshot({ path: `${screenshots}/default.png` });
  await openSettings(page);
  const unnamedControls = await page.getByRole("dialog", { name: "settings" }).locator("button, input, select, textarea").evaluateAll((controls) => controls.filter((control) => !(control.getAttribute("aria-label") || control.getAttribute("aria-labelledby") || control.textContent?.trim())).map((control) => control.outerHTML));
  if (unnamedControls.length) throw new Error(`settings controls have no accessible name: ${unnamedControls.join(", ")}`);
  await page.getByRole("switch", { name: "vim mode" }).waitFor();
  await page.getByRole("switch", { name: "auto-approve default" }).waitFor();
  if (screenshots) await page.screenshot({ path: `${screenshots}/dialog.png` });
  await page.getByRole("option", { name: /gruvbox-light/ }).click();
  await page.getByRole("button", { name: "IBM Plex Sans" }).click();
  if (await theme(page) !== "gruvbox-light") throw new Error("gruvbox-light did not apply live");
  await page.getByRole("button", { name: "esc" }).click();
  if (screenshots) await page.screenshot({ path: `${screenshots}/gruvbox-light-plex-sans.png` });

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
  console.log("settings gate passed: live theme, persistence, query override, and reset");
}
