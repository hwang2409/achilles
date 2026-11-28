import { join } from "node:path";
import type { Browser } from "../apps/web/node_modules/playwright";
import { sessionOwned } from "../apps/web/src/chat/continuation";

export const graceArtifacts = ["grace-continue-1440.png", "grace-continue-390.png"];
type Frame = { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };

// a controller tab opens a chat and closes; within zeta's 90 s idle reconnect grace the sessions view marks the row
// resident, keeps "continue in chat" enabled with no "another zeta process" notice, and continue reclaims the session.
export async function gateGraceContinue(browser: Browser, origin: string, screenshots?: string) {
  const wait = { timeout: 20_000 };
  const a = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const field = a.getByRole("textbox", { name: "message", exact: true });
  let id: string | null = null;
  try {
    await a.goto(`${origin}/#new-chat`);
    await field.fill("grace message", wait);
    await field.press("Enter", wait);
    await a.getByText("you said: grace message", { exact: true }).waitFor(wait);
    id = await a.locator(".chat-header [data-session-id]").getAttribute("data-session-id", wait);
  } finally {
    await a.close();
  }
  if (!id) throw new Error("grace: the closed tab's chat has no session id");
  const closedAt = performance.now();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  tab.setDefaultTimeout(20_000);
  const frames: Frame[] = [];
  tab.on("websocket", (socket) => {
    const record = ({ payload }: { payload: string | Buffer }) => { try { frames.push(JSON.parse(String(payload))); } catch { /* not json */ } };
    socket.on("framesent", record);
    socket.on("framereceived", record);
  });
  try {
    await tab.goto(`${origin}/sessions/${id}`);
    const button = tab.getByRole("button", { name: "continue in chat", exact: true });
    await button.and(tab.locator(":enabled")).waitFor();
    const row = frames.flatMap((frame) => (frame.result?.sessions as Record<string, unknown>[] | undefined) ?? []).find((item) => item.session_id === id);
    if (row?.in_use !== true || row.resident !== true) throw new Error(`grace: list_sessions did not mark the closed tab's session in use and resident: ${JSON.stringify(row ?? null)}`);
    if (await tab.getByText(sessionOwned).count()) throw new Error("grace: the sessions view says another zeta process holds this serve's own session");
    if (screenshots) {
      await tab.screenshot({ path: join(screenshots, "grace-continue-1440.png"), fullPage: true });
      const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await narrow.goto(`${origin}/sessions/${id}`);
        await narrow.getByRole("button", { name: "continue in chat", exact: true }).and(narrow.locator(":enabled")).waitFor(wait);
        await narrow.screenshot({ path: join(screenshots, "grace-continue-390.png"), fullPage: true });
      } finally {
        await narrow.close();
      }
    }
    await button.click();
    const composer = tab.getByRole("textbox", { name: "message", exact: true });
    await tab.waitForURL((url) => url.searchParams.get("chat") === id);
    await composer.waitFor();
    const resumed = frames.find((frame) => frame.method === "resume" && frame.params?.session_id === id);
    const reply = resumed && frames.find((frame) => frame.method === undefined && frame.id === resumed.id && (frame.result || frame.error));
    if (!reply?.result) throw new Error(`grace: continue did not reclaim the session: ${JSON.stringify(reply ?? null)}`);
    if (!await composer.isEditable()) throw new Error("grace: the continued chat opened read-only");
    const seconds = (performance.now() - closedAt) / 1000;
    if (seconds >= 90) throw new Error(`grace: the check took ${seconds.toFixed(1)} s, past zeta's 90 s grace, so it proves nothing`);
    console.log(`grace: ${seconds.toFixed(1)} s after the tab closed, the resident row kept continue enabled with no owned notice; continue reclaimed ${id}`);
  } finally {
    await tab.close();
  }
}
