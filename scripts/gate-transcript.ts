import type { Page } from "playwright";

export async function waitForIdleTurn(
  page: Page,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>,
) {
  const composer = page.locator('[data-part="composer"]');
  const runState = page.locator(".run-state");
  await waitFor(
    async () =>
      (await composer.getAttribute("data-state")) === "idle" &&
      (await composer.locator('[data-part="composer-submit"]').innerText()) === "send" &&
      (await composer.locator('[data-part="composer-stop"]').count()) === 0 &&
      (await runState.innerText()) === "idle",
    "idle transcript turn",
  ).catch(async () => {
    throw new Error(`timed out waiting for the transcript turn to become idle: ${JSON.stringify({
      composer: await composer.getAttribute("data-state"),
      submit: await composer.locator('[data-part="composer-submit"]').innerText().catch(() => null),
      stop: await composer.locator('[data-part="composer-stop"]').count(),
      transcript: await runState.innerText().catch(() => null),
    })}`);
  });
}

export async function gateTranscript(
  page: Page,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>,
) {
  const capture = async (name: string) => {
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}`, fullPage: true });
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  const field = page.getByRole("textbox", { name: "message", exact: true });
  const messages = page.locator('[data-part="message"]');
  const beforeMarkdown = await messages.count();
  await field.fill("show rendered markdown");
  await field.press("Enter");
  await waitFor(async () => await messages.count() > beforeMarkdown, "markdown reply for this turn");
  const markdown = messages.nth(beforeMarkdown);
  await waitFor(async () => await markdown.locator("pre > code span").count() > 0, "highlighted code for this markdown reply");
  if (await markdown.locator("h3", { hasText: "Rendered markdown" }).count() !== 1)
    throw new Error("markdown # heading did not render as the message h3");
  if (await markdown.locator("h4", { hasText: "Structured reply" }).count() !== 1)
    throw new Error("markdown ## heading did not render as the message h4");
  if (await markdown.locator("ul > li").count() !== 2)
    throw new Error("markdown list did not render as ul/li elements");
  const markdownText = await markdown.innerText();
  if (markdownText.includes("# Rendered markdown") || markdownText.includes("* first item"))
    throw new Error("markdown source markers remained visible");
  const typography = await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty("--achilles-ui-font", '"IBM Plex Sans"');
    root.style.setProperty("--achilles-code-font", '"IBM Plex Mono"');
    root.style.setProperty("--achilles-ui-size", "16px");
    root.dataset.density = "compact";
    const transcript = getComputedStyle(document.querySelector(".transcript")!);
    const code = getComputedStyle(document.querySelector(".transcript pre code")!);
    return {
      font: transcript.fontFamily,
      size: transcript.fontSize,
      lineHeight: transcript.lineHeight,
      codeFont: code.fontFamily,
    };
  });
  if (
    !typography.font.includes("IBM Plex Sans") || typography.size !== "16px" ||
    typography.lineHeight !== "21.6px" || !typography.codeFont.includes("IBM Plex Mono")
  )
    throw new Error(`transcript did not apply configured typography: ${JSON.stringify(typography)}`);
  await capture("markdown-rendered-1440x900.png");

  await field.fill("stream enough lines to overflow");
  await field.press("Enter");
  const stream = messages.filter({ hasText: "stream line 000" });
  await waitFor(async () => await stream.count() === 1, "streaming reply for this turn");
  await stream.last().evaluate((message) => {
    let element: HTMLElement | null = message as HTMLElement;
    while (element) {
      const style = getComputedStyle(element);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight) {
        element.dataset.gateScrollContainer = "follow";
        return;
      }
      element = element.parentElement;
    }
    throw new Error("could not find the transcript scroll container");
  });
  const scroll = page.locator('[data-gate-scroll-container="follow"]');
  const distanceFromBottom = () => scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  await waitFor(
    async () => await stream.count() === 1 && (await stream.innerText()).includes("stream line 030") &&
      (await scroll.evaluate((element) => element.scrollTop)) > 0 && await distanceFromBottom() <= 4,
    "stream line 030 at the bottom for this turn",
  );
  await capture("streaming-at-bottom-1440x900.png");

  await scroll.hover();
  await page.mouse.wheel(0, -480);
  await waitFor(async () => await distanceFromBottom() > 100, "user scroll up for this turn");
  const scrolledUp = await scroll.evaluate((element) => element.scrollTop);
  await waitFor(async () => (await stream.innerText()).includes("stream line 080"), "stream line 080 for this turn");
  const afterMoreDeltas = await scroll.evaluate((element) => element.scrollTop);
  if (Math.abs(afterMoreDeltas - scrolledUp) > 4)
    throw new Error(`streaming transcript jumped after scroll up: ${scrolledUp} -> ${afterMoreDeltas}`);
  const jump = page.locator('[data-part="jump-to-latest"]');
  await jump.waitFor({ state: "visible", timeout: 20_000 });
  if (await page.locator('[data-part="jump-to-latest"]:visible').count() !== 1)
    throw new Error("tool-call stream rendered more than one visible jump to latest control");
  await capture("streaming-scrolled-up-jump-1440x900.png");
  await jump.click();
  await waitFor(async () => await distanceFromBottom() <= 4, "jump to latest for this turn");
  const approval = page.locator('[data-part="approval"][data-state="pending"]').filter({ hasText: "read" });
  await approval.getByRole("button", { name: "deny", exact: true }).click();
  await page.getByText("stream tool complete", { exact: true }).waitFor({ timeout: 20_000 });
  await waitForIdleTurn(page, waitFor);

  await field.fill("stream text only lines to overflow");
  await field.press("Enter");
  const textStream = messages.filter({ hasText: "text-only line 000" });
  await waitFor(async () => await textStream.count() === 1, "text-only streaming reply for this turn");
  await waitFor(async () => (await textStream.innerText()).includes("text-only line 030") && await distanceFromBottom() <= 4, "text-only line 030 at the bottom for this turn");
  await scroll.hover();
  await page.mouse.wheel(0, -480);
  await waitFor(async () => await distanceFromBottom() > 100, "user scroll up during text-only stream");
  await waitFor(async () => (await textStream.innerText()).includes("text-only line 080"), "text-only line 080 for this turn");
  const textOnlyJump = page.locator('[data-part="jump-to-latest"]');
  await textOnlyJump.waitFor({ state: "visible", timeout: 20_000 });
  if (await page.locator('[data-part="jump-to-latest"]:visible').count() !== 1)
    throw new Error("text-only stream rendered more than one visible jump to latest control");
  await textOnlyJump.focus();
  if (!(await textOnlyJump.evaluate((element) => document.activeElement === element)))
    throw new Error("text-only jump to latest control is not keyboard focusable");
  await textOnlyJump.click();
  await waitFor(async () => await distanceFromBottom() <= 4, "jump to latest after text-only stream");
  await waitFor(async () => (await textStream.innerText()).includes("text-only line 119"), "text-only stream complete");
}
