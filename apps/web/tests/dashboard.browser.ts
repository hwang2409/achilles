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
  const timeline = page.getByLabel("trace timeline");
  await page.getByRole("button", { name: "fixture-child-1" }).waitFor();
  await page.getByRole("button", { name: "fixture-child-1" }).click();
  await page.getByText("run: fixture-child-1").waitFor();
  if (errors.length) throw new Error(errors.join("\n"));
} finally { await browser.close(); }
