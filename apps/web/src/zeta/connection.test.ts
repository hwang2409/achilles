import { describe, expect, test } from "bun:test";
import { ZetaError } from "@fulcrum/zeta";
import { canWrite } from "../write-access";
import { createConnection, reduceConnection, type ConnectionState } from "./connection";

const discovery = { url: "ws://127.0.0.1:8765", origins: [], controller_token: "controller" };
const observerDiscovery = { ...discovery, observer_token: "observer" };
const client = () => ({ features: [], hello: async () => ({}), onClose: () => {}, close: () => {} });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("write authority", () => {
  const states: Array<[string, ConnectionState, boolean]> = [
    ["controller", { phase: "connected", authority: "controller" }, true],
    ["observer", { phase: "connected", authority: "observer" }, false],
    ["taking control", { phase: "taking_control", authority: "observer", attempt: 0 }, false],
  ];
  const actions = ["approve", "deny", "starter", "composer", "new chat", "create mode", "server-backed setting", "page create mode", "record form"];

  test.each(actions.flatMap((action) => states.map(([role, state, enabled]) => [action, role, state, enabled] as const)))(
    "%s under %s authority",
    (_action, _role, state, enabled) => expect(canWrite(state)).toBe(enabled),
  );
});

describe("takeover state", () => {
  const taking = (attempt: number): ConnectionState => ({ phase: "taking_control", authority: "observer", attempt });
  test.each([
    ["busy under the bound", taking(4), { type: "takeover_outcome", outcome: "busy" } as const, taking(5)],
    ["busy at the bound", taking(5), { type: "takeover_outcome", outcome: "busy" } as const, { phase: "takeover_failed", authority: "observer", reason: "busy_bound" }],
    ["non-busy error", taking(0), { type: "takeover_outcome", outcome: "error" } as const, { phase: "takeover_failed", authority: "observer", reason: "error" }],
    ["success", taking(3), { type: "takeover_outcome", outcome: "success" } as const, { phase: "connected", authority: "controller" }],
    ["cancel", taking(3), { type: "takeover_cancelled" } as const, { phase: "connected", authority: "observer" }],
  ])("handles %s", (_name, state, event, expected) => expect(reduceConnection(state, event)).toEqual(expected));
});

describe("controller capacity", () => {
  test("is capacity, not incompatible, when observers are unavailable", async () => {
    const connection = createConnection({ origin: "http://test", discover: async () => discovery, connect: async () => { throw new ZetaError("busy", -32001); }, setTimer: () => 0, clearTimer: () => {} });
    await settle();
    expect(connection.state.phase).toBe("capacity");
    connection.stop();
  });

  test("connects as an observer and can retry as controller", async () => {
    let role = "";
    let controllerAttempts = 0;
    const observer = client();
    const controller = client();
    const connection = createConnection({
      origin: "http://test",
      discover: async () => observerDiscovery,
      connect: async (_discovery, nextRole) => { role = nextRole; if (nextRole === "controller" && controllerAttempts++ === 0) throw new ZetaError("busy", -32001); return nextRole === "observer" ? observer as never : controller as never; },
      setTimer: (callback) => { callback(); return 0; },
      clearTimer: () => {},
    });
    await settle();
    expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
    connection.takeControl();
    await settle();
    expect(role).toBe("controller");
    expect(connection.state).toEqual({ phase: "connected", authority: "controller" });
    connection.stop();
  });
});
