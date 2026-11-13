import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeMcp, serveDecision } from "./dev";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
async function home() { const value = await mkdtemp(join(tmpdir(), "achilles-dev-")); homes.push(value); return value; }

test("mcp merge preserves content and makes one backup", async () => {
  const dir = await home(); const file = join(dir, "mcp.json");
  await writeFile(file, JSON.stringify({ other: { enabled: true }, servers: { existing: { url: "x" } } }));
  expect(await mergeMcp(file, "http://127.0.0.1:43001/mcp/")).toBe("changed");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ other: { enabled: true }, servers: { existing: { url: "x" }, achilles: { url: "http://127.0.0.1:43001/mcp/" } } });
  const backup = await readFile(`${file}.achilles-backup`, "utf8");
  expect(await mergeMcp(file, "http://127.0.0.1:43001/mcp/")).toBe("unchanged");
  expect(await readFile(`${file}.achilles-backup`, "utf8")).toBe(backup);
});

test("serve discovery reuses, starts, or reports missing origin", () => {
  expect(serveDecision(null, "http://127.0.0.1:43002").kind).toBe("start");
  expect(serveDecision({ pid: process.pid, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002").kind).toBe("reuse");
  const missing = serveDecision({ pid: process.pid, port: 43003, origins: ["http://localhost:43002"] }, "http://127.0.0.1:43002");
  expect(missing.kind).toBe("reuse");
  expect(serveDecision({ pid: process.pid, port: 43003, origins: ["https://example.test"] }, "http://127.0.0.1:43002").kind).toBe("origin-missing");
});
