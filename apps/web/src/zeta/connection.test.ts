import { describe, expect, test } from "bun:test";
import { ZetaError, type ZetaDiscovery } from "@fulcrum/zeta";
import { createConnection, FEATURES, isObserverPresentation, transitionRole, type ConnectionState } from "./connection";

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

const controllerRole = { role: "controller", reason: null } as const;
const observerRole = { role: "observer", reason: null } as const;
const refusedRole = { ...observerRole, reason: "another tab had control. try again after it closes." };
test.each([
  ["connect on a read-only route", controllerRole, ["connect_read_only", "observer_busy", "retry"], observerRole],
  ["connect on a writable route", observerRole, ["connect_writable", "retry"], controllerRole],
  ["controller granted", controllerRole, ["controller_granted"], controllerRole],
  ["controller busy probes observer", controllerRole, ["controller_busy"], observerRole],
  ["observer accepted and reconnects as observer", controllerRole, ["controller_busy", "observer_granted", "retry"], observerRole],
  ["previously accepted observer is busy", observerRole, ["observer_busy", "retry"], observerRole],
  ["both busy retries as controller", controllerRole, ["controller_busy", "both_busy", "retry"], controllerRole],
  ["refused takeover keeps observer and exposes reason", observerRole, ["takeover_refused"], refusedRole],
  ["retry clears refusal without promoting observer", refusedRole, ["retry"], observerRole],
  ["released controller slot grants takeover and clears reason", refusedRole, ["controller_granted"], controllerRole],
  ["closed controller retries as controller", controllerRole, ["controller_closed", "retry"], controllerRole],
] as const)("role transition: %s", (_name, initial, events, expected) => {
  let state: Parameters<typeof transitionRole>[0] = initial;
  for (const event of events) state = transitionRole(state, event);
  expect(state).toEqual(expected);
});

