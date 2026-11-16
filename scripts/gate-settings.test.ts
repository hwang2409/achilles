import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { assertServerAskWins } from "./gate-settings";

type Frame = { method?: string; params?: { session_id?: string }; id?: unknown; result?: { approval_mode?: string } };

const id = "ask-session";
const page = { getByLabel: () => ({ count: async () => 0 }) } as unknown as Page;

// the frame order from run 43881659122: a resume re-fetched session_settings (id 11) before its reply arrived
async function check(lateMode: string) {
  const frames: Frame[] = [
    { id: 5, method: "session_settings", params: { session_id: id } },
    { id: 5, result: { approval_mode: "ask" } },
    { id: 11, method: "session_settings", params: { session_id: id } },
  ];
  const inFlight: Frame[] = [{ id: 11, result: { approval_mode: lateMode } }];
  const approvalModeResponse = (method: string, sessionId: string) => {
    const request = frames.findLast((frame) => frame.method === method && frame.params?.session_id === sessionId);
    return frames.slice(frames.indexOf(request!) + 1).find((frame) => frame.id === request?.id && frame.result)?.result?.approval_mode;
  };
  // each failed check delivers the next in-flight frame, so arrival order is explicit and nothing sleeps
  const waitFor = async (ready: () => Promise<boolean>, label: string) => {
    while (!(await ready())) {
      const next = inFlight.shift();
      if (!next) throw new Error(`timed out waiting for ${label}`);
      frames.push(next);
    }
  };
  await assertServerAskWins(page, id, () => frames, approvalModeResponse, waitFor);
}

test("server-forced ask check waits for the in-flight session_settings reply", async () => {
  await check("ask");
});

test("server-forced ask check still fails at once on a non-ask reply", async () => {
  await expect(check("auto")).rejects.toThrow("server-forced ask session did not report ask settings");
});
