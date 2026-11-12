import { chromium } from "playwright";

const base = process.env.ACHILLES_URL;
if (!base) throw new Error("ACHILLES_URL is required");
const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(base);
  await page.getByRole("button", { name: /fixture failure/ }).click();
  await page.getByText("label: fixture failure").waitFor();
  await page.getByText("urgent: yes").waitFor();
  await page.getByText("the child found a failure", { exact: true }).waitFor();
  const childCard = page.locator('[data-part="sub-agent"]');
  await childCard.waitFor();
  if (await childCard.locator('[data-part="sub-agent-open"]').evaluate(element => getComputedStyle(element, "::after").content) !== '" ›"') throw new Error("child card has wrong open character");
  await childCard.click();
  await page.getByText("run: fixture-child-1").waitFor();
  await page.getByText("build failed in fixture", { exact: true }).first().waitFor();
  if (errors.length) throw new Error(errors.join("\n"));
} finally { await browser.close(); }
