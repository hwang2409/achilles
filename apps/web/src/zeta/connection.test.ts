import { describe, expect, test } from "bun:test";
import { ZetaError } from "@fulcrum/zeta";
import { createConnection } from "./connection";

const discovery = { url: "ws://127.0.0.1:8765", origins: [], controller_token: "controller" };
const observerDiscovery = { ...discovery, observer_token: "observer" };
const client = () => ({ features: [], hello: async () => ({}), onClose: () => {}, close: () => {} });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("controller capacity", () => {
  test("is capacity, not incompatible, when observers are unavailable", async () => {
    const connection = createConnection({ origin: "http://test", discover: async () => discovery, connect: async () => { throw new ZetaError("busy", -32001); }, setTimer: () => 0, clearTimer: () => {} });
    await settle();
    expect(connection.state.phase).toBe("capacity");
    connection.stop();
  });

  test("connects as an observer and can retry as controller", async () => {
    let role = "";
    let closed = false;
    const observer = { ...client(), close: () => { closed = true; } };
    const controller = client();
    const connection = createConnection({
      origin: "http://test",
      discover: async () => observerDiscovery,
      connect: async (_discovery, nextRole) => { role = nextRole; if (nextRole === "controller" && !closed) throw new ZetaError("busy", -32001); return nextRole === "observer" ? observer as never : controller as never; },
      setTimer: (callback) => { callback(); return 0; },
      clearTimer: () => {},
    });
    await settle();
    expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
    connection.takeControl();
    await settle();
    expect(role).toBe("controller");
    expect(connection.state.phase).toBe("connected");
    connection.stop();
  });
});
