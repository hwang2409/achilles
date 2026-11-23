import { expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import type { OpenChildRunOptions, OpenChildRunResult, ZetaClient } from "@fulcrum/zeta";
import { createChildRunsController } from "./childRuns";
import { AGENT_REFRESH_MS } from "./reads";

const client = {} as ZetaClient;
const key = { sessionId: "root", runId: "root:1" };
const result = (complete = Promise.resolve()) => {
  const store = createRunStore();
  let released = 0;
  return { complete, lease: { store, release() { released++; store.dispose(); } }, releases: () => released };
};

async function deadline<T>(promise: Promise<T>, operation: string, cancel: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { cancel(); reject(new Error(`deadline: ${operation}`)); }, 1000); })]); }
  finally { clearTimeout(timer); }
}

test("foreign owner refuses without opening a history lease", async () => {
  let opened = 0;
  const owner = createChildRunsController(client, key, { attached: async () => "other", open: async () => { opened++; return result(); } });
  try {
    await owner.refresh();
    expect(owner.snapshot()).toMatchObject({ limited: true, warning: expect.stringContaining("not attached") });
    expect(opened).toBe(0);
  } finally { owner.close(); }
});

// Adapted from gamma test/child-runs.test.ts at 6cd69671: owner teardown and delayed stale results.
test("replacement aborts pending history and releases late and active leases exactly once", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const late = Promise.withResolvers<OpenChildRunResult>();
  const first = result();
  const second = result();
  let opened = 0;
  const owner = createChildRunsController(client, key, { attached: async () => "root", open: async (_client, _key, options?: OpenChildRunOptions) => {
    if (opened++) return second;
    started.resolve(options!.signal!);
    return late.promise;
  } });
  const cancel = () => { owner.close(); late.resolve(first); };
  const pending = owner.refresh();
  try {
    const signal = await deadline(started.promise, "first history open", cancel);
    await deadline(owner.refresh(), "replacement history open", cancel);
    expect(signal.aborted).toBe(true);
    late.resolve(first);
    await deadline(pending, "late history settle", cancel);
    expect(first.releases()).toBe(1);
    expect(owner.snapshot().result).toBe(second);
    owner.close();
    expect(second.releases()).toBe(1);
    expect(owner.snapshot().result).toBeUndefined();
  } finally { cancel(); await deadline(pending, "drain stale history", cancel); }
});

test("selected report changes mark history stale and automatically reread at most every catalog interval", async () => {
  let now = 0;
  const opened: ReturnType<typeof result>[] = [];
  const owner = createChildRunsController(client, key, { now: () => now, attached: async () => "root", open: async () => {
    const value = result(); opened.push(value); return value;
  } });
  try {
    await owner.refresh();
    now = AGENT_REFRESH_MS - 1;
    owner.changed();
    expect(owner.snapshot().stale).toBe(true);
    expect(opened).toHaveLength(1);
    now++;
    await owner.changed();
    expect(opened).toHaveLength(2);
    expect(opened[0]?.releases()).toBe(1);
    expect(owner.snapshot().stale).toBeUndefined();
  } finally { owner.close(); }
});
