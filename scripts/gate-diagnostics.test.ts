import { expect, test } from "bun:test";
import { controlSnapshot, diagnostic } from "./gate-diagnostics";

const fake = "fake-secret-token";
test("diagnostics redact all secret-shaped values", () => {
  const input = {
    token: fake,
    controller_token: fake,
    observer_token: fake,
    Authorization: `Bearer ${fake}`,
    mcp_bindings: [{ headers: { Authorization: `Bearer ${fake}` } }],
    page: `credential=${fake}`,
    body: `page body ${fake}`,
    response_text: `mcp response ${fake}`,
  };
  const output = [diagnostic(input, [fake]), controlSnapshot(JSON.stringify(input), [fake]), diagnostic(`Bearer ${fake}`, [fake])].join(" ");
  expect(output).not.toContain(fake);
});
