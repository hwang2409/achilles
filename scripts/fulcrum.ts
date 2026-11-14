import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fulcrum = process.env.FULCRUM_DIR;
if (!fulcrum) throw new Error("FULCRUM_DIR is required");
const pin = (await readFile(resolve(root, "fulcrum.rev"), "utf8")).trim();
const vendor = resolve(root, "vendor/fulcrum");
const packages = ["core", "react", "virtual", "markdown", "highlight", "zeta"];

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

async function buildVendor() {
  run(["bun", "run", "build:packages"], fulcrum);
  await rm(vendor, { recursive: true, force: true });
  await mkdir(vendor, { recursive: true });
  for (const name of packages) {
    run(["bun", "pm", "pack", "--filename", resolve(vendor, `fulcrum-${name}.tgz`)], resolve(fulcrum, "packages", name));
  }
}

async function installedPackageMatches(app: string, name: string) {
  try {
    const expected = JSON.parse(Bun.spawnSync(["tar", "-xOf", resolve(vendor, `fulcrum-${name}.tgz`), "package/package.json"]).stdout.toString());
    const installed = JSON.parse(await readFile(resolve(app, "node_modules", "@fulcrum", name, "package.json"), "utf8"));
    return installed.name === expected.name && installed.version === expected.version;
  } catch {
    return false;
  }
}

async function archiveDigest() {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const name of packages) hasher.update(await Bun.file(resolve(vendor, `fulcrum-${name}.tgz`)).arrayBuffer());
  return hasher.digest("hex");
}

export async function prepareWebDependencies(force = false) {
  const app = resolve(root, "apps/web");
  const digest = await archiveDigest();
  const marker = resolve(app, "node_modules/@fulcrum/.achilles-digest");
  if (!force && await Bun.file(marker).text().then(value => value.trim() === digest, () => false)) return;

  const packageFile = resolve(app, "package.json");
  const original = await readFile(packageFile, "utf8");
  const packageJson = JSON.parse(original);
  const fulcrumDependencies = Object.fromEntries(Object.entries(packageJson.dependencies).filter(([name]) => name.startsWith("@fulcrum/")));
  for (const name of Object.keys(fulcrumDependencies)) delete packageJson.dependencies[name];
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  try {
    run(["bun", "install", "--frozen-lockfile", "--no-progress"], app);
  } finally {
    await writeFile(packageFile, original);
    if (await readFile(packageFile, "utf8") !== original) throw new Error("apps/web/package.json was not restored byte-identically");
  }
  for (const name of packages) {
    const target = resolve(app, "node_modules", "@fulcrum", name);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    run(["tar", "-xzf", resolve(vendor, `fulcrum-${name}.tgz`), "--strip-components=1", "-C", target], app);
  }
  await writeFile(marker, `${digest}\n`);
}

if (process.argv.includes("--prepare-web")) {
  if (!(await Promise.all(packages.map(name => Bun.file(resolve(vendor, `fulcrum-${name}.tgz`)).exists())).then(results => results.every(Boolean)))) await buildVendor();
  await prepareWebDependencies();
} else {
  await buildVendor();
  await prepareWebDependencies(true);
}
