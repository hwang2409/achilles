import type { Browser, Page } from "playwright";

const NOTE = "new branch continues after this message · files are not changed";
const SAME_CHAT_NOTICE = "this chat is open or kept running in another tab. you can read it here.";

/**
 * gate step: branch from a user message in tab A while tab C reads the same chat. zeta forks at the message
 * (`fork_message`) and both tabs show the new branch and "branch 2 of 2"; switching back (`switch_branch`) restores the
 * old transcript in both. tab A's chat already has the turns "together from a" and "after tab c joined".
 */
export async function gateBranchAcrossTabs(browser: Browser, held: Page) {
  const wait = { timeout: 20_000 };
  const transcript = (tab: Page) => tab.locator(".transcript");
  const shows = async (tab: Page, text: string) => (await transcript(tab).getByText(text, { exact: true }).count()) > 0;
  const chip = (tab: Page) => tab.locator(".branch-chip");
  const until = async (check: () => Promise<boolean>, label: string) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((done) => setTimeout(done, 100))) if (await check()) return;
    throw new Error(`branch step: ${label}`);
  };
  // two tabs of one browser (one context: a separate context is another browser, and zeta tells it nothing about the
  // change). the gate's tab owns its own context, so close it and open the chat in A, which then holds it, and C.
  const url = held.url();
  await held.close();
  const context = await browser.newContext();
  const a = await context.newPage();
  const c = await context.newPage();
  try {
    await a.goto(url);
    await transcript(a).getByText("you said: after tab c joined", { exact: true }).waitFor(wait);
    // zeta may not have seen the old tab's socket close yet: the app's bounded resume retry covers it
    await until(async () => await a.getByRole("textbox", { name: "message", exact: true }).isEditable() && !await a.getByText(SAME_CHAT_NOTICE, { exact: true }).count(), "tab a did not take the chat after the old tab closed");
    await c.goto(url);
    await c.getByText(SAME_CHAT_NOTICE, { exact: true }).waitFor(wait);
    await transcript(c).getByText("you said: after tab c joined", { exact: true }).waitFor(wait);

    const row = transcript(a).locator(".user-turn").filter({ hasText: "together from a" });
    const action = row.locator(".branch-from");
    const opacity = () => action.evaluate((element) => getComputedStyle(element).opacity);
    if (await opacity() !== "0") throw new Error("branch from here shows before hover or focus");
    await row.hover();
    await until(async () => await opacity() === "1", "branch from here did not show on hover");
    // keyboard reach: Tab lands on a "branch from here", and keyboard focus shows it
    await a.mouse.move(0, 0);
    await a.locator(".chat-heading strong").focus();
    let reached = false;
    for (let press = 0; press < 80 && !reached; press++) {
      await a.keyboard.press("Tab");
      reached = await a.evaluate(() => document.activeElement?.classList.contains("branch-from") === true && getComputedStyle(document.activeElement).opacity === "1");
    }
    if (!reached) throw new Error("Tab never reached a visible branch from here");
    if (await c.locator(".user-turn").filter({ hasText: "together from a" }).locator('.branch-from[aria-disabled="true"]').count() !== 1) throw new Error("tab c's branch from here is not off");

    await action.focus();
    await action.press("Enter");
    await until(async () => await shows(a, "together from a") && !await shows(a, "you said: together from a") && !await shows(a, "after tab c joined"), "tab a did not show the new branch");
    await until(async () => await chip(a).getAttribute("aria-label") === "branch 2 of 2", "tab a's header did not say branch 2 of 2");
    await a.getByText(NOTE, { exact: true }).waitFor(wait);
    const composer = a.getByRole("textbox", { name: "message", exact: true });
    if (!await composer.evaluate((element) => element === document.activeElement) || await composer.inputValue() !== "") throw new Error("the composer is not focused and empty after the fork");
    await until(async () => !await shows(c, "after tab c joined") && await chip(c).getAttribute("aria-label") === "branch 2 of 2", "tab c did not follow the fork");

    await chip(a).click();
    await a.locator(".branch-list button:not([aria-current])").click();
    await until(async () => await shows(a, "you said: after tab c joined") && await chip(a).getAttribute("aria-label") === "branch 1 of 2", "switching back did not restore tab a's transcript");
    await until(async () => await shows(c, "you said: after tab c joined") && await chip(c).getAttribute("aria-label") === "branch 1 of 2", "tab c did not follow the switch back");
    console.log("branch: tab a forked from a user message by keyboard, both tabs showed branch 2 of 2 without the later turns, and switching back restored both");
  } finally { await context.close(); }
}
