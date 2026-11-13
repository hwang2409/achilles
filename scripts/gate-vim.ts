import type { Page } from "playwright";

type WaitFor = (check: () => Promise<boolean>, label: string) => Promise<void>;

export async function gateVim(page: Page, control: string, waitFor: WaitFor) {
  await page.evaluate(() => localStorage.setItem("achilles-settings", JSON.stringify({ vim: true })));
  await page.reload();
  const composer = page.locator('.vim-composer[data-part="composer"]');
  const field = page.getByRole("textbox", { name: "message" });
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await field.fill("helo");
  await field.press("Escape");
  await field.press("0");
  await field.press("l");
  await field.press("a");
  await field.press("l");
  await field.press("Escape");
  if (await field.textContent() !== "hello") throw new Error(`vim edit produced ${JSON.stringify(await field.textContent())}, not "hello"`);
  await field.press("Escape");
  if (await field.evaluate((element) => element === document.activeElement)) throw new Error("second vim escape did not blur the composer");
  if (await field.textContent() !== "hello") throw new Error("vim escape cleared the draft");
  await page.keyboard.press("i");
  if (!(await field.evaluate((element) => element === document.activeElement))) throw new Error("page-level i did not refocus the composer");
  if (await field.textContent() !== "hello") throw new Error("refocusing the vim composer changed the draft");
  await field.press("Escape");
  const before = JSON.parse(await Bun.file(control).text());
  await field.press("Enter");
  await waitFor(async () => {
    const current = JSON.parse(await Bun.file(control).text());
    return current.request_count === (before.request_count ?? 0) + 1 && current.last_message.includes("hello");
  }, "vim message on this backend turn");
  const current = JSON.parse(await Bun.file(control).text());
  if (current.last_message.includes("helo") || !current.last_message.includes("hello")) throw new Error(`vim backend message was not exactly "hello": ${current.last_message}`);
}
