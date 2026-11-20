import { describe, expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { mapUpdateError, parseGet, parseUpdate, telemetryChange, type HomeSettings, type Restart } from "./homeSettings";

const rev = (digit: string) => `sha256:${digit.repeat(64)}`;
const telemetry = (enabled: boolean) => ({ enabled, source: enabled ? "builtin" : "off", editable: true });
const get = (enabled: boolean, revision = rev("a")) => ({ revision, settings: { telemetry: telemetry(enabled) }, settings_malformed: false });
const updated = (enabled: boolean, revision = rev("b")) => ({ revision, settings: { telemetry: telemetry(enabled) }, restart: { serve: true, sessions: ["s1"], complete: true } });
const error = (code: number, message: string, data?: object) => Object.assign(new Error(message), { code, data });
const off: HomeSettings = { revision: rev("a"), telemetry: "off", editable: true, malformed: false };

type Reply = object | Error;
function fakeZeta(replies: Partial<Record<string, Reply[]>>) {
  const calls: [string, unknown][] = [];
  const client = { request: async (method: string, params: unknown) => {
    calls.push([method, params]);
    const reply = replies[method]?.shift();
    if (!reply) throw new Error(`unexpected ${method}`);
    if (reply instanceof Error) throw reply;
    return reply;
  } } as unknown as ZetaClient;
  return { client, calls };
}
const lend = (client: ZetaClient) => async <T>(read: (client: ZetaClient) => Promise<T>) => ({ value: await read(client) });

function change(zeta: ReturnType<typeof fakeZeta>, options: { enabled?: boolean; withControl?: Parameters<typeof telemetryChange>[0]["withControl"]; allowed?: boolean } = {}) {
  const seen: { committed: [HomeSettings, Restart][]; rereads: number } = { committed: [], rereads: 0 };
  const op = telemetryChange({ before: off, enabled: options.enabled ?? true, withControl: options.withControl ?? lend(zeta.client), live: () => zeta.client,
    committed: (settings, restart) => seen.committed.push([settings, restart]), reread: () => { seen.rereads++; }, allowed: () => options.allowed ?? true });
  return { op, seen };
}
const updates = (calls: [string, unknown][]) => calls.filter(([method]) => method === "home_settings_update");

describe("parse", () => {
  test("valid get and update results", () => {
    expect(parseGet(get(true))).toEqual({ revision: rev("a"), telemetry: "on", editable: true, malformed: false });
    expect(parseGet({ revision: rev("a"), settings: { telemetry: { source: "unknown", editable: false } }, settings_malformed: true }))
      .toEqual({ revision: rev("a"), telemetry: "unknown", editable: false, malformed: true });
    expect(parseGet({ ...get(true), settings: { telemetry: { enabled: true, source: "custom", editable: false } } })?.telemetry).toBe("custom-on");
    expect(parseUpdate(updated(true))).toEqual({ settings: { revision: rev("b"), telemetry: "on", editable: true, malformed: false }, restart: { sessions: ["s1"], complete: true } });
  });
  test.each([
    ["extra telemetry field", { ...get(true), settings: { telemetry: { ...telemetry(true), endpoint: "http://x" } } }],
    ["missing revision", { settings: { telemetry: telemetry(true) }, settings_malformed: false }],
    ["bad revision", { ...get(true), revision: "abc" }],
    ["extra settings key", { ...get(true), settings: { telemetry: telemetry(true), path: "/x" } }],
  ])("rejects a get with %s", (_name, result) => { expect(parseGet(result)).toBeNull(); });
  test("an unknown or inconsistent source is read-only", () => {
    expect(parseGet({ ...get(true), settings: { telemetry: { enabled: true, source: "other", editable: true } } })).toMatchObject({ telemetry: "unknown", editable: false });
    expect(parseGet({ ...get(true), settings: { telemetry: { enabled: false, source: "builtin", editable: true } } })).toMatchObject({ telemetry: "unknown", editable: false });
  });
  test.each([
    ["non-array sessions", { ...updated(true), restart: { serve: true, sessions: "s1", complete: true } }],
    ["non-string session", { ...updated(true), restart: { serve: true, sessions: [1], complete: true } }],
    ["missing restart", { revision: rev("b"), settings: { telemetry: telemetry(true) } }],
  ])("rejects an update with %s", (_name, result) => { expect(parseUpdate(result)).toBeNull(); });
});

describe("write", () => {
  test("update params are exactly the revision and one change, sent once inside the borrow", async () => {
    const zeta = fakeZeta({ home_settings_update: [updated(true)] });
    const { op, seen } = change(zeta);
    expect(await op.execute()).toMatchObject({ status: "committed", receipt: "telemetry is on. restart zeta to start recording. a zeta without zeta[otel] does not start; turn it off here." });
    expect(zeta.calls).toEqual([["home_settings_update", { expected_revision: rev("a"), changes: [{ key: "telemetry.enabled", value: true }] }]]);
    expect(seen.committed).toEqual([[{ revision: rev("b"), telemetry: "on", editable: true, malformed: false }, { sessions: ["s1"], complete: true }]]);
  });

  test.each([
    ["stale_revision", error(-32009, "settings.toml changed since the given revision", { code: "stale_revision", current_revision: rev("c") }), { reason: "changed", message: "not changed. the state changed elsewhere; the row now shows the current state." }, 1],
    ["settings_busy", error(-32009, "another zeta process is writing settings.toml", { code: "settings_busy", retryable: true }), { reason: "not-applied" }, 0],
    ["custom_home_setting", error(-32602, "the setting has a custom value", { code: "custom_home_setting" }), { reason: "not-applied", message: "not changed. telemetry uses a custom endpoint from settings.toml. change it there." }, 1],
    ["observer_read_only", error(-32008, "observer", { code: "observer_read_only" }), { reason: "refused" }, 0],
    ["settings_malformed", error(-32000, "settings.toml does not parse or validate", { code: "settings_malformed" }), { reason: "not-applied", message: "not changed. settings.toml has an error. zeta will not start until it is fixed." }, 1],
    ["telemetry_unavailable", error(-32602, "invalid params", { code: "telemetry_unavailable", detail: "zeta[otel] is\nnot installed" }),
      { reason: "not-applied", message: "not changed. zeta cannot record telemetry on this computer: zeta[otel] is not installed", final: true }, 1],
    ["telemetry_unavailable without text", error(-32602, "telemetry is unavailable", { code: "telemetry_unavailable" }),
      { reason: "not-applied", message: "not changed. zeta cannot record telemetry on this computer: telemetry is unavailable", final: true }, 1],
    ["a telemetry_unavailable reason (not code)", error(-32602, "invalid params", { reason: "telemetry_unavailable", detail: "x" }), { reason: "not-applied", message: "not changed. zeta refused this change: invalid params" }, 0],
    ["an unknown -32602 reason", error(-32602, "invalid params", { code: "invalid_params" }), { reason: "not-applied", message: "not changed. zeta refused this change: invalid params" }, 0],
    ["a -32602 with no data", error(-32602, "x".repeat(400)), { reason: "not-applied", message: `not changed. zeta refused this change: ${"x".repeat(261)}` }, 0],
  ])("%s is a known failure, with no retry", async (_name, reply, failure, rereads) => {
    const zeta = fakeZeta({ home_settings_update: [reply] });
    const { op, seen } = change(zeta);
    expect(await op.execute()).toEqual({ status: "failed", ...failure } as never);
    expect(updates(zeta.calls)).toHaveLength(1);
    expect(seen.committed).toEqual([]);
    expect(seen.rereads).toBe(rereads);
  });

  test("a controller hello without the update sends nothing", async () => {
    const zeta = fakeZeta({});
    const { op } = change(zeta, { allowed: false });
    expect(await op.execute()).toEqual({ status: "failed", reason: "not-applied", message: "not changed. this zeta does not allow changing settings here." } as never);
    expect(zeta.calls).toEqual([]);
  });

  test.each([
    ["another tab has control", "at 10:00 another tab had control.", "refused"],
    ["take control failed", "could not take control. try again.", "not-applied"],
  ])("a refused borrow (%s) sends no request", async (_name, refused, reason) => {
    const zeta = fakeZeta({ home_settings_update: [updated(true)] });
    const { op } = change(zeta, { withControl: async () => ({ refused }) });
    expect(await op.execute()).toEqual({ status: "failed", reason } as never);
    expect(zeta.calls).toEqual([]);
  });
});

describe("unknown result", () => {
  for (const [name, reply] of [["no answer", new Error("zeta did not answer")], ["-32000 without a code", error(-32000, "unexpected server or storage failure")]] as const) {
    test(`${name}: checkResult sends one get and no update; committed only when the value matches and the revision moved`, async () => {
      const zeta = fakeZeta({ home_settings_update: [reply], home_settings_get: [get(true, rev("b"))] });
      const { op, seen } = change(zeta);
      expect(await op.execute()).toEqual({ status: "unknown" });
      expect(await op.checkResult()).toMatchObject({ status: "committed" });
      expect(zeta.calls.map(([method]) => method)).toEqual(["home_settings_update", "home_settings_get"]);
      expect(seen.committed).toEqual([[{ revision: rev("b"), telemetry: "on", editable: true, malformed: false }, null]]);
    });
  }
  test("the same revision means not applied; a moved revision with the old value means changed", async () => {
    for (const [reply, result] of [[get(false), { status: "failed", reason: "not-applied" }], [get(false, rev("c")), { status: "failed", reason: "changed", message: "not changed. the state changed elsewhere; the row now shows the current state." }]] as const) {
      const zeta = fakeZeta({ home_settings_update: [new Error("drop")], home_settings_get: [reply] });
      const { op, seen } = change(zeta);
      await op.execute();
      expect(await op.checkResult()).toEqual(result as never);
      expect(updates(zeta.calls)).toHaveLength(1);
      expect(seen.committed).toEqual([]);
    }
  });
  test("a failed read stays unknown", async () => {
    const zeta = fakeZeta({ home_settings_update: [new Error("drop")], home_settings_get: [new Error("drop")] });
    const { op } = change(zeta);
    await op.execute();
    expect(await op.checkResult()).toEqual({ status: "unknown" });
    expect(updates(zeta.calls)).toHaveLength(1);
  });
});

test("mapUpdateError leaves unknown codes to a read", () => {
  expect(mapUpdateError(error(-32009, "x", { code: "other" }))).toBeNull();
  expect(mapUpdateError(new Error("closed"))).toBeNull();
});
