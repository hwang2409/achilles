import { describe, expect, test } from "bun:test";
import { ZetaError, type ZetaDiscovery } from "@fulcrum/zeta";
import { createConnection, FEATURES } from "./connection";

const discovery: ZetaDiscovery = { url: "ws://127.0.0.1:8765", controller_token: "c", observer_token: "o", origins: [] };

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("negotiates tool approval origin without changing the wire data", () => {
  expect(FEATURES).toContain("tool_approval_origin");
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
    await connection.takeControl();
    expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
    expect(connection.client).toBe(opened[1]);
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
});
