import { expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { ZetaError, type ChildRunSendResult, type OpenChildRunOptions, type OpenChildRunResult, type ZetaClient } from "@fulcrum/zeta";
import { createChildRunsController } from "./childRuns";
import { createChildSendOwner } from "./childSend";
import { AGENT_REFRESH_MS, rowKey } from "./reads";

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
    expect(owner.snapshot()).toMatchObject({ limited: true, warning: expect.stringContaining("the chat that started it") });
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
  const owner = createChildRunsController(client, key, { now: () => now, attached: async () => "root", open: async (_client, _key, options?: OpenChildRunOptions) => {
    options?.onProgress?.({ messages: 1, complete: true, restart: 0 });
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

const id = rowKey(key.sessionId, key.runId);
const otherId = rowKey("other", key.runId);
const accepted = { kind: "accepted", runId: key.runId } as const;
const refused = "zeta had no free control slot.";
const unknown = "delivery is unknown; check the child transcript before sending again.";

test.each([
  { name: "accepted clear affects only its form", reply: accepted, kept: "", message: "message accepted by zeta." },
  { name: "wrong run acknowledgment keeps draft", reply: { ...accepted, runId: "different" }, kept: "fixture", message: unknown },
  { name: "observer refusal keeps draft without dispatch", refusal: true, kept: "fixture", message: refused },
  { name: "terminal error keeps draft and requires refresh", error: Object.assign(new Error("terminal"), { code: -32005 }), blocked: true, kept: "fixture", message: "the child is no longer available for follow-up. refresh the run before trying again." },
  { name: "socket loss keeps draft and never resends", error: new ZetaError("closed", 1006), kept: "fixture", message: unknown },
] as const)("child send: $name", async (row) => {
  let requests = 0;
  let borrows = 0;
  let returns = 0;
  const owner = createChildSendOwner({ async withControl(run) {
    borrows++;
    if ("refusal" in row) return { refused };
    try { return { value: await run(client) }; }
    finally { returns++; }
  } }, async (_client, target, text) => {
    requests++;
    expect(target).toEqual(key);
    expect(text).toBe("fixture");
    if ("error" in row) throw row.error;
    return "reply" in row ? row.reply : accepted;
  });
  owner.edit(otherId, "not this child");
  owner.edit(id, "fixture");
  expect(borrows).toBe(0);
  await owner.send(key, 0);
  expect(owner.snapshot(id)).toMatchObject({ text: row.kept, outcome: { message: row.message } });
  expect(owner.snapshot(otherId).text).toBe("not this child");
  if ("blocked" in row) {
    await owner.send(key, 0);
    expect(borrows).toBe(1);
    await owner.send(key, Infinity);
  }
  expect(borrows).toBe("blocked" in row ? 2 : 1);
  expect(requests).toBe("refusal" in row ? 0 : borrows);
  expect(returns).toBe(requests);
});

test("child send: duplicate submission and unmount/reattach preserve the matching attempt", async () => {
  const reply = Promise.withResolvers<ChildRunSendResult>();
  const cancel = () => reply.resolve({ kind: "malformed" });
  let requests = 0;
  const owner = createChildSendOwner({ async withControl(run) { return { value: await run(client) }; } }, () => { requests++; return reply.promise; });
  owner.edit(id, "fixture");
  const detach = owner.subscribe(() => {});
  const pending = owner.send(key, 0)!;
  try {
    expect(owner.snapshot(id).pending).toBe(true);
    const duplicate = owner.send(key, 0);
    owner.edit(id, "new draft");
    const different = owner.send(key, 0);
    detach();
    reply.resolve(accepted);
    await deadline(Promise.all([pending, duplicate, different]), "settle the one child send", cancel);
    const reattach = owner.subscribe(() => {});
    try {
      expect(requests).toBe(1);
      expect(owner.snapshot(id)).toEqual({ text: "new draft", outcome: { accepted: true, message: "message accepted by zeta." } });
    } finally { reattach(); }
  } finally {
    detach();
    cancel();
    await deadline(pending, "drain the child send", cancel);
  }
});
