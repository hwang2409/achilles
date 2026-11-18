import { describe, expect, test } from "bun:test";
import { ZetaError, type ZetaDiscovery } from "@fulcrum/zeta";
import { createConnection, FEATURES, isObserverPresentation, type ConnectionState } from "./connection";

const discovery: ZetaDiscovery = { url: "ws://127.0.0.1:8765", controller_token: "c", observer_token: "o", origins: [] };

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("negotiates tool approval origin without changing the wire data", () => {
  expect(FEATURES).toContain("tool_approval_origin");
});

test("observer presentation is server-derived, not a synonym for read-only", () => {
  const states: ConnectionState[] = [
    { phase: "connecting", attempt: 0, lost: false },
    { phase: "not_running", attempt: 1, retryAt: 1, lost: false },
    { phase: "auth_failed", reason: "rejected", origins: [], attempt: 1, retryAt: 1, lost: false },
    { phase: "incompatible", attempt: 1, retryAt: 1, lost: false },
    { phase: "dropped", attempt: 1, retryAt: 1, lost: true },
  ];
  for (const state of states) expect(isObserverPresentation(state, true)).toBe(false);
  expect(isObserverPresentation({ phase: "connected", authority: "controller" }, true)).toBe(false);
  expect(isObserverPresentation({ phase: "connected", authority: "observer" }, true)).toBe(true);
});

test("startup and offline failures never retain observer presentation", async () => {
  const offline = createConnection({ origin: "http://localhost", discover: async () => null });
  await flush();
  expect(offline.state.phase).toBe("not_running");
  expect(offline.observerPresentation).toBe(false);
  offline.stop();

  const rejected = createConnection({ origin: "http://localhost", discover: async () => discovery, connect: async () => { throw new ZetaError("connect_failed"); } });
  await flush();
  expect(rejected.state.phase).toBe("auth_failed");
  expect(rejected.observerPresentation).toBe(false);
  rejected.stop();
});

describe("createConnection controller capacity vs version mismatch", () => {
  test("falls back to a live observer and remains live when take-control is still busy", async () => {
    const roles: string[] = [];
    const clients = [0, 1].map(() => {
      let onClose = () => {};
      return { onClose(callback: () => void) { onClose = callback; }, close() { onClose(); } };
    });
    const opened: unknown[] = [];
    const connect = async (_discovery: ZetaDiscovery, role: "controller" | "observer") => {
      roles.push(role);
      if (role === "controller") throw new ZetaError("busy", -32001);
      const client = clients.shift() as never;
      opened.push(client);
      return client;
    };
    const connection = createConnection({ origin: "http://localhost", discover: async () => discovery, connect });
    await flush();
    expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
    expect(connection.client).toBe(opened[0]);
    expect(connection.observerPresentation).toBe(true);
    expect(isObserverPresentation(connection.state, connection.observerPresentation)).toBe(true);
    await connection.takeControl();
    expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
    expect(connection.client).toBe(opened[1]);
    expect(connection.observerPresentation).toBe(true);
    (opened[0] as { close(): void }).close();
    expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
    expect(roles).toEqual(["controller", "observer", "controller", "observer"]);
    connection.stop();
  });

  test("keeps the controller success path unchanged", async () => {
    const client = { onClose() {}, close() {} };
    const connection = createConnection({ origin: "http://localhost", discover: async () => discovery, connect: async () => client as never });
    await flush();
    expect(connection.state).toEqual({ phase: "connected", authority: "controller" });
    expect(connection.client).toBe(client);
    expect(connection.observerPresentation).toBe(false);
    connection.stop();
  });
  // zeta's serve protocol (docs/serve-protocol.md) sends -32001 "connection_capacity" when a second controller
  // connects (the second-tab case) and -32002 "protocol_mismatch" for a real version mismatch. @fulcrum/zeta
  // surfaces these as ZetaError kinds "busy" and "version_mismatch". The two must not collapse into one state.
  test("a second controller (-32001, busy) is reported as controller-taken, not a version mismatch", async () => {
    const connection = createConnection({
      origin: "http://localhost",
      discover: async () => discovery,
      connect: async () => { throw new ZetaError("busy", -32001); },
    });
    await flush();
    expect(connection.state.phase).toBe("observer_limit");
    connection.stop();
  });

  test("a real version mismatch (-32002) is still reported as incompatible", async () => {
    const connection = createConnection({
      origin: "http://localhost",
      discover: async () => discovery,
      connect: async () => { throw new ZetaError("version_mismatch", -32002); },
    });
    await flush();
    expect(connection.state.phase).toBe("incompatible");
    connection.stop();
  });

  test("role matrix keeps observer fallback limited to capacity busy", async () => {
    const roles: string[] = [];
    const connection = createConnection({ origin: "http://localhost", discover: async () => discovery, connect: async (_d, role) => { roles.push(role); throw new ZetaError("version_mismatch", -32002); } });
    await flush();
    expect(connection.state.phase).toBe("incompatible");
    expect(roles).toEqual(["controller"]);
    connection.stop();
  });
});

