import { expect, jest, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { readOtherHistory } from "./historyRead";

test("one per-client slot includes the full server busy cooldown", async () => {
  jest.useFakeTimers();
  try {
    const calls: string[] = [];
    let answer!: (value: unknown) => void;
    let retry!: () => void;
    const startedRetry = new Promise<void>((resolve) => { retry = resolve; });
    let second!: () => void;
    const startedSecond = new Promise<void>((resolve) => { second = resolve; });
    const client = { request: (method: string, p: { session_id: string }) => {
      calls.push(`${method}:${p.session_id}`);
      if (calls.length === 1) return new Promise((resolve) => { answer = resolve; });
      if (calls.length === 2) retry(); else second();
      return Promise.resolve(p.session_id);
    } } as unknown as ZetaClient;
    const first = readOtherHistory(client, { session_id: "first", limit: 1 });
    const queued = readOtherHistory(client, { session_id: "second", limit: 1 });
    expect(calls).toEqual(["session_history_read:first"]);
    answer(Promise.reject({ code: -32004, data: { retry_after_ms: 3400 } }));
    // Drain reaction jobs before moving the fake clock; no real time passes.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    jest.advanceTimersByTime(3399);
    expect(calls).toEqual(["session_history_read:first"]);
    jest.advanceTimersByTime(1);
    await startedRetry;
    await startedSecond;
    expect(await Promise.all([first, queued])).toEqual(["first", "second"]);
    expect(calls).toEqual(["session_history_read:first", "session_history_read:first", "session_history_read:second"]);
  } finally { jest.useRealTimers(); }
}, 1000);
