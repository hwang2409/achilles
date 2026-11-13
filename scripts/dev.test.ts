import { expect, test } from "bun:test";
import { achillesDecision, mcpDecision, mcpUrl, ownedProcessMatches, serveDecision } from "./dev";

const zetaCommand = "/usr/local/bin/zeta serve --port 43001 --ws 43003 --provider ollama --model 'test model'";

test("serve discovery requires a live zeta process and an exact origin", () => {
  expect(serveDecision(null, "http://127.0.0.1:43002", null).kind).toBe("start");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002", zetaCommand).kind).toBe("reuse");
  const localhost = serveDecision({ pid: 123, port: 43003, origins: ["http://localhost:43002"] }, "http://127.0.0.1:43002", zetaCommand);
  expect(localhost).toMatchObject({ kind: "reuse", origin: "http://localhost:43002" });
  expect(serveDecision({ pid: 123, port: 43003, origins: [] }, "http://127.0.0.1:43002", zetaCommand)).toEqual({
    kind: "origin-missing",
    command: `${zetaCommand} --ws-origin 'http://127.0.0.1:43002'`,
  });
  expect(serveDecision({ pid: 123, port: 43003, origins: ["https://example.test"] }, "http://127.0.0.1:43002", zetaCommand).kind).toBe("origin-missing");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002", null).kind).toBe("start");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002", "python unrelated.py").kind).toBe("start");
});

test("reused localhost origin keeps the loopback MCP entry unchanged", () => {
  const selected = serveDecision(
    { pid: 123, port: 43003, origins: ["http://localhost:43002"] },
    "http://127.0.0.1:43002",
    zetaCommand,
  );
  expect(selected).toMatchObject({ kind: "reuse", origin: "http://localhost:43002" });
  expect(mcpDecision({ transport: "streamable-http", url: "http://127.0.0.1:43002/mcp/" }, mcpUrl(43002))).toEqual({ kind: "unchanged" });
});

test("an existing different MCP entry is left unchanged with an exact fix command", () => {
  expect(mcpDecision({ transport: "stdio", url: "http://old.test" }, "http://127.0.0.1:43002/mcp/")).toEqual({
    kind: "different",
    command: "zeta mcp remove achilles --scope user && zeta mcp add --scope user --url 'http://127.0.0.1:43002/mcp/' achilles",
  });
});

test("achilles restarts changed owned processes, reuses unchanged ones, and reports foreign ones", () => {
  const saved = { pid: 123, started: "Mon Jan  1 00:00:00 2024", command: "uv run achilles serve", stamp: "old" };
  const current = { ...saved };
  expect(achillesDecision(saved, current, "new", 123)).toEqual({ kind: "restart", saved });
  expect(achillesDecision(saved, current, "old", 123)).toEqual({ kind: "reuse" });
  expect(achillesDecision(saved, { ...current, pid: 456 }, "old", 456)).toEqual({ kind: "foreign", pid: 456 });
});

test("stop ownership requires pid, start time, and exact command", () => {
  const saved = { pid: 123, started: "Mon Jan  1 00:00:00 2024", command: "zeta serve --ws 43003" };
  expect(ownedProcessMatches(saved, { ...saved })).toBe(true);
  expect(ownedProcessMatches(saved, { ...saved, started: "Tue Jan  2 00:00:00 2024" })).toBe(false);
  expect(ownedProcessMatches(saved, { ...saved, command: "zeta serve --ws 43004" })).toBe(false);
  expect(ownedProcessMatches(saved, null)).toBe(false);
});
