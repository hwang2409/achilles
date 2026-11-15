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
  // the scroll container only needs scrolling once enough lines have streamed in (one every 60ms,
  // up to line 030 below), so poll instead of checking once right as the first line appears.
  await waitFor(() => stream.last().evaluate((message) => {
    let element: HTMLElement | null = message as HTMLElement;
    while (element) {
      const style = getComputedStyle(element);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight) {
        element.dataset.gateScrollContainer = "follow";
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }), "transcript scroll container to start scrolling");
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

// A reload in the middle of a streaming reply keeps the turn (`turn_reconnect`): the reloaded page attaches to it with
// `resume`, shows it running with a stop control while later lines stream in, and ends with one reply, each line once,
// and no warning before the reload.
export async function gateReloadMidTurn(
  page: Page,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>,
  requests: () => Array<{ id?: number | string; method?: string; params?: { session_id?: string }; result?: { attached?: string; capabilities?: { features?: string[] } }; error?: unknown }>,
  gateWait: GateWait,
) {
  const field = page.getByRole("textbox", { name: "message", exact: true });
  const messages = page.locator('[data-part="message"]');
  const reply = messages.filter({ hasText: "reload line 000" });
  const sessionId = await page.locator("[data-session-id]").getAttribute("data-session-id");
  const dialogs: string[] = [];
  const onDialog = (dialog: { type(): string; dismiss(): Promise<void> }) => { dialogs.push(dialog.type()); void dialog.dismiss(); };
  page.on("dialog", onDialog);
  try {
    await waitForIdleTurn(page, waitFor);
    const hello = requests().findLast((frame) => frame.result?.capabilities?.features);
    if (!hello?.result?.capabilities?.features?.includes("turn_reconnect")) throw new Error("zeta did not grant turn_reconnect");
    await field.fill("stream across a reload");
    await field.press("Enter");
    await waitFor(async () => (await reply.count()) === 1 && (await reply.innerText()).includes("reload line 010"), "reload stream line 010");
    const framesBeforeReload = requests().length;
    await gateWait.playwright(page, "reload");
    if (dialogs.length) throw new Error(`reload during a running turn asked first: ${dialogs.join(", ")}`);
    let attached: ReturnType<typeof requests>[number] | undefined;
    await waitFor(async () => {
      const after = requests().slice(framesBeforeReload);
      const resume = after.find((frame) => frame.method === "resume" && frame.params?.session_id === sessionId);
      attached = resume && after.find((frame) => frame.id === resume.id && (frame.result || frame.error) && frame.method === undefined);
      return attached !== undefined;
    }, "resume reply after reload");
    if (attached?.result?.attached !== "live_turn") throw new Error(`reload did not attach to the kept turn: ${JSON.stringify(attached?.error ?? attached?.result ?? null)}`);
    // the kept turn is still streaming (line 079 lands seconds later): the page shows it running, steerable, and stoppable
    const composer = page.locator('[data-part="composer"]');
    const runState = page.locator(".run-state");
    const turnEnded = async () => (await messages.filter({ hasText: "reload line 079" }).count()) > 0;
    const runningWithStop = async () => (await runState.innerText()) === "running" && (await composer.getAttribute("data-state")) === "steerable" && (await composer.locator('[data-part="composer-stop"]').count()) === 1;
    await waitFor(async () => !(await turnEnded()) && await runningWithStop(), "kept turn shown running with a stop control after reload").catch(async (error) => {
      throw new Error(`${error}\nafter reload: ${JSON.stringify({ runState: await runState.innerText(), composer: await composer.getAttribute("data-state"), stop: await composer.locator('[data-part="composer-stop"]').count(), ended: await turnEnded() })}`);
    });
    // the reply streams on the reloaded page: a later line shows before the turn ends, not only at its final commit
    await waitFor(async () => (await messages.filter({ hasText: "reload line 050" }).count()) === 1, "reply streaming after reload");
    if (await turnEnded() || !(await runningWithStop())) throw new Error("reload line 050 showed only after the turn ended, not while it streamed");
    // the text streamed before the reload shows on the reloaded page while the reply still streams (`in_flight_replay`), once
    const streaming = await reply.innerText();
    const lines = (text: string, last: number) => Array.from({ length: last + 1 }, (_, index) => text.split(`reload line ${String(index).padStart(3, "0")}`).length - 1);
    if (await reply.count() !== 1 || lines(streaming, 50).some((count) => count !== 1))
      throw new Error(`while the reply streamed after the reload, lines 000-050 showed ${JSON.stringify(lines(streaming, 50))} times in ${await reply.count()} messages, not once each`);
    await gateWait(() => page.getByText("reload line 079", { exact: false }).waitFor({ timeout: 30_000 }));
    await waitForIdleTurn(page, waitFor);
    if (await reply.count() !== 1) throw new Error(`reload split or duplicated the reply into ${await reply.count()} messages`);
    const text = await reply.innerText();
    const missing: number[] = []; const repeated: number[] = [];
    for (let index = 0; index < 80; index++) {
      const count = text.split(`reload line ${String(index).padStart(3, "0")}`).length - 1;
      if (count === 0) missing.push(index); else if (count > 1) repeated.push(index);
    }
    if (missing.length || repeated.length) throw new Error(`reply after reload lost lines ${JSON.stringify(missing)} and repeated lines ${JSON.stringify(repeated)}`);
    const prompts = await page.locator(".transcript").getByText("stream across a reload", { exact: true }).count();
    if (prompts !== 1) throw new Error(`reload showed the prompt ${prompts} times: ${(await page.locator(".transcript").innerText()).slice(-1500)}`);
    const cancelled = requests().slice(framesBeforeReload).some((frame) => JSON.stringify(frame).includes('"reason":"disconnect"'));
    if (cancelled) throw new Error("zeta cancelled the turn on reload (reason disconnect)");
    if (await page.getByRole("alert").count()) throw new Error(`reload mid-turn showed a notice: ${await page.getByRole("alert").first().innerText()}`);
    console.log("reload mid-turn asserted: the reloaded page took over the running turn and showed it running, stoppable, and streaming; one reply, 80 lines once each, no warning, no notice");
  } finally {
    page.off("dialog", onDialog);
  }
}
