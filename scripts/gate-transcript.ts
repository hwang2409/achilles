import type { Page } from "playwright";
import type { GateWait } from "./gate-diagnostics";

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
  ).catch(async (error) => {
    throw new Error(`${error}\ntranscript turn state: ${JSON.stringify({
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
  requests: () => Array<{ id?: number | string; method?: string; params?: { text?: string; delivery_id?: string }; result?: { accepted?: boolean; status?: string }; error?: { code?: number; message?: string } }>,
  controlPath: string,
  gateWait: GateWait,
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

  await waitForIdleTurn(page, waitFor);
  const startControl = JSON.parse(await Bun.file(controlPath).text());
  await Bun.write(controlPath, JSON.stringify({ ...startControl, hold_turn_start: true }));
  await field.fill("stream enough lines to overflow");
  await field.press("Enter");
  await waitFor(async () => JSON.parse(await Bun.file(controlPath).text()).turn_start_barrier === "held", "held turn-start event");
  await field.fill("prompt during turn starting");
  await field.press("Enter");
  await waitFor(async () => {
    const frames = requests();
    const sent = frames.find((frame) => frame.method === "send" && frame.params?.text === "prompt during turn starting");
    const sentIndex = sent ? frames.indexOf(sent) : -1;
    return frames.some((frame) => frame.method === "steer" && frame.params?.text === "prompt during turn starting") ||
      Boolean(sent && frames.slice(sentIndex + 1).some((frame) => frame.id === sent.id));
  }, "turn-start delivery decision");
  const startingSend = requests().find((frame) => frame.method === "send" && frame.params?.text === "prompt during turn starting");
  const startingSteer = requests().find((frame) => frame.method === "steer" && frame.params?.text === "prompt during turn starting");
  if (!startingSend?.params?.delivery_id || !startingSteer?.params?.delivery_id)
    throw new Error("turn-start fallback did not retry the rejected send as a steer");
  if (startingSend.params.delivery_id !== startingSteer.params.delivery_id)
    throw new Error("turn-start fallback did not reuse its delivery id");
  const heldStartControl = JSON.parse(await Bun.file(controlPath).text());
  await Bun.write(controlPath, JSON.stringify({ ...heldStartControl, release_turn_start_barrier: true }));
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
  const jump = page.locator('[data-part="jump-to-latest"]:visible');
  await gateWait(() => jump.waitFor({ state: "visible", timeout: 20_000 }));
  if (await page.locator('[data-part="jump-to-latest"]:visible').count() !== 1)
    throw new Error("tool-call stream rendered more than one visible jump to latest control");
  // keyboard focus on the control must survive a new row arriving below while the user reads above
  const focusKept = (mark: string) => page.evaluate((mark) => (document.activeElement as HTMLElement | null)?.dataset.gateFocused === mark, mark);
  await jump.evaluate((element) => { (element as HTMLElement).dataset.gateFocused = "stream-jump"; });
  await jump.focus();
  if (!(await focusKept("stream-jump"))) throw new Error("tool-call stream jump to latest control is not keyboard focusable");
  await gateWait(() => page.locator('[data-part="jump-to-latest-lane"] [data-part="jump-to-latest"]').waitFor({ state: "attached", timeout: 20_000 }));
  if (!(await focusKept("stream-jump"))) {
    const active = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160) ?? "none");
    throw new Error(`jump to latest lost keyboard focus when a new row arrived; focus is on ${active}`);
  }
  await capture("streaming-scrolled-up-jump-1440x900.png");
  await page.keyboard.press("Enter");
  await waitFor(async () => await distanceFromBottom() <= 4, "jump to latest for this turn");
  const approval = page.locator('[data-part="approval"][data-state="pending"]').filter({ hasText: "read" });
  await approval.getByRole("button", { name: "deny", exact: true }).click();
  await waitFor(async () => (JSON.parse(await Bun.file(controlPath).text()).turn_barrier ?? null) === "held", "held end-of-turn barrier");
  const beforeBarrierSends = requests().filter((frame) => frame.method === "send" && frame.params?.text === "prompt during denied tool turn ending").length;
  await field.fill("prompt during denied tool turn ending");
  await field.press("Enter");
  await waitFor(async () => requests().some((frame) => frame.method === "steer" && frame.params?.text === "prompt during denied tool turn ending"), "steer sent at held provider turn end");
  const steerFrame = requests().find((frame) => frame.method === "steer" && frame.params?.text === "prompt during denied tool turn ending");
  if (!steerFrame?.params?.delivery_id) throw new Error("held steer frame did not include a delivery id");
  const control = JSON.parse(await Bun.file(controlPath).text());
  await Bun.write(controlPath, JSON.stringify({ ...control, release_turn_barrier: true }));
  // zeta reads a steer sent during the final reply in the next turn it starts after turn_end
  await gateWait(() => page.getByText("stream tool complete", { exact: true }).waitFor({ timeout: 20_000 }));
  const steerResponse = () => { const frames = requests(); return frames.slice(frames.findIndex((frame) => frame.method === "steer" && frame.id === steerFrame.id) + 1).find((frame) => frame.id === steerFrame.id); };
  await waitFor(async () => steerResponse() !== undefined, "turn-end steer response");
  if (!steerResponse()?.result?.accepted) throw new Error(`turn-end steer was not accepted: ${JSON.stringify(steerResponse() ?? null)}`);
  await gateWait(() => page.getByText("end-of-turn followup complete", { exact: true }).waitFor({ timeout: 30_000 }));
  const steerStatuses = () => {
    const frames = requests();
    const ids = new Set(frames.filter((frame) => frame.method === "delivery_status" && frame.params?.delivery_id === steerFrame.params?.delivery_id).map((frame) => frame.id));
    return frames.filter((frame) => frame.method === undefined && ids.has(frame.id) && frame.result?.status).map((frame) => frame.result?.status);
  };
  await waitFor(async () => steerStatuses().at(-1) === "delivered", "turn-end steer delivered");
  if (steerStatuses().includes("dropped")) throw new Error(`turn-end steer was dropped: ${JSON.stringify(steerStatuses())}`);
  if (await messages.filter({ hasText: "end-of-turn followup complete" }).count() !== 1)
    throw new Error("prompt during turn end was not delivered exactly once");
  const modelSaw = (JSON.parse(await Bun.file(controlPath).text()).user_messages ?? []).filter((text: string) => text === "prompt during denied tool turn ending").length;
  if (modelSaw !== 1) throw new Error(`the next turn's model request carried the turn-end steer ${modelSaw} times instead of once`);
  await waitFor(async () => await field.inputValue() === "", "draft clear after delivered turn-end steer");
  const turnEndSends = requests().filter((frame) => frame.method === "send" && frame.params?.text === "prompt during denied tool turn ending").length;
  const turnEndSteers = requests().filter((frame) => frame.method === "steer" && frame.params?.text === "prompt during denied tool turn ending").length;
  if (turnEndSends !== beforeBarrierSends || turnEndSteers !== 1) throw new Error(`prompt during turn end was sent ${turnEndSends - beforeBarrierSends} times and steered ${turnEndSteers} times instead of one steer`);
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
  const textOnlyJump = page.locator('[data-part="jump-to-latest"]:visible');
  await gateWait(() => textOnlyJump.waitFor({ state: "visible", timeout: 20_000 }));
  if (await page.locator('[data-part="jump-to-latest"]:visible').count() !== 1)
    throw new Error("text-only stream rendered more than one visible jump to latest control");
  await textOnlyJump.evaluate((element) => { (element as HTMLElement).dataset.gateFocused = "text-jump"; });
  await textOnlyJump.focus();
  if (!(await focusKept("text-jump"))) throw new Error("text-only jump to latest control is not keyboard focusable");
  await waitFor(async () => (await textStream.innerText()).includes("text-only line 119"), "text-only stream complete");
  await waitForIdleTurn(page, waitFor);
  if (!(await focusKept("text-jump"))) {
    const active = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? "none");
    throw new Error(`jump to latest lost keyboard focus while the reply streamed; focus is on ${active}`);
  }
  await page.keyboard.press("Enter");
  await waitFor(async () => await distanceFromBottom() <= 4, "keyboard jump to latest after text-only stream");
}