test("settles discovery throw and start hints as not running", async () => {
  for (const discover of [async () => { throw new Error("offline"); }, async () => ({ start: "zeta serve" })]) {
    const connection = createConnection({ origin: "http://localhost", discover });
    await flush();
    expect(connection.state.phase).toBe("not_running");
    expect(connection.state).toHaveProperty("attempt", 1);
    connection.stop();
  }
});

test("settles a controller hello timeout with injected timers", async () => {
  const timers: Array<() => void> = [];
  const connection = createConnection({
    origin: "http://localhost",
    discover: async () => discovery,
    connect: async () => await new Promise<never>(() => {}),
    helloTimeoutMs: 25,
    setTimer: (callback) => { timers.push(callback); return callback; },
    clearTimer: () => {},
  });
  await flush();
  expect(timers).toHaveLength(1);
  timers[0]!();
  await flush();
  expect(connection.state.phase).toBe("unresponsive");
  expect(connection.state).toMatchObject({ attempt: 1, lost: false });
  connection.stop();
});

describe("connection role and terminal matrix", () => {
  const terminalCases = [
    { name: "discovery failure", discover: async () => null, connect: undefined, phase: "not_running", roles: [] },
    { name: "known origin rejection", discovery: { ...discovery, origins: ["https://other.example"] }, connect: undefined, phase: "auth_failed", roles: [] },
    { name: "rejected controller only", discovery, connect: async (_d: ZetaDiscovery, role: "controller" | "observer") => { expect(role).toBe("controller"); throw new ZetaError("connect_failed"); }, phase: "auth_failed", roles: ["controller"] },
    { name: "controller success", discovery, connect: async (_d: ZetaDiscovery, role: "controller" | "observer") => { expect(role).toBe("controller"); return { onClose() {}, close() {} } as never; }, phase: "connected", roles: ["controller"] },
    { name: "controller busy then observer success", discovery, connect: async (_d: ZetaDiscovery, role: "controller" | "observer") => role === "controller" ? Promise.reject(new ZetaError("busy", -32001)) : ({ onClose() {}, close() {} } as never), phase: "connected", roles: ["controller", "observer"] },
  ] as const;

  for (const row of terminalCases) test(row.name, async () => {
    const roles: string[] = [];
    const connection = createConnection({
      origin: "http://localhost",
      discover: row.discovery ? async () => row.discovery : row.discover,
      connect: row.connect ? async (discovery, role) => { roles.push(role); return row.connect(discovery, role); } : undefined,
    });
    await flush();
    expect(connection.state.phase).toBe(row.phase);
    expect(roles).toEqual(row.roles);
    connection.stop();
  });

  test("observer limit is terminal for the attempt and does not settle a later role", async () => {
    const roles: string[] = [];
    const connection = createConnection({
      origin: "http://localhost",
      discover: async () => discovery,
      connect: async (_d, role) => { roles.push(role); throw new ZetaError("busy", -32001); },
    });
    await flush();
    expect(connection.state.phase).toBe("observer_limit");
    expect(roles).toEqual(["controller", "observer"]);
    connection.stop();
  });
});