import { expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { createMemoryWriter, type MemoryAction, type MemoryOutcome } from "./memoryWrites";
import type { MemoryRow } from "./reads";

const BASE = "a".repeat(64), NEXT = "b".repeat(64), METHOD = "project_memory_update";
const row = (id = "m_one", automatic = true): MemoryRow => ({ id, kind: "brief", summary: "fixture", automatic, accepted: false, sourceSession: null });
const wireRow = (id: string, accepted?: boolean) => ({ memory_id: id, kind: "brief", summary: "fixture", automatic: true, accepted });
const page = (items: unknown[], next_cursor: string | null = null) => ({ items, next_cursor });
const rpc = (code: number, reason?: string) => Object.assign(new Error("do not show server text"), { code, data: { reason } });
const success = { revision: NEXT, data: { format: 2, version_id: "v_saved", body: "ignored" } };
const show = (digest = BASE, version_id = "v_before") => ({ memory: { digest, version_id, schema_version: 1, kinds: [{ key: "brief", rendered: "ignored", rendered_truncated: false }] } });

function setup(writeReplies: unknown[] = [success], shows = [show()], pages: unknown[] = []) {
  const frames: { method: string; params: Record<string, unknown> }[] = [];
  const delays: number[] = [];
  const landed: MemoryOutcome[] = [];
  const client = { request: async (method: string, params: Record<string, unknown>) => {
    frames.push({ method, params });
    const reply = method === METHOD ? writeReplies.shift() : method === "project_show" ? shows.shift() : pages.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  } } as ZetaClient;
  const writer = createMemoryWriter(() => client, async (ms) => { delays.push(ms); }, (result) => landed.push(result));
  const form = writer.open();
  const seen: MemoryOutcome[] = [];
  const attach = () => writer.attach(form, (result) => seen.push(result));
  const prepare = (op: MemoryAction, rows = [row()], prior?: Parameters<typeof writer.prepare>[4]) => writer.prepare("p_fixture", "cards", op, rows, prior);
  const send = async (op: MemoryAction, rows = [row()]) => {
    const { sent } = await prepare(op, rows);
    if (!sent) throw Error("test has no prepared attempt");
    await writer.execute(form, sent);
    return sent;
  };
  return { writer, form, attach, seen, frames, prepare, send, delays, landed, writes: () => frames.filter(({ method }) => method === METHOD).map(({ params }) => params) };
}

test.each([
  { op: "accept" as const, n: 1, expected: { target: "m_0" } },
  { op: "resolve" as const, n: 1, expected: { entry_ids: ["m_0"] } },
  { op: "resolve" as const, n: 64, expected: { entry_ids: Array.from({ length: 64 }, (_, i) => `m_${i}`) } },
])("memory sends exact $op CAS with $n entries", async ({ op, n, expected }) => {
  const f = setup(); f.attach();
  const rows = Array.from({ length: n }, (_, i) => row(`m_${i}`));
  await f.send(op, rows);
  expect(f.frames[0]).toEqual({ method: "project_show", params: { project_id: "p_fixture" } });
  expect(f.writes()).toEqual([{ project_id: "p_fixture", revision: BASE, mutation: { format: 2, op, ...expected } }]);
  expect(f.seen[0]).toMatchObject({ status: "committed", receipt: { versionId: "v_saved", revision: NEXT, action: op, ids: rows.map(({ id }) => id) } });
});

test.each([
  { label: "empty resolve", action: "resolve", rows: [] },
  { label: "65-entry resolve", action: "resolve", rows: Array.from({ length: 65 }, (_, i) => row(`m_${i}`)) },
  { label: "duplicate resolve", action: "resolve", rows: [row(), row()] },
  { label: "invalid target", action: "accept", rows: [row("m_invalid\n")] },
  { label: "non-automatic entry", action: "accept", rows: [row("m_one", false)] },
  { label: "already accepted", action: "accept", rows: [{ ...row(), accepted: true }] },
  { label: "accept on zeta with no accepted field", action: "accept", rows: [{ ...row(), accepted: null }] },
] satisfies { label: string; action: MemoryAction; rows: MemoryRow[] }[])("memory refuses $label before any request", async ({ action, rows }) => {
  const f = setup();
  expect(await f.prepare(action, rows)).toHaveProperty("problem");
  expect(f.frames).toEqual([]);
});

test("memory retries busy with the same CAS and stops after the bounded backoff", async () => {
  const f = setup(Array.from({ length: 4 }, () => rpc(-32004))); f.attach();
  await f.send("accept");
  expect(f.delays).toEqual([500, 1000, 2000]);
  expect(f.writes()).toEqual(Array.from({ length: 4 }, () => ({ project_id: "p_fixture", revision: BASE, mutation: { format: 2, op: "accept", target: "m_one" } })));
  expect(f.seen[0]).toMatchObject({ status: "refused", message: expect.stringContaining("another zeta process") });
});

test("memory stale rereads the revision, requests a row refresh, and never resends", async () => {
  const f = setup([rpc(-32009), success], [show(), show(NEXT)]); f.attach();
  await f.send("accept");
  expect(f.frames.map(({ method }) => method)).toEqual(["project_show", METHOD, "project_show"]);
  expect(f.seen).toEqual([{ status: "changed", message: expect.stringContaining("nothing was changed"), refresh: true }]);
});

test.each([
  { code: -32602, reason: "secret_refused", copy: "secret-like", refresh: false },
  { code: -32602, reason: "operation_rejected", copy: "current entry", refresh: true },
  { code: -32602, reason: "project_not_found", copy: "refused this project", refresh: true },
  { code: -32602, reason: "invalid_params", copy: "refused this project", refresh: false },
  { code: -32008, reason: "observer_read_only", copy: "read-only", refresh: false },
  { code: -32003, reason: "no_active_session", copy: "no open chat", refresh: false },
  { code: -32005, reason: "state_unavailable", copy: "not available", refresh: false },
  { code: -32000, reason: "internal_error", copy: "stored state invalid", refresh: false },
  { code: -32601, reason: "method_not_found", copy: "cannot change", refresh: false },
])("memory maps $reason to safe terminal copy", async ({ code, reason, copy, refresh }) => {
  const f = setup([rpc(code, reason)]); f.attach();
  await f.send("accept");
  expect(f.seen).toEqual([{ status: "refused", message: expect.stringContaining(copy), refresh }]);
  expect(JSON.stringify(f.seen)).not.toContain("do not show server text");
  expect(f.writes()).toHaveLength(1);
});

test.each([
  { label: "non-hex revision", reply: { ...success, revision: "wrong" } },
  { label: "wrong format", reply: { ...success, data: { ...success.data, format: 1 } } },
  { label: "missing version", reply: { ...success, data: { format: 2 } } },
])("memory treats a success with $label as unknown", async ({ reply }) => {
  const f = setup([reply]); f.attach();
  await f.send("accept");
  expect(f.seen).toEqual([{ status: "unknown" }]);
  expect(f.writes()).toHaveLength(1);
});

test.each([
  { label: "lost accept", op: "accept" as const, pages: [page([wireRow("m_one", true)])], after: NEXT, status: "committed" },
  { label: "lost resolve", op: "resolve" as const, pages: [page([], "cursor"), page([wireRow("m_other", false)])], after: NEXT, status: "committed" },
  { label: "partial resolve", op: "resolve" as const, pages: [page([wireRow("m_two", true)])], after: NEXT, status: "unverified" },
  { label: "accept not verifiable on older zeta", op: "accept" as const, pages: [page([wireRow("m_one")])], after: NEXT, status: "unverified" },
  { label: "unchanged accept", op: "accept" as const, pages: [page([wireRow("m_one", false)])], after: BASE, status: "not-applied" },
])("memory settles $label by reads without a resend", async ({ op, pages, after, status }) => {
  const f = setup([new Error("closed"), success], [show(), show(after), show(after)], pages.slice()); f.attach();
  const sent = await f.send(op, op === "accept" ? [row()] : [row(), row("m_two")]);
  expect(f.seen).toEqual([{ status: "unknown" }]);
  await f.writer.execute(f.form, sent);
  await f.writer.checkResult(f.form, sent);
  expect(f.seen[2]).toMatchObject({ status });
  if (status === "committed") expect(f.seen[2]).toEqual({ status, message: "current memory now matches this action." });
  expect(f.writes()).toHaveLength(1);
});

test.each([{ label: "known undo", reply: success, status: "committed" }, { label: "uncertain undo", reply: new Error("closed"), status: "unverified" }])(
  "memory $label uses exactly the receipt's revision and version, with no recursive undo", async ({ reply, status }) => {
    const f = setup([success, reply], [show(), show(NEXT, "v_saved")]); f.attach();
    await f.send("resolve", [row(), row("m_two")]);
    const first = f.seen[0];
    if (first?.status !== "committed") throw Error("no receipt");
    const { sent } = await f.prepare("undo", [], first.receipt);
    if (!sent) throw Error("no undo attempt");
    await f.writer.execute(f.form, sent);
    if (status === "unverified") await f.writer.checkResult(f.form, sent);
    expect(f.writes()[1]).toEqual({ project_id: "p_fixture", revision: NEXT, mutation: { format: 2, op: "undo", target: "v_saved" } });
    expect(f.writes()).toHaveLength(2);
    expect(f.seen.at(-1)).toMatchObject({ status });
    expect(f.seen.at(-1)).not.toHaveProperty("receipt");
  });

test.each([{ mode: "close" }, { mode: "remount" }])("memory ownership on $mode during a request", async ({ mode }) => {
  const gate = Promise.withResolvers<typeof success>();
  const f = setup([gate.promise]);
  const detach = f.attach();
  const { sent } = await f.prepare("accept");
  if (!sent) throw Error("no prepared attempt");
  const run = f.writer.execute(f.form, sent);
  try {
    expect(f.writes()).toHaveLength(1);
    detach();
    if (mode === "close") f.writer.close(f.form);
    gate.resolve(success);
    await run;
    expect(f.seen).toEqual([]);
    f.attach()(); f.attach();
    expect(mode === "close" ? f.landed : f.seen).toEqual([expect.objectContaining({ status: "committed" })]);
    expect(mode === "close" ? f.seen : f.landed).toEqual([]);
  } finally { gate.resolve(success); }
});
