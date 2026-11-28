import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// firm edges: tokens.css owns the radius scale, and no stylesheet rounds past it or animates every property
const root = import.meta.dir;
const RADIUS_MAX_PX = 4;
const tokens = readFileSync(join(root, "tokens.css"), "utf8");
const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? cssFiles(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);
const sheets = cssFiles(root).map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));

test("every radius token is 4px or less; only the dot token is round", () => {
  const radii = Object.fromEntries([...tokens.matchAll(/(--g1-radius-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  expect(radii).toEqual({ "--g1-radius-container": "4px", "--g1-radius-chat": "4px", "--g1-radius-control": "2px", "--g1-radius-dot": "50%" });
});

test("no stylesheet hardcodes a radius above the token max or a round corner", () => {
  const offenders = sheets.filter(({ path }) => path !== "tokens.css").flatMap(({ path, text }) =>
    [...text.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)].flatMap((m) => {
      const value = m[1].replace(/var\(--g1-radius-[\w-]+\)/g, "");
      const tooBig = [...value.matchAll(/(\d*\.?\d+)px/g)].some((px) => Number(px[1]) > RADIUS_MAX_PX);
      return tooBig || /%/.test(value) ? [`${path}: ${m[0].trim()}`] : [];
    }));
  expect(offenders).toEqual([]);
});

test("no stylesheet transitions every property", () => {
  const offenders = sheets.flatMap(({ path, text }) =>
    [...text.matchAll(/transition(?:-property)?\s*:\s*([^;}]+)/g)].filter((m) => /(^|[\s,])all\b/.test(m[1])).map((m) => `${path}: ${m[0].trim()}`));
  expect(offenders).toEqual([]);
});

test("full-width row buttons are excluded from the press shrink", () => {
  const style = sheets.find(({ path }) => path === "style.css")!.text;
  const press = style.match(/:where\(:not\(([^)]*)\)\):active\s*\{\s*scale:\s*var\(--g1-press-scale\)/);
  const excluded = press?.[1].split(",").map((part) => part.trim()) ?? [];
  const rows = [".agents-row", ".td-agent-row", ".td-turn-row", ".td-span-row", ".projects-entry", ".load-older"];
  expect(rows.filter((row) => !excluded.includes(row))).toEqual([]);
});
