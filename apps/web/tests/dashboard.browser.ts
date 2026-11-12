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
  if (!page.url().includes("/verdicts/")) throw new Error("verdict route missing");
  await page.getByText(/verdict id:/).waitFor();
  await page.getByText(/verdict id: [a-f0-9]{64}/).waitFor();
  await page.getByRole("button", { name: "fixture-child-1" }).waitFor();
  const childCard = page.locator('[data-part="sub-agent"]');
  await childCard.waitFor();
  const openLabel = childCard.locator('[data-part="sub-agent-open"]');
  if (await openLabel.evaluate(element => getComputedStyle(element, "::after").content) !== '" ›"') throw new Error("child card has wrong open character");
  await page.getByRole("button", { name: "fixture-child-1" }).click();
  await page.getByText("run: fixture-child-1").waitFor();
  if (errors.length) throw new Error(errors.join("\n"));
} finally { await browser.close(); }
