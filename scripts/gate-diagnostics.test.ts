import { expect, test } from "bun:test";
import { controlSnapshot, createFrameRing, createGateWait, diagnostic } from "./gate-diagnostics";

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

test.each([
  { name: "success", fail: false },
  { name: "timeout prints frames and control", fail: true },
])("gate wait: $name", async ({ fail }) => {
  const ring = createFrameRing();
  ring.record(0, "sent", JSON.stringify({ id: 7, method: "send", params: { delivery_id: "delivery-7", text: fake } }));
  const gateWait = createGateWait(ring.snapshot, async () => '{"request_count":7}');
  if (!fail) {
    expect(await gateWait(async () => "ready")).toBe("ready");
    return;
  }
  expect(gateWait(async () => { throw new Error("Timeout 30ms exceeded"); })).rejects.toThrow(
    'Timeout 30ms exceeded; websocket frames=[{"direction":"sent","method":"send","delivery_id":"delivery-7"}]; backend catalog={"request_count":7}',
  );
});

test("websocket diagnostics keep and collapse safe delivery status fields", () => {
  const ring = createFrameRing(2);
  ring.record(0, "sent", JSON.stringify({ id: 7, method: "steer", params: { delivery_id: "delivery-7", text: fake, token: fake } }));
  ring.record(0, "received", JSON.stringify({ id: 7, error: { code: -32009, message: fake }, result: { token: fake } }));
  for (const id of [8, 9]) {
    ring.record(1, "sent", JSON.stringify({ id, method: "delivery_status", params: { delivery_id: "delivery-8", token: fake } }));
    ring.record(1, "received", JSON.stringify({ id, result: { delivery_id: "delivery-8", status: "queued", token: fake } }));
  }
  expect(ring.snapshot()).toEqual([
    { direction: "received", method: "steer", delivery_id: "delivery-7", error_code: -32009 },
    { direction: "received", method: "delivery_status", delivery_id: "delivery-8", status: "queued", count: 2 },
  ]);
  expect(JSON.stringify(ring.snapshot())).not.toContain(fake);
});
