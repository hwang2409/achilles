import { describe, expect, test } from "bun:test";
import { ZetaError, type ZetaDiscovery } from "@fulcrum/zeta";
import { createConnection } from "./connection";

const discovery: ZetaDiscovery = { url: "ws://127.0.0.1:8765", controller_token: "c", observer_token: "o", origins: [] };

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("createConnection controller capacity vs version mismatch", () => {
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
    expect(connection.state.phase).toBe("controller_taken");
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
