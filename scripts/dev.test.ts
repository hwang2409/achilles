import { expect, test } from "bun:test";
import { ownedProcessMatches, serveDecision } from "./dev";

const zetaCommand = "/usr/local/bin/zeta serve --ws 43003";

test("serve discovery requires a live zeta process and an exact origin", () => {
  expect(serveDecision(null, "http://127.0.0.1:43002", null).kind).toBe("start");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002", zetaCommand).kind).toBe("reuse");
  const localhost = serveDecision({ pid: 123, port: 43003, origins: ["http://localhost:43002"] }, "http://127.0.0.1:43002", zetaCommand);
  expect(localhost).toMatchObject({ kind: "reuse", origin: "http://localhost:43002" });
  expect(serveDecision({ pid: 123, port: 43003, origins: [] }, "http://127.0.0.1:43002", zetaCommand).kind).toBe("origin-missing");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["https://example.test"] }, "http://127.0.0.1:43002", zetaCommand).kind).toBe("origin-missing");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002", null).kind).toBe("start");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002", "python unrelated.py").kind).toBe("start");
});

test("stop ownership requires pid, start time, and exact command", () => {
  const saved = { pid: 123, started: "Mon Jan  1 00:00:00 2024", command: "zeta serve --ws 43003" };
  expect(ownedProcessMatches(saved, { ...saved })).toBe(true);
  expect(ownedProcessMatches(saved, { ...saved, started: "Tue Jan  2 00:00:00 2024" })).toBe(false);
  expect(ownedProcessMatches(saved, { ...saved, command: "zeta serve --ws 43004" })).toBe(false);
  expect(ownedProcessMatches(saved, null)).toBe(false);
});
