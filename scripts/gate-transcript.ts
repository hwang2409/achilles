import type { Browser, Page } from "playwright";
import { type GateWait, writeControl } from "./gate-diagnostics";
import { gateBranchAcrossTabs } from "./gate-branch";

export async function waitForIdleTurn(
  page: Page,
  waitFor: (check: () => Promise<boolean>, label: string) => Promise<void>,
) {
  const composer = page.locator('[data-part="composer"]');
  await waitFor(
    async () =>
      (await composer.getAttribute("data-state")) === "idle" &&
      (await composer.locator('[data-part="composer-submit"]').innerText()) === "send" &&
      (await composer.locator('[data-part="composer-stop"]').count()) === 0,
    "idle transcript turn",
  ).catch(async (error) => {
    throw new Error(`${error}\ntranscript turn state: ${JSON.stringify({
      composer: await composer.getAttribute("data-state"),
      submit: await composer.locator('[data-part="composer-submit"]').innerText().catch(() => null),
      stop: await composer.locator('[data-part="composer-stop"]').count(),
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
  if (await markdown.locator('[data-part="code-fence-head"] span', { hasText: "python" }).count() !== 1 ||
    await markdown.locator('[data-part="code-fence-head"] button', { hasText: "code" }).count() !== 1)
    throw new Error("ordinary fenced code did not render its language head and copy button");
  if (await markdown.locator("h3", { hasText: "Rendered markdown" }).count() !== 1)
    throw new Error("markdown # heading did not render as the message h3");
  if (await markdown.locator("h4", { hasText: "Structured reply" }).count() !== 1)
    throw new Error("markdown ## heading did not render as the message h4");
  if (await markdown.locator("ul > li").count() !== 2)
    throw new Error("markdown list did not render as ul/li elements");
  const checkTableGeometry = async (width: number, expectWideScroll: boolean) => {
    await page.setViewportSize({ width, height: 900 });
    const tablesLocator = page.locator('[data-part="message"][data-format="markdown"] [data-part="md-table"]');
    await waitFor(async () => await tablesLocator.count() === 2, `two markdown tables at ${width}`);
    const geometry = await tablesLocator.evaluateAll((tables, expectWide) => {
      const container = tables[0]?.closest('[data-part="message"]')?.getBoundingClientRect();
      return {
        containerLeft: container?.left,
        containerRight: container?.right,
        tables: tables.map((table) => {
          const rect = table.getBoundingClientRect();
          return { right: rect.right, width: rect.width, scrollWidth: table.scrollWidth, clientWidth: table.clientWidth };
        }),
        wideScroll: expectWide ? (tables[1]?.scrollWidth ?? 0) > (tables[1]?.clientWidth ?? 0) : true,
      };
    }, expectWideScroll);
    if (geometry.tables.length !== 2 || geometry.containerLeft === undefined || geometry.containerRight === undefined ||
      geometry.tables.some((table) => table.right > geometry.containerRight + 1 || table.width > geometry.containerRight - geometry.containerLeft + 1) || !geometry.wideScroll)
      throw new Error(`markdown table geometry failed at ${width}: ${JSON.stringify(geometry)}`);
  };
  await checkTableGeometry(1440, false);
  await checkTableGeometry(390, true);
  await page.setViewportSize({ width: 1440, height: 900 });
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
    const prose = getComputedStyle(document.querySelector('.transcript [data-part="message"][data-format="markdown"]')!);
    const code = getComputedStyle(document.querySelector(".transcript pre code")!);
    const timeline = document.querySelector('.transcript [data-part="timeline"]')!;
    return {
      font: transcript.fontFamily,
      proseFont: prose.fontFamily,
      proseSize: prose.fontSize,
      proseLineHeight: prose.lineHeight,
      rowWidth: timeline.querySelector("[data-virtual-id]")!.getBoundingClientRect().width,
      expectedWidth: document.querySelector('[data-part="composer"]')!.getBoundingClientRect().width,
      size: transcript.fontSize,
      lineHeight: transcript.lineHeight,
      codeFont: code.fontFamily,
    };
  });
  if (
    !typography.font.includes("IBM Plex Sans") || !typography.proseFont.includes("IBM Plex Sans") || typography.size !== "16px" ||
    typography.lineHeight !== "21.6px" || !typography.codeFont.includes("IBM Plex Mono") ||
    typography.proseSize !== "15px" || typography.proseLineHeight !== "22.5px" || Math.abs(typography.rowWidth - typography.expectedWidth) > 1
  )
    throw new Error(`transcript did not apply configured typography: ${JSON.stringify(typography)}`);
  await capture("markdown-rendered-1440x900.png");

  await waitForIdleTurn(page, waitFor);
  const startControl = JSON.parse(await Bun.file(controlPath).text());
  await writeControl(controlPath, { ...startControl, hold_turn_start: true });
  await field.fill("stream enough lines to overflow");
  await field.press("Enter");
  await waitFor(async () => JSON.parse(await Bun.file(controlPath).text()).turn_start_barrier === "held", "held turn-start event");
  // the server holds turn_start before the page may have handled the send reply; wait for the page too,
  // so this step tests the send-to-steer fallback and not an Enter during a pending send
  const composer = page.locator('[data-part="composer"]');
  await waitFor(async () => await composer.getAttribute("data-pending") === null && await field.inputValue() === "", "settled stream send");
  await field.fill("prompt during turn starting");
  await field.press("Enter");
  await waitFor(async () => {
    const frames = requests();
    const sent = frames.find((frame) => frame.method === "send" && frame.params?.text === "prompt during turn starting");
    const sentIndex = sent ? frames.indexOf(sent) : -1;
    return frames.some((frame) => frame.method === "steer" && frame.params?.text === "prompt during turn starting") ||
      Boolean(sent && frames.slice(sentIndex + 1).some((frame) => frame.id === sent.id));
  }, "turn-start delivery decision").catch(async (error) => {
    throw new Error(`${error}\ncomposer: ${JSON.stringify({
      pending: await composer.getAttribute("data-pending"),
      queued: await composer.getAttribute("data-queued"),
      error: await composer.getAttribute("data-error"),
      message: await composer.locator('[data-part="composer-message"]').innerText().catch(() => null),
      draft: await field.inputValue().catch(() => null),
    })}`);
  });
  const startingSend = requests().find((frame) => frame.method === "send" && frame.params?.text === "prompt during turn starting");
  const startingSteer = requests().find((frame) => frame.method === "steer" && frame.params?.text === "prompt during turn starting");
  if (!startingSend?.params?.delivery_id || !startingSteer?.params?.delivery_id)
    throw new Error("turn-start fallback did not retry the rejected send as a steer");
  if (startingSend.params.delivery_id !== startingSteer.params.delivery_id)
    throw new Error("turn-start fallback did not reuse its delivery id");
  const heldStartControl = JSON.parse(await Bun.file(controlPath).text());
  await writeControl(controlPath, { ...heldStartControl, release_turn_start_barrier: true });
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
  const jump = page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible');
  await gateWait(() => jump.waitFor({ state: "visible", timeout: 20_000 }));
  if (await page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible').count() !== 1)
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
  await writeControl(controlPath, { ...control, release_turn_barrier: true });
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
  await page.mouse.wheel(0, -1200);
  await waitFor(async () => await distanceFromBottom() > 100, "user scroll up during text-only stream");
  await waitFor(async () => (await textStream.innerText()).includes("text-only line 080"), "text-only line 080 for this turn");
  const textOnlyJump = page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible');
  await gateWait(() => textOnlyJump.waitFor({ state: "visible", timeout: 20_000 }));
  if (await page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible').count() !== 1)
    throw new Error("text-only stream rendered more than one visible jump to latest control");
  const jumpDiagnostics = async () => page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]');
    const pane = document.querySelector<HTMLElement>('.transcript');
    const frame = document.querySelector<HTMLElement>('[data-part="timeline-frame"]');
    const lane = document.querySelector<HTMLElement>('[data-part="jump-to-latest-lane"][data-jump-owned="true"]');
    const control = document.querySelector<HTMLElement>('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]');
    const rect = (element: HTMLElement | null) => element && (() => { const value = element.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width, height: value.height }; })();
    return {
      scrollTop: scroll?.scrollTop,
      scrollHeight: scroll?.scrollHeight,
      clientHeight: scroll?.clientHeight,
      gap: scroll && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
      controlPresent: Boolean(control),
      controlRectCount: control?.getClientRects().length ?? 0,
      controlVisible: Boolean(control?.getClientRects().length),
      controlRect: rect(control),
      laneRect: rect(lane),
      frameRect: rect(frame),
      scrollRect: rect(scroll),
      viewport: { width: innerWidth, height: innerHeight },
      lastStreamedLine: [...document.querySelectorAll('[data-part="timeline"]')].flatMap((element) => [...element.textContent?.matchAll(/text-only line \d+/g) ?? []].map((match) => match[0])).at(-1) ?? null,
      followRequest: pane?.dataset.followRequest ?? null,
      watchState: control?.getClientRects().length ? "shown" : "hidden",
    };
  });
  const waitForJump = async (check: () => Promise<boolean>, label: string) => {
    try { await waitFor(check, label); }
    catch (error) { throw new Error(`${error}\njump diagnostics at timeout: ${JSON.stringify(await jumpDiagnostics())}`); }
  };
  const assertJumpLane = async (width: number) => {
    // This path tests the manual opener, not the focused composer's resize handoff.
    if (width === 390) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.setViewportSize({ width, height: width === 390 ? 760 : 900 });
    if (width === 390) {
      const bar = page.locator(".page-chat-bar");
      await gateWait.playwright(bar, "waitFor", { state: "visible" });
      await bar.click();
      const sheet = page.getByRole("dialog", { name: "page chat" });
      await gateWait.playwright(sheet, "waitFor", { state: "visible" });
      if (!(await sheet.evaluate((node) => node.contains(document.activeElement))))
        throw new Error("390px page chat manual opener did not move focus into the sheet");
      await gateWait.playwright(sheet.locator(".transcript"), "waitFor", { state: "visible" });
      if (await sheet.locator(".transcript").evaluate((element) => element.clientHeight <= 0)) throw new Error("390px page chat jump sheet has no usable transcript height");
    }
    await waitForJump(async () => await page.evaluate((narrow) => {
      const shell = document.querySelector<HTMLElement>(".app-shell");
      const main = document.querySelector<HTMLElement>(".main-pane");
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      const scrim = document.querySelector<HTMLElement>(".drawer-scrim");
      const control = document.querySelector<HTMLElement>('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]');
      if (!shell || !main || !sidebar || !scrim || !control || !control.isConnected || !control.getClientRects().length) return false;
      const style = getComputedStyle(control);
      const scrimStyle = getComputedStyle(scrim);
      if (style.visibility === "hidden" || style.opacity === "0" || style.pointerEvents === "none") return false;
      if (narrow && (sidebar.getBoundingClientRect().right > 0 || scrimStyle.opacity !== "0" || scrimStyle.pointerEvents !== "none")) return false;
      const rect = control.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const dialog = hit?.closest("[role=dialog], dialog");
      const pageChatSheet = document.querySelector<HTMLElement>("#page-chat-sheet");
      return !shell.classList.contains("drawer-open") && !main.inert && main.getAttribute("aria-hidden") !== "true" &&
        (hit === control || control.contains(hit)) && !hit?.closest(".drawer-scrim") && (!dialog || dialog === pageChatSheet);
    }, width <= 760), `responsive shell and unobscured jump control at ${width}`);
    const geometry = await page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible').evaluate((control) => {
      const rect = (element: Element) => { const value = element.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width, height: value.height }; };
      const controlRect = rect(control);
      const pane = document.querySelector<HTMLElement>('.transcript')!;
      const paneRect = rect(pane);
      const lane = document.querySelector<HTMLElement>('[data-part="jump-to-latest-lane"][data-jump-owned="true"]')!;
      const laneRect = rect(lane);
      const full = document.querySelector<HTMLElement>('[data-jump-label="full"]')!;
      const compact = document.querySelector<HTMLElement>('[data-jump-label="compact"]')!;
      const visible = (element: HTMLElement) => getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
      const scrollRect = scroll.getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-part="timeline"] [data-id]')].filter((row) => {
        const rowRect = row.getBoundingClientRect();
        return rowRect.left < scrollRect.right && rowRect.right > scrollRect.left && rowRect.top < scrollRect.bottom && rowRect.bottom > scrollRect.top;
      });
      const rowRects = rows.map((row) => {
        const rowRect = row.getBoundingClientRect();
        return { top: Math.max(rowRect.top, scrollRect.top), bottom: Math.min(rowRect.bottom, scrollRect.bottom), left: Math.max(rowRect.left, scrollRect.left), right: Math.min(rowRect.right, scrollRect.right) };
      }).filter((rowRect) => rowRect.bottom > rowRect.top && rowRect.right > rowRect.left);
      const rowIntersecting = rowRects.filter((rowRect) => rowRect.left < controlRect.right && rowRect.right > controlRect.left && rowRect.top < controlRect.bottom && rowRect.bottom > controlRect.top).length;
      return { fullVisible: visible(full), compactVisible: visible(compact), control: controlRect, pane: paneRect, lane: laneRect, rows: rows.length, rowRects, rowIntersecting, insidePane: controlRect.left >= paneRect.left && controlRect.right <= paneRect.right && controlRect.top >= paneRect.top && controlRect.bottom <= paneRect.bottom, scrollGap: paneRect.bottom - scrollRect.bottom, ariaLabel: control.getAttribute("aria-label"), title: control.getAttribute("title") };
    });
    const expectedCompact = width <= 480;
    // the control floats over the rows, so the timeline still runs to the bottom of the pane: no reserved band
    if (!geometry.insidePane || Math.abs(geometry.scrollGap) > 1 || (expectedCompact && (geometry.control.width !== 44 || geometry.control.height !== 44)) || geometry.compactVisible !== expectedCompact || geometry.fullVisible === expectedCompact || geometry.ariaLabel !== "jump to latest" || geometry.title !== "jump to latest")
      throw new Error(`jump control geometry or labels failed at ${width}: ${JSON.stringify(geometry)}`);
    if (width === 390) {
      const sheet = page.getByRole("dialog", { name: "page chat" });
      await sheet.getByRole("button", { name: "close page chat" }).click();
      const bar = page.locator(".page-chat-bar");
      await gateWait.playwright(bar, "waitFor", { state: "visible" });
      await bar.evaluate((element) => { if (document.activeElement !== element) throw new Error("390px page chat close did not restore focus to the bar"); });
    }
  };
  await assertJumpLane(1440);
  await capture("streaming-scrolled-up-jump-1440x900.png");
  await assertJumpLane(390);
  await capture("streaming-scrolled-up-jump-390x760.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await scroll.evaluate((element) => {
    const original = element.scrollTo.bind(element);
    element.scrollTo = ((options: ScrollToOptions | number, y?: number) => {
      if (typeof options === "object" && options.behavior === "smooth") {
        setTimeout(() => original({ top: Math.max(0, element.scrollTop - 200), behavior: "auto" }), 150);
      } else if (typeof options === "number") {
        original(options, y);
      } else {
        original(options);
      }
    }) as typeof element.scrollTo;
  });
  await waitForJump(async () => (JSON.parse(await Bun.file(controlPath).text()).jump_stream_barrier ?? null) === "held", "held jump stream chunks");
  // Desktop CSS can show the jump before the closed mobile sheet drops inert.
  const desktopJump = page.locator(".page-chat-docked #page-chat-sheet:not([inert], [role], [aria-modal])").locator(textOnlyJump);
  await gateWait.playwright(desktopJump, "waitFor", { state: "visible" });
  await desktopJump.focus();
  if (!(await desktopJump.evaluate((element) => document.activeElement === element))) throw new Error("text-only jump to latest control is not keyboard focusable");
  await desktopJump.click();
  await waitForJump(async () => await scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop <= 4 && !document.querySelector<HTMLElement>('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]')?.getClientRects().length), "jump to latest lands before releasing held chunks");
  const jumpedBeforeRelease = await scroll.evaluate((element) => ({ gap: element.scrollHeight - element.clientHeight - element.scrollTop, jumpVisible: Boolean(document.querySelector<HTMLElement>('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]')?.getClientRects().length) }));
  if (jumpedBeforeRelease.gap > 4 || jumpedBeforeRelease.jumpVisible)
    throw new Error(`jump to latest did not land before releasing held chunks: ${JSON.stringify(jumpedBeforeRelease)}\njump diagnostics: ${JSON.stringify(await jumpDiagnostics())}`);
  const heldJumpControl = JSON.parse(await Bun.file(controlPath).text());
  await writeControl(controlPath, { ...heldJumpControl, release_jump_stream_barrier: true });
  await waitForJump(async () => (await textStream.innerText()).includes("text-only line 081"), "several chunks after jump");
  const jumpedAfterRelease = await scroll.evaluate((element) => ({ gap: element.scrollHeight - element.clientHeight - element.scrollTop, jumpVisible: Boolean(document.querySelector('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]')?.getClientRects().length) }));
  if (jumpedAfterRelease.gap > 4 || jumpedAfterRelease.jumpVisible)
    throw new Error(`mid-stream jump did not stay at bottom after several chunks: ${JSON.stringify(jumpedAfterRelease)}`);
  await waitForJump(async () => await distanceFromBottom() <= 4 && await page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible').count() === 0, "jump to latest for this turn");
  const jumped = await scroll.evaluate((element) => ({ gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
  if (jumped.gap > 4 || await page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible').count() !== 0)
    throw new Error(`mid-stream jump did not resume following: ${JSON.stringify(jumped)}`);
  await waitForJump(async () => (await textStream.innerText()).includes("text-only line 100") && await distanceFromBottom() <= 4, "mid-stream jump resumes following");
  if (await page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible').count() !== 0)
    throw new Error("mid-stream jump to latest control stayed visible after returning to the bottom");
  await capture("streaming-midstream-jump-1440x900.png");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await waitForJump(async () => (await textStream.innerText()).includes("text-only line 119") && await distanceFromBottom() <= 4 && await page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible').count() === 0, "text-only stream completes at the bottom after jump");
  const finalJump = await scroll.evaluate((element) => ({ gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
  if (finalJump.gap > 4 || await page.locator('[data-part="jump-to-latest-lane"][data-jump-owned="true"] [data-part="jump-to-latest"]:visible').count() !== 0)
    throw new Error(`final text-only stream did not settle at the bottom: ${JSON.stringify(finalJump)}`);
  await waitForIdleTurn(page, waitFor);
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
    // gate step 3: the url named this tab's chat (`?chat=`), so the reload reclaimed the same session, not the page's newest.
    if (new URL(page.url()).searchParams.get("chat") !== sessionId || await page.locator("[data-session-id]").first().getAttribute("data-session-id") !== sessionId)
      throw new Error(`reload mid-turn did not reclaim session ${sessionId}: ${page.url()}`);
    const helloAfter = requests().slice(framesBeforeReload).findLast((frame) => frame.result?.capabilities?.features);
    if (!helloAfter?.result?.capabilities?.features?.includes("multi_controller")) throw new Error("reloaded tab's hello did not echo multi_controller");
    // the kept turn is still streaming (line 079 lands seconds later): the page shows it running, steerable, and stoppable
    const composer = page.locator('[data-part="composer"]');
    const turnEnded = async () => (await messages.filter({ hasText: "reload line 079" }).count()) > 0;
    const runningWithStop = async () => (await composer.getAttribute("data-state")) === "steerable" && (await composer.locator('[data-part="composer-stop"]').count()) === 1;
    await waitFor(async () => !(await turnEnded()) && await runningWithStop(), "kept turn shown running with a stop control after reload").catch(async (error) => {
      throw new Error(`${error}\nafter reload: ${JSON.stringify({ composer: await composer.getAttribute("data-state"), stop: await composer.locator('[data-part="composer-stop"]').count(), ended: await turnEnded() })}`);
    });
    // the reply streams on the reloaded page: a later line shows before the turn ends, not only at its final commit.
    // the text streamed before the reload shows with it, once (`in_flight_replay`); one read of the reply messages
    let streaming: string[] = [];
    await waitFor(async () => { streaming = await messages.filter({ hasText: "reload line 0" }).allInnerTexts(); return streaming.some((text) => text.includes("reload line 050")); }, "reply streaming after reload");
    if (streaming.some((text) => text.includes("reload line 079")) || !(await runningWithStop())) throw new Error("reload line 050 showed only after the turn ended, not while it streamed");
    const shown = Array.from({ length: 51 }, (_, index) => streaming.join("\n").split(`reload line ${String(index).padStart(3, "0")}`).length - 1);
    if (streaming.length !== 1 || shown.some((count) => count !== 1))
      throw new Error(`while the reply streamed after the reload, lines 000-050 showed ${JSON.stringify(shown)} times in ${streaming.length} messages, not once each in one`);
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
    if (requests().slice(framesBeforeReload).some((frame) => JSON.stringify(frame).includes("session_controlled"))) throw new Error("reload mid-turn was refused as session_controlled");
    const cancelled = requests().slice(framesBeforeReload).some((frame) => JSON.stringify(frame).includes('"reason":"disconnect"'));
    if (cancelled) throw new Error("zeta cancelled the turn on reload (reason disconnect)");
    if (await page.getByRole("alert").count()) throw new Error(`reload mid-turn showed a notice: ${await page.getByRole("alert").first().innerText()}`);
    console.log("reload mid-turn asserted: the reloaded page took over the running turn and showed it running, stoppable, and streaming; one reply, 80 lines once each, no warning, no notice");
  } finally {
    page.off("dialog", onDialog);
  }
}

/**
 * gate step 1: every tab is its own zeta controller. tab A starts a new chat; tab B opens another chat by its url.
 * both send in the same moment: zeta accepts both and runs both turns, and each tab shows only its own reply.
 */
export async function gateTwoChatsAtOnce(browser: Browser, origin: string, otherChatUrl: string) {
  if (!new URL(otherChatUrl).searchParams.get("chat")) throw new Error(`two-chat step needs a chat url: ${otherChatUrl}`);
  const tabs = [await browser.newPage(), await browser.newPage()] as const;
  const features: string[][] = [[], []];
  const sends: { tab: number; id: unknown; at: number }[] = [];
  const replies: { tab: number; id: unknown; accepted: boolean }[] = [];
  const firstReplyAt: number[] = [];
  const controlled: number[] = [0, 0];
  tabs.forEach((tab, index) => tab.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try { const frame = JSON.parse(String(payload)); if (frame.method === "send") sends.push({ tab: index, id: frame.id, at: performance.now() }); } catch { /* not json */ }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (Array.isArray(frame.result?.capabilities?.features)) features[index]!.push(...frame.result.capabilities.features);
        if (frame.error?.data?.code === "session_controlled") controlled[index] = (controlled[index] ?? 0) + 1;
        const send = sends.find((row) => row.tab === index && row.id === frame.id && frame.method === undefined);
        if (send) replies.push({ tab: index, id: frame.id, accepted: Object.hasOwn(frame, "result") });
        if (frame.method === "event" && String(payload).includes("you said: together") && firstReplyAt[index] === undefined) firstReplyAt[index] = performance.now();
      } catch { /* not json */ }
    });
  }));
  const [a, b] = tabs;
  const field = (tab: Page) => tab.getByRole("textbox", { name: "message", exact: true });
  const wait = { timeout: 20_000 };
  try {
    await a.goto(origin);
    // let tab a's default attach settle first: a click while it loads used to be dropped, leaving tab a on the other chat
    await a.locator("[data-session-id]").first().waitFor({ state: "attached", ...wait });
    const newChat = a.getByRole("button", { name: "new chat", exact: true });
    await newChat.and(a.locator(":enabled")).waitFor(wait);
    const shownBefore = await a.locator("[data-session-id]").first().getAttribute("data-session-id");
    await newChat.click(wait);
    // the shown chat stays usable until the new chat lands: type once the new chat is on screen
    await a.waitForFunction((old) => { const id = document.querySelector("[data-session-id]")?.getAttribute("data-session-id"); return Boolean(id) && id !== old; }, shownBefore, wait);
    await field(a).fill("first message in tab a", wait);
    await field(a).press("Enter", wait);
    await a.getByText("you said: first message in tab a", { exact: true }).waitFor(wait);
    // the other chat's tab closed just before this step, and zeta may not have handled that socket close yet: the
    // app's own bounded `resume` retry covers that race, so one load must open the chat writable
    await b.goto(otherChatUrl);
    await b.locator("[data-session-id]").first().waitFor({ state: "attached", ...wait });
    await field(b).waitFor(wait);
    if (await b.getByText(SAME_CHAT_NOTICE).count()) throw new Error(`tab b's chat stayed session_controlled after the app's retries (${controlled[1]} refusals)`);
    if (!await field(b).isEditable()) throw new Error("tab b opened its chat read-only");
    if (controlled[1]) console.log(`two tabs: tab b's load met session_controlled ${controlled[1]} time(s) while zeta released the closed tab; the app's retry opened it`);
    const chats = await Promise.all(tabs.map((tab) => tab.locator("[data-session-id]").first().getAttribute("data-session-id")));
    if (!chats[0] || !chats[1] || chats[0] === chats[1]) throw new Error(`two tabs did not open two chats: ${JSON.stringify(chats)}`);
    await field(a).fill("together from a", wait);
    await field(b).fill("together from b", wait);
    const before = sends.length;
    await Promise.all(tabs.map((tab) => field(tab).press("Enter", wait)));
    await Promise.all([a.getByText("you said: together from a", { exact: true }).waitFor(wait), b.getByText("you said: together from b", { exact: true }).waitFor(wait)]);
    const together = sends.slice(before);
    const accepted = together.map((send) => replies.find((reply) => reply.tab === send.tab && reply.id === send.id)?.accepted);
    if (together.length !== 2 || new Set(together.map((send) => send.tab)).size !== 2 || accepted.some((value) => value !== true))
      throw new Error(`both sends were not accepted: ${JSON.stringify({ together, accepted })}`);
    // each scripted turn takes at least 100 ms, so both sends going out before either reply means the turns overlapped.
    const lastSend = Math.max(...together.map((send) => send.at));
    if (firstReplyAt.length !== 2 || lastSend > Math.min(...firstReplyAt)) throw new Error(`the two turns did not run at once: ${JSON.stringify({ sends: together.map((send) => send.at), firstReplyAt })}`);
    if (await a.getByText("together from b").count() || await b.getByText("together from a").count()) throw new Error("a tab showed the other tab's chat");
    const missing = features.map((list, index) => list.includes("multi_controller") ? null : index).filter((index) => index !== null);
    if (missing.length) throw new Error(`hello did not echo multi_controller for tab ${missing.join(", ")}`);
    console.log("two tabs: two chats sent at once, zeta ran both turns, each tab showed only its own reply, both hellos echoed multi_controller");
    await gateSameChatReadOnly(browser, a);
    await gateBranchAcrossTabs(a);
  } finally { await Promise.all(tabs.map((tab) => tab.close())); }
}

const SAME_CHAT_NOTICE = "this chat is open or kept running in another tab. you can read it here.";

/**
 * gate step 2: tab C opens the chat tab A controls. zeta refuses C's `resume` (session_controlled) and C reads the chat
 * live: the notice shows, the composer is read-only, the transcript is there, and A's next reply streams into C. after
 * the refusal C never sends the page credential or a page binding.
 */
async function gateSameChatReadOnly(browser: Browser, a: Page) {
  const wait = { timeout: 20_000 };
  const c = await browser.newPage();
  const sent: { method?: string; id?: unknown; raw: string }[] = [];
  const refused = new Set<unknown>();
  const refusals: string[] = [];
  c.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => { const raw = String(payload); try { const frame = JSON.parse(raw); sent.push({ method: frame.method, id: frame.id, raw }); } catch { sent.push({ raw }); } });
    socket.on("framereceived", ({ payload }) => { try { const frame = JSON.parse(String(payload)); if (frame.error?.data?.code === "session_controlled") { refused.add(frame.id); refusals.push(String(payload)); } } catch { /* not json */ } });
  });
  try {
    const url = new URL(a.url());
    const chat = url.searchParams.get("chat");
    if (!chat) throw new Error(`tab a's url names no chat: ${a.url()}`);
    await c.goto(url.href);
    await c.getByText(SAME_CHAT_NOTICE, { exact: true }).waitFor(wait);
    const field = c.getByRole("textbox", { name: "message", exact: true });
    if (await field.isEditable()) throw new Error("tab c can write to the chat tab a controls");
    await c.getByText("you said: together from a", { exact: true }).waitFor(wait);
    if (await c.getByRole("button", { name: "take control" }).count()) throw new Error("tab c offered a take-over zeta does not support");
    if (!await c.getByRole("button", { name: "new chat", exact: true }).first().isEnabled()) throw new Error("tab c's new chat is off");
    // try again while tab a still holds the chat: zeta refuses again, and the notice says the chat is still held
    await c.getByRole("button", { name: "try again", exact: true }).click(wait);
    await c.getByText("still open or kept running in another tab. you can read it here.", { exact: true }).waitFor(wait);
    if (await field.isEditable()) throw new Error("tab c's try again made the held chat writable");
    const composer = a.getByRole("textbox", { name: "message", exact: true });
    await composer.fill("after tab c joined", wait);
    await composer.press("Enter", wait);
    await c.getByText("you said: after tab c joined", { exact: true }).waitFor(wait);
    const credential = await c.evaluate(async () => {
      const page = await (await fetch("/api/pages/home", { cache: "no-store" })).json() as { id: string };
      const shell = document.querySelector<HTMLMetaElement>('meta[name="achilles-shell"]')!.content;
      return (await (await fetch(`/api/pages/${page.id}/credential`, { headers: { "X-Achilles-Shell": shell }, cache: "no-store" })).json() as { credential: string }).credential;
    });
    const resumes = sent.filter((frame) => frame.method === "resume");
    if (!resumes.length || resumes.some((frame) => !refused.has(frame.id))) throw new Error(`tab c's resume was not refused session_controlled: ${resumes.length} sent, ${refused.size} refused`);
    // zeta never echoes a binding: the refusal names only the session (and, optionally, bounded holder facts)
    if (refusals.some((raw) => raw.includes(credential) || raw.includes("Authorization") || raw.includes("mcp_bindings"))) throw new Error("a session_controlled refusal echoed the page binding");
    const after = sent.slice(sent.lastIndexOf(resumes.at(-1)!) + 1);
    if (!after.some((frame) => frame.method === "session_history_and_subscribe" && frame.raw.includes(chat))) throw new Error("tab c did not join tab a's chat after the refusal");
    const leak = after.find((frame) => frame.raw.includes(credential) || frame.raw.includes("mcp_bindings") || frame.method === "resume");
    if (leak) throw new Error(`tab c sent a page binding after the refusal: ${leak.method ?? "frame"}`);
    console.log(`same chat in two tabs: tab c got session_controlled (${resumes.length} resume tries), read the chat live with the notice and a read-only composer, saw tab a's next reply, and sent no page binding after the refusal`);
  } finally { await c.close(); }
}
