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

const declared = [...tokens.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--g1-[\w-]+):\s*([^;]+);/g)].map((m) => ({ name: m[1], value: m[2].trim() }));
const token = (name: string) => declared.filter((d) => d.name === name).map((d) => d.value);

test("every token is written once: dark values live beside the light ones, not in a second copy", () => {
  const repeated = [...new Set(declared.map((d) => d.name).filter((name, i, all) => all.indexOf(name) !== i))];
  expect(repeated).toEqual([]);
  // the system-scheme block only picks the side for auto; it holds no color
  expect([...tokens.matchAll(/@media \(prefers-color-scheme: dark\) \{([^@]*?\})\s*\}/g)].map((m) => m[1].replace(/^[^{]*\{|\}$/g, "").trim())).toEqual(["color-scheme: dark;"]);
  expect(token("--g1-bg")).toEqual(["light-dark(#FFFFFF, #161616)"]);
});

test("the token layer names type, weight, motion, stacking, state strength and the scrim", () => {
  const names = ["--g1-type-xs", "--g1-type-sm", "--g1-type-md", "--g1-type-lg", "--g1-type-xl", "--g1-type-input", "--g1-weight-regular", "--g1-weight-strong",
    "--g1-ease-out", "--g1-ease-in-out", "--g1-ease-drawer", "--g1-dur-press", "--g1-dur-popover", "--g1-dur-sheet",
    "--g1-z-sticky", "--g1-z-drawer", "--g1-z-popover", "--g1-z-modal", "--g1-z-toast", "--g1-hover", "--g1-selected", "--g1-selected-bar", "--g1-muted-on-selected", "--g1-scrim"];
  expect(Object.fromEntries(names.map((name) => [name, token(name)[0]]))).toEqual({
    "--g1-type-xs": "calc(var(--g1-type-md) - 3px)",
    "--g1-type-sm": "calc(var(--g1-type-md) - 2px)",
    "--g1-type-md": "var(--achilles-ui-size, var(--g1-type-chat))",
    "--g1-type-lg": "calc(var(--g1-type-md) + 3px)",
    "--g1-type-xl": "calc(var(--g1-type-md) + 5px)",
    "--g1-type-input": "max(16px, 1em)",
    "--g1-weight-regular": "400",
    "--g1-weight-strong": "600",
    "--g1-ease-out": "cubic-bezier(0.23, 1, 0.32, 1)",
    "--g1-ease-in-out": "cubic-bezier(0.77, 0, 0.175, 1)",
    "--g1-ease-drawer": "cubic-bezier(0.32, 0.72, 0, 1)",
    "--g1-dur-press": "120ms",
    "--g1-dur-popover": "160ms",
    "--g1-dur-sheet": "240ms",
    "--g1-z-sticky": "2",
    "--g1-z-drawer": "10",
    "--g1-z-popover": "20",
    "--g1-z-modal": "30",
    "--g1-z-toast": "40",
    "--g1-hover": "light-dark(color-mix(in srgb, var(--g1-fg) 7%, transparent), color-mix(in srgb, var(--g1-fg) 8%, transparent))",
    "--g1-selected": "color-mix(in srgb, var(--g1-fg) 12%, transparent)",
    "--g1-selected-bar": "var(--g1-selection-width) solid var(--g1-selection)",
    "--g1-muted-on-selected": "light-dark(#5C5C5C, #B3B3B3)",
    "--g1-scrim": "transparent",
  });
});

test("the page tells the browser its bar color, taken from the live canvas color", () => {
  const html = readFileSync(join(root, "..", "index.html"), "utf8");
  expect(html).toContain('<meta name="theme-color" />');
  expect(html).toContain('attributeFilter: ["data-achilles-theme"]');
});

// [light, dark] for a colour token: one light-dark() value, or (older layout) a light copy then a dark copy
const sides = (name: string): [string, string] => {
  const values = token(name);
  const pair = values[0]?.match(/^light-dark\(\s*(#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\s*\)$/);
  return pair ? [pair[1], pair[2]] : [values[0], values[1]];
};
const channel = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("muted text in a selected row reads at 4.5:1 or more on the selected fill, in both themes, over every surface", () => {
  const percents = token("--g1-selected").map((v) => Number(v.match(/(\d+)%/)?.[1]) / 100);
  const muted = token("--g1-muted-on-selected").length ? sides("--g1-muted-on-selected") : sides("--g1-muted");
  const ratios = ([0, 1] as const).flatMap((side) => {
    const fg = channel(sides("--g1-fg")[side]);
    const share = percents[side] ?? percents[0];
    return ["--g1-bg", "--g1-bg-subtle", "--g1-sidebar"].map((surface) => {
      const fill = channel(sides(surface)[side]).map((v, i) => share * fg[i] + (1 - share) * v);
      return Math.round(contrast(channel(muted[side]), fill) * 100) / 100;
    });
  });
  expect(ratios.filter((ratio) => ratio < 4.5)).toEqual([]);
  expect(ratios).toEqual([5.14, 4.73, 4.73, 6.28, 5.15, 4.81]);
});
