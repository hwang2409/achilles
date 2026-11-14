import { expect, test } from "bun:test";

const forbidden = [
  String.raw`\.waitFor\(`,
  String.raw`waitForResponse\(`,
  String.raw`waitForFunction\(`,
  String.raw`waitForURL\(`,
  String.raw`waitForEvent\(`,
  String.raw`waitForSelector\(`,
];

test("gate waits use the diagnostic owner", async () => {
  const files = [
    ...new Bun.Glob("scripts/gate-*.ts").scanSync({ cwd: process.cwd(), absolute: true }),
    `${process.cwd()}/scripts/real-zeta-gate.ts`,
  ].filter((path) => !path.endsWith("gate-diagnostics.ts") && !path.endsWith("gate-wait-owner.test.ts"));
  const violations: string[] = [];
  const pattern = new RegExp(forbidden.join("|"));
  for (const path of files) {
    const relative = path.slice(process.cwd().length + 1);
    const lines = (await Bun.file(path).text()).split("\n");
    for (const [index, line] of lines.entries()) {
      const owned = line.indexOf("gateWait(() =>") < line.search(pattern);
      if (pattern.test(line) && !owned) violations.push(`${relative}:${index + 1}`);
    }
  }
  expect(violations, `${violations.join("\n")}\nuse the gate wait owner (createGateWait) so timeouts print frames`).toEqual([]);
});
