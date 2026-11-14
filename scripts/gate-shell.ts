import type { Page } from "playwright";

export async function gateShell(
  page: Page,
  firstSessionId: string,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>,
) {
  const capture = async (name: string) => { if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}`, fullPage: true }); };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set("theme", "gruvbox-light"); history.replaceState({}, "", url); });
  const chatsBefore = await page.locator(".chat-row").count();
  await page.getByRole("button", { name: "new chat" }).click();
  await waitFor(async () => {
    const current = await page.locator("[data-session-id]").getAttribute("data-session-id");
    return Boolean(current && current !== firstSessionId);
  }, "second home chat");
  await waitFor(async () => await page.getByRole("textbox", { name: "message", exact: true }).evaluate((field) => field === document.activeElement), "pointer new chat composer focus");
  const secondSessionId = await page.locator("[data-session-id]").getAttribute("data-session-id");
  const selectedUrl = new URL(page.url());
  if (!secondSessionId || selectedUrl.searchParams.get("chat") !== secondSessionId)
    throw new Error("new chat did not become the selected URL chat");
  if (selectedUrl.searchParams.get("theme") !== "gruvbox-light")
    throw new Error("new chat navigation discarded the theme query");
  await waitFor(async () => await page.locator(".chat-row").count() === chatsBefore + 1, "second home chat in sidebar");
  await capture("02-new-chat-review-1440x900.png");
  if ((await page.locator(".chat-row.current").getAttribute("href"))?.includes(secondSessionId) !== true)
    throw new Error("new chat was not current in the sidebar");

  await page.reload();
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });
  if (new URL(page.url()).searchParams.get("chat") !== secondSessionId)
    throw new Error("reload did not keep the selected chat query");
  await page.keyboard.press("Meta+Shift+O");
  await waitFor(async () => {
    const field = page.getByRole("textbox", { name: "message", exact: true });
    return await field.count() === 1 && await field.evaluate((element) => element === document.activeElement);
  }, "shortcut new chat composer focus");

  const search = page.getByRole("combobox", { name: "search chats and pages" });
  await search.waitFor({ timeout: 20_000 });
  await search.fill("prove chat");
  await waitFor(async () => await page.locator(".chat-row").count() === 1, "chat title search");
  if (!(await page.locator(".chat-row").innerText()).includes("prove chat"))
    throw new Error("search did not filter by chat title");
  await search.press("ArrowDown");
  if (!(await page.locator(".chat-row").first().evaluate((row) => row.classList.contains("active-result"))))
    throw new Error("search arrow key did not activate a result");
  await search.press("Enter");
  await page.getByText("assistant ready", { exact: true }).waitFor({ timeout: 20_000 });
  if (await page.locator("[data-session-id]").getAttribute("data-session-id") !== firstSessionId)
    throw new Error("search enter did not open the active result");
  await search.press("Escape");
  if (await search.inputValue()) throw new Error("escape did not clear chat search");
  if (new URL(page.url()).searchParams.get("theme") !== "gruvbox-light")
    throw new Error("chat selection discarded the theme query");

  await page.goto(`${new URL(page.url()).origin}/?theme=gruvbox-light&chat=foreign-session`);
  await page.getByRole("alert").filter({ hasText: "chat not found on this page" }).waitFor({ timeout: 20_000 });
  await page.goto(`${new URL(page.url()).origin}/?theme=gruvbox-light&chat=${firstSessionId}`);
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = page.locator("aside.sidebar");
  await waitFor(async () => (await sidebar.getAttribute("aria-hidden")) === "true", "closed drawer accessibility state");
  const menu = page.getByRole("button", { name: "open menu" });
  await menu.click();
  await sidebar.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const main = page.locator("main.main-pane");
  if (!(await main.evaluate((element) => element.inert)) || await main.getAttribute("aria-hidden") !== "true")
    throw new Error("open drawer left the main pane interactive");
  if (!(await sidebar.evaluate((element) => element.contains(document.activeElement))))
    throw new Error("opening the drawer did not move focus into it");
  await page.keyboard.press("Tab");
  if (!(await sidebar.evaluate((element) => element.contains(document.activeElement))))
    throw new Error("drawer tab escaped into the obscured main pane");
  await capture("10-narrow-drawer-review-390x844.png");
  await page.keyboard.press("Escape");
  if ((await sidebar.getAttribute("aria-hidden")) !== "true") throw new Error("escape did not close the drawer");
  await sidebar.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  if (!(await menu.evaluate((button) => button === document.activeElement))) throw new Error("closing the drawer did not restore menu focus");
  const overflow = page.getByRole("button", { name: "chat options" });
  await overflow.click();
  if (!(await page.locator(".header-menu").getByRole("button").isVisible())) throw new Error("narrow chat menu did not expose create mode");
  if (!(await page.locator(".header-menu .approval-mode").isVisible())) throw new Error("narrow chat menu did not expose approval mode");
  await capture("09-narrow-chat-menu-review-390x844.png");
  await page.keyboard.press("Escape");
  if (await page.locator(".header-menu").count()) throw new Error("escape did not close the narrow chat menu");
  await page.setViewportSize({ width: 1440, height: 900 });

  return secondSessionId;
}
