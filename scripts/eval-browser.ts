import type { ReloadTrigger, TaskStep } from "./eval-grade";
import type { EvalProtocol } from "./eval-protocol";
import { createFrameRing } from "./gate-diagnostics";

// Drives browser_prompt steps through the real web page: the page is zeta's controller, so its own composer sends the
// prompt, its own approval card takes the decision, and a reload is a real page reload. The harness only watches,
// as a zeta observer, and acts on structured events: the n-th matching event fires the reload, an approval_request
// queues a click. Every page action runs in order on one chain, so a reload queued before a click happens first.

type Frame = { socket: number; direction: "sent" | "received"; value: Record<string, any> };
type Tab = { page: any; frames: Frame[]; sockets: number; sessionId: string; chat: string; pageId: string; ends: number; onFrame: Set<() => void>; ring: ReturnType<typeof createFrameRing> };
type Armed = { step: TaskStep; tab: Tab; count: number; row: Record<string, unknown> };
export type BrowserDriver = ReturnType<typeof createBrowserDriver>;

const READY_MS = 20_000;
const log = (line: string) => process.stderr.write(`eval browser: ${line}\n`);
const SETTINGS_KEY = "achilles-settings";
const toolName = (event: Record<string, any>) => event.data?.tool_call?.name ?? event.tool_call?.name ?? event.data?.name;
const userText = (row: any) => row.role === "user" ? JSON.stringify(row.content ?? "") : "";
// the turn of every text the step sent has ended: each text is in a user row, and a served_turn_end follows the last one
export function stepFinished(history: any[], prior: number, texts: string[]) {
  const ends = history.flatMap((row, index) => row.event === "served_turn_end" ? [index] : []);
  if (ends.length <= prior) return false;
  const sent = texts.map(text => history.findLastIndex(row => userText(row).includes(JSON.stringify(text).slice(1, -1))));
  return sent.every(index => index >= 0) && ends.at(-1)! > Math.max(...sent);
}
// shortcut: compares the answer's longest line with markdown marks and spacing removed against the page text; a reply
// whose longest line is a table or code block may need a better probe if this ever reports a false miss
// marks are deleted, not spaced: `**name**:` renders as `name:`, so a space in its place would never match the page
export const plainText = (text: string) => text.replace(/[*_#`>|[\]()~-]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
export function answerProbe(answer: string) {
  const line = answer.split("\n").map(plainText).sort((a, b) => b.length - a.length)[0] ?? "";
  return line.slice(0, 60).trim();
}

export function createBrowserDriver(options: { chromium: any; origin: string; ask: boolean; signal: AbortSignal; observer: () => EvalProtocol; failure: () => Error | undefined }) {
  let browser: any; let chain: Promise<unknown> = Promise.resolve(); let chainError: unknown;
  const tabs = new Map<string, Tab>(); const bySession = new Map<string, Tab>(); const reloads: Record<string, unknown>[] = [];
  const seenRequests = new Set<unknown>(); let armed: Armed | undefined; let wake: () => void = () => {};
  const queue = (action: () => Promise<void>) => { chain = chain.then(action).catch(error => { chainError ??= error; wake(); }); };

  async function ready(tab: Tab) {
    await tab.page.getByRole("textbox", { name: "message", exact: true }).waitFor({ timeout: READY_MS });
    await tab.page.locator('.connection-state, .connection-banner, [role="status"]:has-text("loading chat…")').waitFor({ state: "hidden", timeout: READY_MS });
  }
  // types into the page's own composer; a missing composer names what the page shows instead, for diagnosis
  async function type(tab: Tab, text: string) {
    const field = tab.page.getByRole("textbox", { name: "message", exact: true });
    try { await field.fill(text); } catch (error) {
      const shown = await tab.page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      throw new Error(`${(error as Error).message.split("\n")[0]}; the page shows: ${JSON.stringify(shown.replace(/\s+/g, " ").slice(-600))}`);
    }
    await field.press("Enter");
  }
  // a new chat has no zeta session until its first message, so the id is read after a send
  const shownSession = (tab: Tab) => tab.page.locator("[data-session-id]").getAttribute("data-session-id", { timeout: READY_MS }) as Promise<string | null>;
  async function open(step: TaskStep, pageId: string, route: string) {
    const existing = tabs.get(step.chat); if (existing) return existing;
    browser ??= await options.chromium.launch({ headless: true });
    const context = await browser.newContext(); context.setDefaultTimeout(READY_MS);
    if (options.ask) await context.addInitScript(([key]: string[]) => localStorage.setItem(key, JSON.stringify({ autoApproveDefault: false })), [SETTINGS_KEY]);
    const page = await context.newPage(); const tab: Tab = { page, frames: [], sockets: 0, sessionId: "", chat: step.chat, pageId, ends: 0, onFrame: new Set(), ring: createFrameRing(60) };
    page.on("websocket", (socket: any) => {
      const id = ++tab.sockets;
      const record = (direction: Frame["direction"]) => (event: { payload: unknown }) => { tab.ring.record(id, direction, String(event.payload)); try { tab.frames.push({ socket: id, direction, value: JSON.parse(String(event.payload)) }); } catch { return; } for (const listener of tab.onFrame) listener(); };
      socket.on("framesent", record("sent")); socket.on("framereceived", record("received"));
    });
    await page.goto(`${options.origin}${route}`, { waitUntil: "domcontentloaded", timeout: READY_MS });
    await ready(tab); tabs.set(step.chat, tab); return tab;
  }
  // the reloaded page's `resume` of this chat and zeta's answer to it, on the page's newest socket
  function resumeAnswer(tab: Tab, after: number) {
    const frames = tab.frames.slice(after);
    const request = frames.find(frame => frame.direction === "sent" && frame.value.method === "resume" && frame.value.params?.session_id === tab.sessionId);
    return request && frames.find(frame => frame.socket === request.socket && frame.direction === "received" && frame.value.id === request.value.id && (frame.value.result || frame.value.error));
  }
  async function reload(step: TaskStep, tab: Tab, row: Record<string, unknown>) {
    const before = tab.frames.length; const ends = tab.ends; row.fired = true; row.session_before = tab.sessionId; log(`${step.id}: reload at ${JSON.stringify(step.reload)}`);
    await tab.page.reload({ waitUntil: "domcontentloaded", timeout: READY_MS });
    await ready(tab); row.session_after = await shownSession(tab);
    const answer = await waitFrame(tab, () => resumeAnswer(tab, before));
    row.attached = answer?.value.result?.attached ?? null; if (answer?.value.error) row.resume_error = answer.value.error;
    // zeta answers a plain resume (no `attached`) only when no turn runs, so the turn ended before the page came back
    row.turn_ended_before_attach = tab.ends > ends || Boolean(answer?.value.result && !answer.value.result.attached);
    if (step.follow_up) {
      await type(tab, step.follow_up); row.follow_up_sent = true;
    }
    if (step.new_chat) await newChat(tab, step.new_chat, row);
  }
  // the reloaded page took over the running chat; the user clicks "new chat" and sends text written for that new chat.
  // records every send or steer of that text and whether the page still shows it, then goes back to the running chat
  // the way a user would ("open it" on the notice), so the turn's approvals can still be answered on its card
  async function newChat(tab: Tab, text: string, row: Record<string, unknown>) {
    const before = tab.frames.length;
    await tab.page.getByRole("button", { name: "new chat" }).first().click();
    // done when the page shows why no chat started, or a new chat's empty view
    await tab.page.locator('.create-mode-alert:has-text("still running"), .empty-chat').first().waitFor({ timeout: READY_MS });
    await ready(tab); await type(tab, text); row.new_chat_typed = true;
    // the page answers an Enter at once: a send, a steer, or a failed row; zeta answers a request within this wait
    await tab.page.waitForTimeout(2_000);
    // read when the record is graded, so a send of the text that comes later (at the turn's end) counts too
    Object.defineProperty(row, "new_chat_sent", { enumerable: true, get: () => tab.frames.slice(before).filter(frame => frame.direction === "sent" && ["send", "steer"].includes(frame.value.method) && frame.value.params?.text === text).map(frame => ({ method: frame.value.method, session_id: frame.value.params.session_id })) });
    row.new_chat_visible = (await tab.page.locator("#message-composer").innerText()).includes(text) || (await tab.page.getByRole("textbox", { name: "message", exact: true }).inputValue()).includes(text);
    const open = tab.page.locator(".create-mode-alert").getByRole("button", { name: "open it" });
    if (await open.count()) { await open.click(); await ready(tab); }
  }
  // a frame the page already has, or the first matching one it receives before the ready deadline
  function waitFrame(tab: Tab, find: () => Frame | undefined) {
    return new Promise<Frame | undefined>(resolve => {
      const done = () => { const found = find(); if (!found) return; finish(found); };
      const finish = (found: Frame | undefined) => { clearTimeout(timer); tab.onFrame.delete(done); resolve(found); };
      const timer = setTimeout(() => finish(undefined), READY_MS); tab.onFrame.add(done); done();
    });
  }

  return {
    reloads,
    // the page's last websocket frames per chat, as safe summaries (method, event, ids, error codes), for diagnosis
    frames: () => Object.fromEntries([...tabs].map(([chat, tab]) => [chat, tab.ring.snapshot()])),
    sessionOf: (chat: string) => tabs.get(chat)?.sessionId,
    // fed every observer event, before the harness answers approvals
    onEvent(event: Record<string, any>) {
      const tab = bySession.get(event.session_id);
      // zeta announces a pending approval again when the reloaded page attaches; count each request once
      if (event.event === "approval_request" && seenRequests.has(event.request_id ?? event.data?.request_id)) return;
      if (event.event === "approval_request") seenRequests.add(event.request_id ?? event.data?.request_id);
      if (armed && tab === armed.tab && event.event === armed.step.reload!.on && (!armed.step.reload!.tool || toolName(event) === armed.step.reload!.tool) && ++armed.count === (armed.step.reload!.nth ?? 1)) { const { step, row } = armed; armed = undefined; queue(() => reload(step, tab, row)); }
      if (tab && event.event === "served_turn_end") tab.ends++;
      if (tab && ["served_turn_end", "turn_end", "turn_aborted", "agent_end", "error"].includes(event.event)) wake();
    },
    decide(sessionId: string, requestId: string, decision: "approve" | "deny") {
      const tab = bySession.get(sessionId); if (!tab) return;
      queue(async () => {
        const card = tab.page.locator('[data-part="approval"][data-state="pending"]').first();
        try { await card.getByRole("button", { name: decision, exact: true }).click({ timeout: READY_MS }); }
        catch (error) { throw new Error(`approval card for request ${requestId} did not show on the page: ${(error as Error).message.split("\n")[0]}`); }
      });
    },
    wake: () => wake(),
    // `register` names the page's chat before the observer joins it, so its approval requests find their chat
    async prompt(step: TaskStep, pageId: string, route: string, register: (sessionId: string) => void, replay: (event: Record<string, unknown>) => void) {
      const tab = await open(step, pageId, route); const observer = options.observer(); log(`${step.id}: sending the prompt through the page`);
      const prior = tab.sessionId ? (await observer.sessionHistory(tab.sessionId)).filter((row: any) => row.event === "served_turn_end").length : 0;
      if (step.reload) {
        const trigger: ReloadTrigger = step.reload; const row: Record<string, unknown> = { step: step.id, page_id: pageId, chat_id: step.chat, trigger, fired: false };
        reloads.push(row); armed = { step, tab, count: 0, row };
      }
      await type(tab, step.prompt!);
      const aborted = new Promise<never>((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })); aborted.catch(() => undefined);
      // a new chat has its zeta session only once the page sends; the observer joins it then
      // shortcut: an event between the send and the join is not seen live; a model reply takes far longer than the join.
      // an approval request in that gap (a scripted model asks at once) is still pending, so it is replayed from the join
      if (!tab.sessionId) {
        const shown = await shownSession(tab); if (!shown) throw new Error(`browser page ${route} shows no chat after the first message`);
        tab.sessionId = shown; bySession.set(shown, tab); register(shown);
        const joined = await observer.subscribe(shown) as { status?: { pending_approvals?: Array<Record<string, unknown>> } };
        for (const request of joined?.status?.pending_approvals ?? []) replay({ event: "approval_request", session_id: shown, ...request });
      }
      const texts = [step.prompt!]; let history: any[] = [];
      for (;;) {
        const woken = new Promise<void>(resolve => { wake = resolve; });
        options.signal.throwIfAborted(); const failure = options.failure(); if (failure) throw failure; if (chainError) throw chainError;
        await chain;
        const row = reloads.find(item => item.step === step.id);
        if (row?.follow_up_sent && !texts.includes(step.follow_up!)) texts.push(step.follow_up!);
        history = await observer.sessionHistory(tab.sessionId);
        const status = await observer.status();
        if (stepFinished(history, prior, texts) && !(row?.fired && step.follow_up && !row.follow_up_sent) && (status.state === "idle" || status.session?.session_id !== tab.sessionId)) break;
        await Promise.race([woken, aborted]);
      }
      armed = undefined; await chain; if (chainError) throw chainError; log(`${step.id}: turn ended`);
      const row = reloads.find(item => item.step === step.id);
      return { sessionId: tab.sessionId, prior, history, check: async (answer: string | undefined) => {
        if (!row?.fired) return;
        const probe = answer ? answerProbe(answer) : "";
        // the page side repeats plainText: a function passed to the page cannot close over this module
        row.answer_visible = Boolean(probe) && await tab.page.waitForFunction((needle: string) => (document.querySelector(".transcript") as HTMLElement | null)?.innerText.replace(/[*_#`>|[\]()~-]/g, "").replace(/\s+/g, " ").toLowerCase().includes(needle), probe, { timeout: 10_000 }).then(() => true, () => false);
      } };
    },
    // a turn-cap or failure stop: press the page's own stop button, so nothing keeps running for the page
    async stop() { for (const tab of tabs.values()) await tab.page.locator('[data-part="composer-stop"]').click({ timeout: 2_000 }).catch(() => undefined); },
    // a browser that does not close in time is killed with its process, so a stuck page never holds the run
    async close() {
      const closing = browser; browser = undefined; if (!closing) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([closing.close().then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), READY_MS); })]).finally(() => clearTimeout(timer));
      if (!closed) closing.process?.()?.kill("SIGKILL");
    },
  };
}
