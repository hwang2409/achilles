import { expect, test } from "bun:test";
import { controlSnapshot, createFrameRing, diagnostic } from "./gate-diagnostics";

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

test("websocket diagnostics keep only the last safe delivery fields", () => {
  const ring = createFrameRing(2);
  ring.record(0, "sent", JSON.stringify({ id: 7, method: "steer", params: { delivery_id: "delivery-7", text: fake, token: fake } }));
  ring.record(0, "received", JSON.stringify({ id: 7, error: { code: -32009, message: fake }, result: { token: fake } }));
  ring.record(1, "received", JSON.stringify({ method: "delivery_status", params: { delivery_id: "delivery-8", text: fake, token: fake } }));
  expect(ring.snapshot()).toEqual([
    { direction: "received", method: "steer", delivery_id: "delivery-7", error_code: -32009 },
    { direction: "received", method: "delivery_status", delivery_id: "delivery-8" },
  ]);
  expect(JSON.stringify(ring.snapshot())).not.toContain(fake);
});
