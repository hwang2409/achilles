import { expect, test } from "bun:test";

// Chromium's restricted ports: https://chromium.googlesource.com/chromium/src/+/main/net/base/port_util.cc
const restrictedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

test("the real zeta gate never picks a Chromium-restricted port", async () => {
  // Evaluate just the port choice; importing the gate would start the stack.
  const source = await Bun.file(new URL("./real-zeta-gate.ts", import.meta.url)).text();
  const expression = source.match(/^const port = (.+);$/m)?.[1];
  if (!expression) throw new Error("could not find the gate's port expression");
  const pickPort = new Function("Math", `return ${expression}`);
  const blocked = new Set<number>();
  for (let step = 0; step < 10000; step++) {
    const port = pickPort({ floor: Math.floor, random: () => step / 10000 });
    if (restrictedPorts.has(port)) blocked.add(port);
  }
  expect([...blocked]).toEqual([]);
});
