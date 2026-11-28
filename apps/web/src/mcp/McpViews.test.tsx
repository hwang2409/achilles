import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, test } from "bun:test";
import { projectMcpList, type McpRow } from "./mcpReads";
import { ConnectionDetail } from "./McpViews";
// bun links CommonJS react-dom before this file's imports run, so it loads only after the DOM above exists.
const { cleanup, render } = await import("@testing-library/react");

afterEach(() => { cleanup(); document.body.replaceChildren(); });

// a never-tested server as zeta f5efa62d lists it: mcp_server_list is a disk view, so tool_count is 0 or a value nobody probed.
const listed = (toolCount: number) => projectMcpList({ revision: "a".repeat(64), data: { items: [{ name: "fixture", scope: "user", enabled: true,
  trusted: true, status: "configured", auth: "none", tool_count: toolCount, config: { transport: "stdio", command: "<redacted>" } }] } }, "user")![0] as McpRow;

function tools(row: McpRow, tested?: { status: "ok" | "failed"; toolCount: number }) {
  const ui = render(<ConnectionDetail row={row} detailOpen offline={false} heading={{ current: null }} shadows={() => null}
    detailList={undefined} project={false} go={() => {}} failure={() => null} tested={tested ?? null}>{null}</ConnectionDetail>);
  return { heading: ui.getByRole("heading", { level: 3, name: /^Tools/ }).textContent, text: ui.container.textContent ?? "" };
}

test("an untested connection says its tools are not loaded, never 0 tools", () => {
  const view = tools(listed(0));
  expect(view.heading).toBe("Tools");
  expect(view.text).toContain("tools not loaded");
  expect(view.text).toContain("test connection lists its tools");
  expect(view.text).not.toContain("No tools reported");
});

test("a failed test still says the tools are not loaded", () => {
  const view = tools(listed(0), { status: "failed", toolCount: 0 });
  expect(view.heading).toBe("Tools");
  expect(view.text).toContain("tools not loaded");
});

test("after a test the tools heading shows the tested count", () => {
  const view = tools(listed(0), { status: "ok", toolCount: 3 });
  expect(view.heading).toBe("Tools (3)");
  expect(view.text).not.toContain("tools not loaded");
  expect(view.text).not.toContain("No tools reported");
});

test("a test with 0 tools says no tools reported, whatever the list count says", () => {
  const view = tools(listed(4), { status: "ok", toolCount: 0 });
  expect(view.heading).toBe("Tools (0)");
  expect(view.text).toContain("No tools reported");
  expect(view.text).not.toContain("tools not loaded");
});
