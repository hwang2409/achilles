import { expect, test } from "bun:test";
import { mcpReadFailure, projectMcpList, type McpScope } from "./mcpReads";

const revision = "a".repeat(64);
const list = (...items: unknown[]) => ({ revision, data: { items } });
const stdio = { transport: "stdio", command: "<redacted>", args: ["<redacted>"] };
const http = { transport: "streamable-http", url: "<redacted-url>", auth: { type: "oauth", client_secret: "<redacted>" } };
const user = { name: "sample", scope: "user", enabled: true, trusted: true, status: "configured", auth: "none", tool_count: 0, config: stdio };
const project = { ...user, scope: "project", trusted: false, status: "pending trust" };

const valid = [
  ["effective", project, "pending trust"],
  ["user", user, "configured"],
  ["project", { ...project, status: "disabled", enabled: false }, "disabled"],
  ["project", { ...project, status: "skipped-missing-env", trusted: true }, "skipped-missing-env"],
  ["effective", { ...user, status: "malformed", enabled: false, trusted: false, config: {} }, "malformed"],
] as const;
test("accepts an unknown (null) tool count", () => {
  expect(projectMcpList(list({ ...user, tool_count: null }), "user")?.[0]?.toolCount).toBeNull();
});

test.each(valid)("%s projects its concrete row (%j)", (scope, row, status) => {
  expect(projectMcpList(list(row), scope)).toEqual([{
    name: row.name, scope: row.scope, status, enabled: row.enabled, trusted: row.trusted, auth: "none", toolCount: 0,
    config: { transport: status === "malformed" ? null : "stdio", commandProvided: status !== "malformed", urlProvided: false,
      args: status === "malformed" ? 0 : 1, env: 0, headers: 0, oauth: null },
  }]);
});

const invalid: [string, unknown, McpScope][] = [
  ["bad top", { ...list(user), revision: "bad" }, "user"],
  ["bad data", { revision, data: { items: {} } }, "effective"],
  ["bad row", list(user, null), "effective"],
  ["bad identity", list({ ...user, name: "line\u000attwo" }), "user"],
  ["wrong scope", list(project), "user"],
  ["effective duplicate", list(user, project), "effective"],
  ["unknown status", list({ ...user, status: "connected" }), "user"],
  ["unknown auth", list({ ...user, auth: "signed_in" }), "user"],
  ["bad row count", list({ ...user, tool_count: -2 }), "user"],
  ["bad config", list({ ...user, config: [] }), "user"],
  ["unknown transport", list({ ...user, config: { ...stdio, transport: "tcp" } }), "user"],
];
test.each(invalid)("rejects %s", (_label, input, scope) => {
  expect(projectMcpList(input, scope)).toBeNull();
});

const canary = (field: string) => `synthetic-${field}-canary`;
const withConfig = (config: unknown) => list({ ...user, config });
const secretCases: [string, unknown, boolean][] = [
  ["command", withConfig({ ...stdio, command: canary("command") }), false],
  ["argument", withConfig({ ...stdio, args: [canary("argument")] }), false],
  ["url", withConfig({ ...http, url: canary("url") }), false],
  ["env key", withConfig({ ...stdio, env: { [canary("env key")]: "<redacted>" } }), true],
  ["env value", withConfig({ ...stdio, env: { EXAMPLE: canary("env value") } }), false],
  ["header key", withConfig({ ...http, headers: { [canary("header key")]: "<redacted>" } }), true],
  ["header value", withConfig({ ...http, headers: { Example: canary("header value") } }), false],
  ["client secret", withConfig({ ...http, auth: { type: "oauth", client_secret: canary("client secret") } }), false],
  ["unknown config", withConfig({ ...http, future: canary("unknown config") }), true],
  ["unknown oauth", withConfig({ ...http, auth: { ...http.auth, client_id: canary("unknown oauth") } }), true],
  ["unknown row", list({ ...user, future: canary("unknown row") }), true],
  ["unknown top", { ...list(user), future: canary("unknown top") }, true],
];
test.each(secretCases)("never projects the %s canary", (field, input, accepted) => {
  const rows = projectMcpList(input, "effective");
  expect(JSON.stringify(rows)).not.toContain(canary(field));
  expect(rows !== null).toBe(accepted);
});

test("only sends safe fields to the error details view", () => {
  const fields = ["message", "path", "reason", "details"];
  const projected = mcpReadFailure({ code: -32005, message: canary("message"), data: {
    path: canary("path"), reason: canary("reason"), details: canary("details"),
  } });
  for (const field of fields) expect(JSON.stringify(projected)).not.toContain(canary(field));
  expect(projected).toEqual({ method: "mcp_server_list", code: -32005, reason: "state_unavailable" });
});
