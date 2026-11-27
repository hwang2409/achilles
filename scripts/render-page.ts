// render_page runner: loads one page's real frame in headless chromium behind a read-only copy of the
// shell bridge and prints one bounded JSON result. stdin: {origin, pageId, credential, timeoutMs}.
import { chromium } from "../apps/web/node_modules/playwright/index.mjs";

const MAX_ITEMS = 20;
const MAX_ITEM = 400;
const MAX_TEXT = 4000;
const MAX_IMAGE = 1024 * 1024;
const WRITE_BLOCKED = "writes are blocked during render_page; nothing was saved";

type Input = { origin: string; pageId: string; credential: string; timeoutMs: number };
const input: Input = JSON.parse(await Bun.stdin.text());

const clip = (value: string, limit = MAX_ITEM) => (value.length > limit ? `${value.slice(0, limit)}... (${value.length - limit} more chars)` : value);
function bounded() {
  const items: string[] = [];
  let omitted = 0;
  return { items, add: (value: string) => (items.length < MAX_ITEMS ? items.push(clip(value)) : omitted++), done: () => (omitted ? [...items, `... ${omitted} more`] : items) };
}
const consoleErrors = bounded(), pageErrors = bounded(), failedRequests = bounded();

// the host mirrors the shell's PageFrame bridge: same iframe sandbox, records list reads real data, writes are refused
const hostPath = `/__achilles_render__/${encodeURIComponent(input.pageId)}`;
const host = `<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style>
<iframe sandbox="allow-scripts allow-forms allow-downloads" src="/api/pages/${encodeURIComponent(input.pageId)}/frame"></iframe>
<script>
const pageId=${JSON.stringify(input.pageId)}, credential=${JSON.stringify(input.credential)}, frame=document.querySelector("iframe");
window.__render={pending:0,calls:[],rejections:[]};
addEventListener("message", async event => {
  const m = event.data;
  if (event.source !== frame.contentWindow || !m || m.pageId !== pageId || typeof m.requestId !== "string") return;
  const reply = (ok, result) => frame.contentWindow.postMessage({ requestId: m.requestId, ok, result }, "*");
  const where = m.method + " " + m.collection;
  __render.calls.push(where);
  if (m.method !== "list") { __render.rejections.push(where + ": ${WRITE_BLOCKED}"); reply(false, { detail: "${WRITE_BLOCKED}" }); return; }
  __render.pending++;
  try {
    const response = await fetch("/api/pages/" + encodeURIComponent(pageId) + "/records/" + encodeURIComponent(m.collection), { headers: { authorization: "Bearer " + credential } });
    const body = await response.json();
    if (!response.ok) __render.rejections.push(where + ": " + (body.detail ?? response.status));
    reply(response.ok, body);
  } catch (caught) { __render.rejections.push(where + ": " + caught); reply(false, { detail: String(caught) }); }
  finally { __render.pending--; }
});
</script>`;

const result: Record<string, unknown> = { ready: false, writes: WRITE_BLOCKED };
let timedOut = false;
const browser = await chromium.launch({ headless: true });
const deadline = new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, input.timeoutMs));
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.route(`${input.origin}${hostPath}`, (route) => route.fulfill({ contentType: "text/html", body: host }));
  page.on("console", (message) => { if (message.type() === "error") { const at = message.location(); consoleErrors.add(`${message.text()} (${at.url}:${at.lineNumber + 1})`); } });
  page.on("pageerror", (error) => pageErrors.add(error.stack || String(error)));
  page.on("requestfailed", (request) => failedRequests.add(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
  page.on("response", (response) => { if (response.status() >= 400) failedRequests.add(`${response.request().method()} ${response.url()}: HTTP ${response.status()}`); });

  const render = async () => {
    await page.goto(`${input.origin}${hostPath}`, { waitUntil: "load" });
    const frame = page.frames().find((item) => item !== page.mainFrame());
    if (!frame) throw new Error("the page frame did not load");
    // ready = network idle, no bridge read in flight, and two painted frames after that; repeat if a paint started more work
    for (let round = 0; round < 5; round++) {
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(() => (window as any).__render.pending === 0);
      await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (await page.evaluate(() => (window as any).__render.pending === 0)) break;
    }
    result.ready = true;
    result.text = clip(await frame.evaluate(() => document.body?.innerText ?? ""), MAX_TEXT);
    await screenshot();
  };
  const screenshot = async (timeout?: number) => {
    for (const quality of [70, 35]) {
      const image = await page.screenshot({ type: "jpeg", quality, timeout });
      if (image.length <= MAX_IMAGE) { result.screenshot = image.toString("base64"); return; }
    }
    result.screenshot_note = `screenshot larger than ${MAX_IMAGE} bytes; omitted`;
  };
  await Promise.race([render().catch((caught) => { if (!timedOut) result.error = clip(String(caught?.message ?? caught)); }), deadline]);
  if (timedOut) {
    result.error = `the page did not finish rendering within ${input.timeoutMs / 1000} s`;
    // a polling page never goes network-idle; if the renderer still answers, show what it has
    await screenshot(2000).then(() => { if (result.screenshot) result.note = "page never went network-idle; screenshot taken at the deadline"; }, () => {});
  }
  const state = await Promise.race([page.evaluate(() => (window as any).__render).catch(() => null), new Promise((resolve) => setTimeout(resolve, 1000, null))]) as { calls: string[]; rejections: string[] } | null;
  const calls = bounded(), rejections = bounded();
  for (const call of state?.calls ?? []) calls.add(call);
  for (const rejection of state?.rejections ?? []) rejections.add(rejection);
  Object.assign(result, { timed_out: timedOut, console_errors: consoleErrors.done(), page_errors: pageErrors.done(), failed_requests: failedRequests.done(), bridge_calls: calls.done(), bridge_rejections: rejections.done() });
} finally {
  await browser.close(); // closing the browser process also ends a hung renderer
}
// exit drops a pipe write that has not flushed, so wait for it
await new Promise((resolve) => process.stdout.write(JSON.stringify(result), resolve));
process.exit(0);
