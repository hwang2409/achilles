import { expect, test } from "bun:test";
import { TELEMETRY_FEATURE, telemetryClient, telemetryNegotiated, telemetryProblem } from "./telemetry-client";

function fakeClient(features = [TELEMETRY_FEATURE]) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const client = { features, request: async (method: string, params?: Record<string, unknown>) => { calls.push({ method, params }); return {}; } };
  return { client, calls };
}

test("sessions sends only chosen filters, the cursor, and a limit inside zeta's 1..200", async () => {
  const { client, calls } = fakeClient();
  const reads = telemetryClient(client);
  await reads.sessions({ start_ns: 1, end_ns: 2 });
  await reads.sessions({ start_ns: 1, end_ns: 2, cursor: "abc", limit: 500, errorsOnly: true, profile: "worker", model: null });
  await reads.sessions({ start_ns: 1, end_ns: 2, cursor: null, limit: 0, profile: "" });
  expect(calls).toEqual([
    { method: "telemetry_sessions", params: { start_ns: 1, end_ns: 2, limit: 50 } },
    { method: "telemetry_sessions", params: { start_ns: 1, end_ns: 2, limit: 200, cursor: "abc", status: "error", profile: "worker" } },
    { method: "telemetry_sessions", params: { start_ns: 1, end_ns: 2, limit: 1 } },
  ]);
});

test("overview and status send their exact params", async () => {
  const { client, calls } = fakeClient();
  const reads = telemetryClient(client);
  await reads.overview({ start_ns: 1, end_ns: 2 }, "day");
  await reads.status();
  expect(calls).toEqual([
    { method: "telemetry_overview", params: { start_ns: 1, end_ns: 2, bucket: "day" } },
    { method: "telemetry_status", params: {} },
  ]);
});

test("negotiation is read from the hello's granted features", () => {
  expect(telemetryNegotiated(fakeClient().client)).toBe(true);
  expect(telemetryNegotiated(fakeClient(["delivery_id"]).client)).toBe(false);
});

test("rejected reads become off, old zeta, or retryable failure", () => {
  const rpc = (code: number, message: string, data?: object) => Object.assign(new Error(message), { code, data });
  expect(telemetryProblem(rpc(-32005, "state unavailable", { code: "telemetry_off", retryable: true })).kind).toBe("off");
  expect(telemetryProblem(rpc(-32601, "method not found: telemetry_overview")).kind).toBe("not_negotiated");
  expect(telemetryProblem(rpc(-32005, "state unavailable", { code: "receiver_unavailable", retryable: true }))).toEqual({ kind: "failed", message: "state unavailable", code: "receiver_unavailable" });
  expect(telemetryProblem(new Error("closed")).kind).toBe("failed");
});
