import { expect, jest, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { readOtherHistory } from "./historyRead";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
async function within<T>(name: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error(`timed out: ${name}`)), 10000);
    })]);
  } finally { realClearTimeout(timer); }
}

// Flush promise reactions before advancing the fake clock, not elapsed time.
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test("one per-client slot includes the full server busy cooldown and retry", async () => {
  const controller = new AbortController();
  const { signal } = controller;
  const calls: string[] = [];
  const initial = Promise.withResolvers<unknown>();
  const retry = Promise.withResolvers<unknown>();
  const client = { request: (method: string, p: { session_id: string }) => {
    calls.push(`${method}:${p.session_id}`);
    if (p.session_id === "second") return Promise.resolve(p.session_id);
    return calls.filter((call) => call === "session_history_read:first").length === 1 ? initial.promise : retry.promise;
  } } as unknown as ZetaClient;

  jest.useFakeTimers();
  const first = readOtherHistory(client, { session_id: "first", limit: 1 }, { signal });
  const queued = readOtherHistory(client, { session_id: "second", limit: 1 }, { signal });
  const drained = Promise.allSettled([first, queued]);
  try {
    expect(calls).toEqual(["session_history_read:first"]);
    initial.reject({ code: -32004, data: { retry_after_ms: 3400 } });
    await flush();
    jest.advanceTimersByTime(3399);
    await flush();
    expect(calls).toEqual(["session_history_read:first"]);
    jest.advanceTimersByTime(1);
    await flush();
    expect(calls).toEqual(["session_history_read:first", "session_history_read:first"]);
    retry.resolve("first");
    expect(await within("settle retry and queued read", drained)).toEqual([
      { status: "fulfilled", value: "first" }, { status: "fulfilled", value: "second" },
    ]);
    expect(calls).toEqual(["session_history_read:first", "session_history_read:first", "session_history_read:second"]);
  } finally {
    controller.abort();
    initial.resolve(undefined);
    retry.resolve(undefined);
    await flush();
    try { jest.runAllTimers(); await within("drain retry and queued read after cancellation", drained); }
    finally { jest.useRealTimers(); }
  }
}, 25000);
