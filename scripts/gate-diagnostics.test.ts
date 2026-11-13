import { expect, test } from "bun:test";
import { controlSnapshot, diagnostic, failureMessage } from "./gate-diagnostics";

const fake = "fake-secret-token";
test("diagnostics redact all secret-shaped values", () => {
  const input = {
    token: fake,
    controller_token: fake,
    observer_token: fake,
    Authorization: `Bearer ${fake}`,
    mcp_bindings: [{ headers: { Authorization: `Bearer ${fake}` } }],
    page: `credential=${fake}`,
  };
  const output = [diagnostic(input, [fake]), controlSnapshot(JSON.stringify(input), [fake]), failureMessage([input, `Bearer ${fake}`], [fake])].join(" ");
  expect(output).not.toContain(fake);
});
