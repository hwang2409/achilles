import { expect, test } from "bun:test";
import { approvalModeWaiter } from "./gate-settings";

type Frame = { method?: string; params?: { session_id?: string }; id?: unknown; result?: { approval_mode?: string } };

const id = "settings-session";
const request = (frameId: number): Frame => ({ id: frameId, method: "session_settings", params: { session_id: id } });
const reply = (frameId: number, mode: string): Frame => ({ id: frameId, result: { approval_mode: mode } });

// each unmet check delivers the next in-flight reply, so arrival order is explicit and nothing sleeps
const deliveringWaitFor = (frames: Frame[], inFlight: Frame[]) => async (ready: () => Promise<boolean>, label: string) => {
  while (!(await ready())) {
    const next = inFlight.shift();
    if (!next) throw new Error(`timed out waiting for ${label}`);
    frames.push(next);
  }
};

const run = (frames: Frame[], inFlight: Frame[], expected: string) =>
  approvalModeWaiter(() => frames, deliveringWaitFor(frames, inFlight))("session_settings", id, expected, "settings reply");

test("reply already present: resolves against it", async () => {
  await run([request(11), reply(11, "ask")], [], "ask");
});

test("reply arrives late: waits for the newest reply instead of reading once", async () => {
  // the call-site one-shot read (base) returns undefined here; the owner waits for the in-flight reply
  const frames = [request(11)];
  await run(frames, [reply(11, "ask")], "ask");
  expect(frames.at(-1)?.result?.approval_mode).toBe("ask");
});

test("wrong mode: fails at once without waiting", async () => {
  const inFlight = [reply(11, "ask")]; // a later correct reply must never be consumed
  await expect(run([request(11), reply(11, "allow")], inFlight, "ask")).rejects.toThrow(
    'settings reply: expected session_settings approval_mode "ask", got "allow"',
  );
  expect(inFlight.length).toBe(1);
});

test("no reply: fails with the caller's label at the bound", async () => {
  await expect(run([request(11)], [], "ask")).rejects.toThrow("settings reply (session_settings reply)");
});

test("stale older reply + newer request: waits for the newer reply", async () => {
  // id 5 already answered "allow"; a newer id 11 request is still in flight and must win
  const frames = [request(5), reply(5, "allow"), request(11)];
  await run(frames, [reply(11, "ask")], "ask");
  expect(frames.at(-1)?.result?.approval_mode).toBe("ask");
});
