import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fulcrum = process.env.FULCRUM_DIR;
if (!fulcrum) throw new Error("FULCRUM_DIR is required");
const pin = (await readFile(resolve(root, "fulcrum.rev"), "utf8")).trim();
const vendor = resolve(root, "vendor/fulcrum");
const packages = ["core", "react", "virtual", "markdown", "highlight"];

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", fulcrum, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

if (git("rev-parse", "HEAD") !== pin) throw new Error(`FULCRUM_DIR must be at ${pin}`);
if (git("status", "--porcelain")) throw new Error("FULCRUM_DIR must be clean");
const run = (args: string[], cwd: string) => {
  const result = Bun.spawnSync(args, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} failed`);
};

run(["bun", "run", "build:packages"], fulcrum);
await rm(vendor, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });
for (const name of packages) {
  run(["bun", "pm", "pack", "--filename", resolve(vendor, `fulcrum-${name}.tgz`)], resolve(fulcrum, "packages", name));
}
const app = resolve(root, "apps/web");
const packageFile = resolve(app, "package.json");
const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
const fulcrumDependencies = Object.fromEntries(Object.entries(packageJson.dependencies).filter(([name]) => name.startsWith("@fulcrum/")));
for (const name of Object.keys(fulcrumDependencies)) delete packageJson.dependencies[name];
await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
try {
  run(["bun", "install", "--no-progress"], app);
} finally {
  await writeFile(packageFile, `${JSON.stringify({ ...packageJson, dependencies: { ...packageJson.dependencies, ...fulcrumDependencies } }, null, 2)}\n`);
}
for (const name of packages) {
  const target = resolve(app, "node_modules", "@fulcrum", name);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  run(["tar", "-xzf", resolve(vendor, `fulcrum-${name}.tgz`), "--strip-components=1", "-C", target], app);
}
