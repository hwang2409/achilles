import type { Page } from "playwright";

export async function gateShell(
  page: Page,
  firstSessionId: string,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>,
) {
  const chatsBefore = await page.locator(".chat-row").count();
  await page.getByRole("button", { name: "new chat" }).click();
  await waitFor(async () => {
    const current = await page.locator("[data-session-id]").getAttribute("data-session-id");
    return Boolean(current && current !== firstSessionId);
  }, "second home chat");
  const secondSessionId = await page.locator("[data-session-id]").getAttribute("data-session-id");
  if (!secondSessionId || new URL(page.url()).searchParams.get("chat") !== secondSessionId)
    throw new Error("new chat did not become the selected URL chat");
  await waitFor(async () => await page.locator(".chat-row").count() === chatsBefore + 1, "second home chat in sidebar");
  if ((await page.locator(".chat-row.current").getAttribute("href"))?.includes(secondSessionId) !== true)
    throw new Error("new chat was not current in the sidebar");

  await page.reload();
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });
  if (new URL(page.url()).searchParams.get("chat") !== secondSessionId)
    throw new Error("reload did not keep the selected chat query");
  await page.locator(`.chat-row[href*="${firstSessionId}"]`).click();
  await page.getByText("assistant ready", { exact: true }).waitFor({ timeout: 20_000 });
  if (await page.locator("[data-session-id]").getAttribute("data-session-id") !== firstSessionId)
    throw new Error("switching back did not open the first transcript");

  const search = page.getByRole("textbox", { name: "search chats and pages" });
  await search.fill("prove chat");
  await waitFor(async () => await page.locator(".chat-row").count() === 1, "chat title search");
  if (!(await page.locator(".chat-row").innerText()).includes("prove chat"))
    throw new Error("search did not filter by chat title");
  await search.fill("");
}