describe("createConnection controller capacity vs version mismatch", () => {
  test("falls back to a live observer and remains live when take-control is still busy", async () => {
    const roles: string[] = [];
    let released = false;
    let closeObserver = () => {};
    let observerCloses = 0;
    const observer = { onClose(callback: () => void) { closeObserver = callback; }, close() { observerCloses++; closeObserver(); } };
    const controller = { onClose() {}, close() {} };
    const connect = async (_discovery: ZetaDiscovery, role: "controller" | "observer") => {
      roles.push(role);
      if (role === "controller" && !released) throw new ZetaError("busy", -32001);
      return (role === "observer" ? observer : controller) as never;
    };
    const connection = createConnection({ origin: "http://localhost", discover: async () => discovery, connect });
    try {
      await flush();
      expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
      expect(connection.client).toBe(observer);
      expect(connection.observerPresentation).toBe(true);
      expect(isObserverPresentation(connection.state, connection.observerPresentation)).toBe(true);
      const states = [connection.state];
      const unsubscribe = connection.subscribe(() => states.push(connection.state));
      const result = await connection.takeControl();
      unsubscribe();
      expect(states.filter((state) => state.phase !== "connected" || state.authority !== "observer")).toEqual([]);
      expect(result).toBe(refusedRole.reason);
      expect(connection.client).toBe(observer);
      expect(observerCloses).toBe(0);
      released = true;
      await connection.takeControl();
      expect(connection.state).toEqual({ phase: "connected", authority: "controller" });
      expect(connection.client).toBe(controller);
      expect(observerCloses).toBe(1);
      expect(roles).toEqual(["controller", "observer", "controller", "controller"]);
    } finally { connection.stop(); }
  });

  test.each([
    ["locked read-only", "locked", "observer"],
    ["writable", undefined, "controller"],
  ] as const)("connects and reconnects on a %s route", async (_route, readOnly, authority) => {
    const roles: string[] = [];
    let drop = () => {};
    const client = { onClose(callback: () => void) { drop = callback; }, close() {} };
    const route = { readOnly };
    const connection = createConnection({
      ...route,
      origin: "http://localhost",
      discover: async () => discovery,
      connect: async (_discovery, role) => { roles.push(role); return client as never; },
    });
    try {
      await flush();
      expect(connection.state).toEqual({ phase: "connected", authority });
      expect(connection.client).toBe(client);
      expect(connection.observerPresentation).toBe(authority === "observer");
      await connection.takeControl();
      drop();
      connection.retryNow();
      await flush();
      expect(roles).toEqual([authority, authority]);
      expect(connection.state).toEqual({ phase: "connected", authority });
    } finally { connection.stop(); }
  });
  test("an upgradable route starts as observer, takes control on request, and a refusal keeps the live observer", async () => {
    const roles: string[] = [];
    let slotFree = false;
    let observerCloses = 0;
    const observer = { onClose() {}, close() { observerCloses++; } };
    const controller = { onClose() {}, close() {} };
    const connection = createConnection({
      readOnly: "upgradable",
      origin: "http://localhost",
      discover: async () => discovery,
      connect: async (_discovery, role) => {
        roles.push(role);
        if (role === "controller" && !slotFree) throw new ZetaError("busy", -32001);
        return (role === "observer" ? observer : controller) as never;
      },
    });
    try {
      await flush();
      expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
      expect(await connection.takeControl()).toBe(refusedRole.reason);
      expect(connection.client).toBe(observer);
      expect(observerCloses).toBe(0);
      slotFree = true;
      expect(await connection.takeControl()).toBeNull();
      expect(connection.state).toEqual({ phase: "connected", authority: "controller" });
      expect(connection.client).toBe(controller);
      expect(observerCloses).toBe(1);
      expect(roles).toEqual(["observer", "controller", "controller"]);
    } finally { connection.stop(); }
  });

  test.each([
    ["an observer slot is free: it swaps to an observer socket", true],
    ["no observer slot: it closes the controller and reconnects as observer", false],
  ] as const)("an upgradable route gives control back: %s; a drop while holding reconnects as controller", async (_name, observerSlot) => {
    const roles: string[] = [];
    const drops: (() => void)[] = [];
    let observerHellos = 0;
    const connection = createConnection({
      readOnly: "upgradable",
      origin: "http://localhost",
      discover: async () => discovery,
      connect: async (_discovery, role) => {
        roles.push(role);
        // the first observer connects; the one release asks for is refused when there is no observer slot.
        if (role === "observer" && ++observerHellos === 2 && !observerSlot) throw new ZetaError("busy", -32001);
        return { onClose(callback: () => void) { drops.push(callback); }, close() { drops.at(-1)?.(); } } as never;
      },
    });
    try {
      await flush();
      expect(await connection.takeControl()).toBeNull();
      drops.at(-1)!(); // a drop while an editor holds control
      connection.retryNow();
      await flush();
      expect(connection.state).toEqual({ phase: "connected", authority: "controller" });
      await connection.releaseControl();
      connection.retryNow();
      await flush();
      expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
      drops.at(-1)!();
      connection.retryNow();
      await flush();
      expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
      expect(roles).toEqual(observerSlot
        ? ["observer", "controller", "controller", "observer", "observer"]
        : ["observer", "controller", "controller", "observer", "observer", "observer"]);
    } finally { connection.stop(); }
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

  test("both busy, then retry prefers the freed controller slot", async () => {
    const roles: string[] = [];
    let released = false;
    const connection = createConnection({
      origin: "http://localhost",
      discover: async () => discovery,
      connect: async (_d, role) => {
        roles.push(role);
        if (!released || role === "observer") throw new ZetaError("busy", -32001);
        return { onClose() {}, close() {} } as never;
      },
    });
    try {
      await flush();
      expect(connection.state.phase).toBe("observer_limit");
      expect(roles).toEqual(["controller", "observer"]);
      released = true;
      connection.retryNow();
      await flush();
      expect(roles).toEqual(["controller", "observer", "controller"]);
      expect(connection.state).toEqual({ phase: "connected", authority: "controller" });
    } finally { connection.stop(); }
  });
});
