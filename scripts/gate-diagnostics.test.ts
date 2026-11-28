import { expect, test } from "bun:test";
import { controlSnapshot, createFrameRing, createGateWait, desktopPageChatProof, diagnostic, redactArtifact, storageDiff } from "./gate-diagnostics";

const fake = "fake-secret-token";

test("desktop page chat proof uses the docked surface, not the mobile bar", () => {
  expect(desktopPageChatProof({
    mobileQuery: false,
    barVisible: false,
    docked: true,
    surfaceVisible: true,
    surfaceRole: null,
    surfaceAriaModal: null,
    evidenceVisible: true,
    evidenceHit: true,
    evidenceInsideSurface: true,
  })).toBe(true);
  expect(desktopPageChatProof({
    mobileQuery: false,
    barVisible: false,
    docked: true,
    surfaceVisible: true,
    surfaceRole: null,
    surfaceAriaModal: null,
    evidenceVisible: false,
    evidenceHit: false,
    evidenceInsideSurface: false,
  })).toBe(false);
});

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

test("artifact lines redact credential shapes without a known secret, and keep JSON valid", () => {
  const lines = [
    JSON.stringify({ method: "hello", params: { controller_token: fake, mcp_bindings: [{ headers: { Authorization: `Bearer ${fake}` } }] } }),
    `INFO bind {'Authorization': 'Bearer ${fake}'} at /home/tester/zeta`,
    `credential=${fake}&x=1 token: ${fake}`,
    JSON.stringify({ text: JSON.stringify({ controller_token: fake }) }),
    JSON.stringify({ url: `http://127.0.0.1/?token=${fake}` }),
    `Sec-WebSocket-Protocol: zeta.bearer.${fake}`,
    `Cookie: session=${fake}; other=${fake}`,
    `set-cookie: a=${fake}; Path=/`,
    `authorization: Basic ${fake}`,
    `x-api-key: ${fake}`,
    `password=${fake} client_secret: ${fake}`,
    JSON.stringify({ password: fake, client_secret: fake }),
    `headers=[(b'x-api-key', b'${fake}')]`,
  ];
  const output = lines.map((line) => redactArtifact(line, [], "/home/tester"));
  for (const line of output) expect(line).not.toContain(fake);
  expect(output.join("\n")).not.toContain("/home/tester");
  expect(output[1]).toContain("INFO bind");
  for (const index of [0, 3, 4]) expect(() => JSON.parse(output[index])).not.toThrow();
  expect(redactArtifact(`unlisted ${fake}`, [fake], "/home/tester")).toBe("unlisted [redacted]");
});

test.each([
  { name: "success", fail: false },
  { name: "timeout prints frames and control", fail: true },
])("gate wait: $name", async ({ fail }) => {
  const ring = createFrameRing();
  ring.record(0, "sent", JSON.stringify({ id: 7, method: "send", params: { delivery_id: "delivery-7", text: fake } }));
  ring.record(0, "received", JSON.stringify({ method: "event", params: { event: "agent_start" } }));
  const gateWait = createGateWait(ring.snapshot, async () => '{"request_count":7,"turn_barrier":"held"}');
  const playwright = { ready: async () => {
    if (fail) throw new Error("Timeout 30ms exceeded");
    return "ready";
  } };
  if (!fail) {
    expect(await gateWait.playwright(playwright, "ready")).toBe("ready");
    return;
  }
  await expect(gateWait.playwright(playwright, "ready")).rejects.toThrow(
    'Timeout 30ms exceeded; websocket frames=[{"direction":"sent","method":"send","delivery_id":"delivery-7"},{"direction":"received","method":"event","event":"agent_start"}]; backend catalog={"request_count":7,"turn_barrier":"held"}',
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

test("storage diff names keys only before, only after, and changed values; key order alone is no diff", () => {
  expect(storageDiff(JSON.stringify({ a: "1", b: "2" }), JSON.stringify({ b: "2", a: "1" }))).toBe("");
  expect(storageDiff(JSON.stringify({ gone: "x", same: "s", moved: "old" }), JSON.stringify({ moved: "new", same: "s", added: "y".repeat(5) }), 3))
    .toBe("only before: gone=x\nonly after: added=yyy...\nchanged: moved: old -> new");
});

test("no gate script compares JSON.stringify dumps of localStorage as strings; chromium lists keys in hash order, so use storageDiff", async () => {
  const dump = /JSON\.stringify\(\s*(\{\s*\.\.\.\s*localStorage\s*\}|localStorage)\s*\)/;
  const found: string[] = [];
  for (const name of new Bun.Glob("*.ts").scanSync(import.meta.dir)) {
    if (name === "gate-diagnostics.ts" || name.endsWith(".test.ts")) continue;
    const lines = (await Bun.file(`${import.meta.dir}/${name}`).text()).split("\n");
    const dumpNames = lines.flatMap((line) => dump.test(line) ? [...line.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)].map((match) => match[1]) : []);
    // shortcut: a line that string-compares and names a dump or a dump variable; data flow through other names is not traced
    lines.forEach((line, index) => {
      if (/[!=]==/.test(line) && (dump.test(line) || dumpNames.some((variable) => new RegExp(`\\b${variable}\\b`).test(line)))) found.push(`${name}:${index + 1}`);
    });
  }
  expect(found, `compare localStorage dumps with storageDiff (scripts/gate-diagnostics.ts), not as strings: ${found.join(", ")}`).toEqual([]);
});
