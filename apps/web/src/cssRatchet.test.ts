import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// the css ratchet: raw values that tokens.css already names may only go down. a rise fails with the line and the token
// to use; a drop fails until the baseline below is lowered to the new count, so the ratchet tightens with every cleanup.
const root = import.meta.dir;

type Finding = { file: string; line: number; text: string; fix: string };
type Category = "raw px font-size" | "raw z-index" | "raw spacing" | "easing outside the tokens" | "ungated :hover";

const spaceScale = [1, 2, 3, 4, 5, 6, 7, 8, 10].map((step) => ({ step, px: step * 4 }));
const nearestSpace = (px: number) => spaceScale.reduce((best, s) => (Math.abs(s.px - px) < Math.abs(best.px - px) ? s : best));
const RAW_PX = /(?<![\w.-])-?\d*\.?\d+px\b/g;
const EASING = /(?<![\w-])(ease-in-out|ease-out|ease-in|ease|linear)(?![\w(-])/g;

// one pass over a sheet: every declaration and every style rule, with its line and the at-rules around it
function parse(text: string) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const decls: { prop: string; value: string; line: number }[] = [];
  const rules: { selector: string; line: number; parents: string[] }[] = [];
  const stack: string[] = [];
  let buf = "";
  let bufStart = 0;
  const lineAt = (i: number) => clean.slice(0, i).split("\n").length;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{" || ch === "}" || ch === ";") {
      const chunk = buf.trim();
      const at = lineAt(bufStart + buf.length - buf.trimStart().length);
      if (ch === "{") {
        if (!chunk.startsWith("@")) rules.push({ selector: chunk, line: at, parents: [...stack] });
        stack.push(chunk);
      } else if (chunk) {
        const colon = chunk.indexOf(":");
        if (colon > 0 && !chunk.startsWith("@")) decls.push({ prop: chunk.slice(0, colon).trim().toLowerCase(), value: chunk.slice(colon + 1).trim(), line: at });
      }
      if (ch === "}") stack.pop();
      buf = "";
      bufStart = i + 1;
    } else buf += ch;
  }
  return { decls, rules };
}

const TOKEN_CURVES = ["cubic-bezier(0.23, 1, 0.32, 1)", "cubic-bezier(0.77, 0, 0.175, 1)", "cubic-bezier(0.32, 0.72, 0, 1)"];
const RAW_LENGTH = /(?<![\w.-])-?(\d*\.?\d+)(px|rem|em)\b/g;
const spaceHint = (length: string, n: number, unit: string) => {
  const exact = unit === "px" ? spaceScale.find((s) => s.px === n) : undefined;
  if (exact) return `${length} -> var(--g1-space-${exact.step})`;
  const near = nearestSpace(unit === "px" ? n : n * 16);
  return `${length} has no exact token: use the nearest, var(--g1-space-${near.step}) (${near.px}px)`;
};

function scan(file: string, text: string): Record<Category, Finding[]> {
  const found: Record<Category, Finding[]> = { "raw px font-size": [], "raw z-index": [], "raw spacing": [], "easing outside the tokens": [], "ungated :hover": [] };
  const { decls, rules } = parse(text);
  for (const { prop, value: raw, line } of decls) {
    const value = raw.replace(/\s*!important\s*$/i, "");
    const at = { file, line, text: `${prop}: ${raw}` };
    // font-size, and the size in a font shorthand (the length before an optional /line-height)
    const sizes = prop === "font-size" ? [...value.matchAll(RAW_PX)] : prop === "font" ? [...value.matchAll(/(?<![\w./-])\d*\.?\d+px(?=\s*\/|\s)/g)] : [];
    for (const m of sizes) found["raw px font-size"].push({ ...at, fix: `${m[0]}: use a --g1-type-* token (xs, sm, md, lg, xl; --g1-type-input for fields on touch)` });
    if (prop === "z-index" && /^-?\d+$/.test(value)) found["raw z-index"].push({ ...at, fix: "use a --g1-z-* token (sticky, drawer, popover, modal, toast)" });
    if (/^(padding|margin)(-[a-z-]+)?$|^(row-|column-)?gap$/.test(prop)) {
      for (const m of value.matchAll(RAW_LENGTH)) found["raw spacing"].push({ ...at, fix: spaceHint(m[0], Math.abs(Number.parseFloat(m[1])), m[2]) });
    }
    if (/^(transition|animation)(-timing-function)?$/.test(prop)) {
      for (const m of value.matchAll(EASING)) {
        const token = m[1] === "ease-in-out" ? "--g1-ease-in-out" : m[1] === "linear" ? "a --g1-ease-* token" : "--g1-ease-out (or --g1-ease-drawer for an edge sheet)";
        found["easing outside the tokens"].push({ ...at, fix: `use ${token} instead of ${m[1]}` });
      }
      for (const m of value.matchAll(/cubic-bezier\([^)]*\)/g)) {
        const curve = m[0].replace(/\s+/g, " ").replace(/\(\s*/, "(").replace(/\s*\)/, ")").replace(/\s*,\s*/g, ", ").replace(/(?<![\d])\./g, "0.");
        if (!TOKEN_CURVES.includes(curve)) found["easing outside the tokens"].push({ ...at, fix: `${m[0]} is not a token curve: use --g1-ease-out, --g1-ease-in-out or --g1-ease-drawer` });
      }
    }
  }
  for (const { selector, line, parents } of rules) {
    const gated = parents.some((p) => p.startsWith("@media") && !/\bnot\b/.test(p) && /\(\s*hover\s*:\s*hover\s*\)/.test(p) && /\(\s*pointer\s*:\s*fine\s*\)/.test(p));
    if (selector.includes(":hover") && !gated) found["ungated :hover"].push({ file, line, text: selector, fix: "wrap it in @media (hover: hover) and (pointer: fine)" });
  }
  return found;
}

const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? cssFiles(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);

// counts per file on main after U1. lower a number when you remove raw values; never raise one
const baseline: Record<Category, Record<string, number>> = {
  "raw px font-size": {
    "agents/agents.css": 2,
    "chat/auth-error-recovery.css": 1,
    "chat/branches.css": 3,
    "chat/markdown.css": 1,
    "composer/composer.css": 5,
    "composer/path-completion.css": 1,
    "composer/vim-composer.css": 1,
    "create/create.css": 1,
    "jumpToLatest.css": 1,
    "library/library.css": 2,
    "page-chat-header.css": 1,
    "sessions/sessions.css": 1,
    "settings-dialog.css": 1,
    "shell.css": 7,
    "style.css": 6,
    "surface/surface.css": 2,
    "telemetry/session-detail.css": 2,
    "telemetry/telemetry.css": 3,
  },
  "raw z-index": {
    "agents/agents.css": 1,
    "chat/branches.css": 2,
    "chat/transcript.css": 1,
    "composer/composer-commands.css": 1,
    "composer/path-completion.css": 1,
    "composer/slash-menu.css": 1,
    "jumpToLatest.css": 1,
    "page-chat-header.css": 1,
    "page/EnumListbox.css": 1,
    "settings-dialog.css": 1,
    "shell.css": 12,
    "style.css": 2,
    "surface/surface.css": 2,
    "telemetry/session-detail.css": 1,
    "telemetry/telemetry.css": 1,
  },
  "raw spacing": {
    "accounts/accounts.css": 14,
    "agents/agents.css": 38,
    "chat/auth-error-recovery.css": 6,
    "chat/branches.css": 4,
    "chat/fulcrum-g1.css": 16,
    "chat/markdown.css": 28,
    "chat/tool-summary.css": 9,
    "chat/transcript.css": 14,
    "command-palette.css": 28,
    "composer/composer-commands.css": 8,
    "composer/composer.css": 21,
    "composer/path-completion.css": 5,
    "composer/slash-menu.css": 5,
    "composer/vim-composer.css": 2,
    "create/create.css": 25,
    "library/library.css": 74,
    "mcp/mcp.css": 30,
    "page-chat-header.css": 6,
    "page/EnumListbox.css": 11,
    "page/page-archive.css": 3,
    "page/pages-landing.css": 8,
    "projects/projects.css": 28,
    "sessions/sessions.css": 33,
    "settings-dialog.css": 33,
    "settings/settings-place.css": 15,
    "shell.css": 45,
    "style.css": 90,
    "surface/confirmation.css": 34,
    "surface/surface.css": 11,
    "telemetry/aggregates.css": 55,
    "telemetry/session-detail.css": 67,
    "telemetry/telemetry.css": 94,
  },
  "easing outside the tokens": {
    "chat/branches.css": 1,
    "composer/composer.css": 3,
    "shell.css": 5,
  },
  "ungated :hover": {
    "agents/agents.css": 2,
    "chat/branches.css": 2,
    "chat/fulcrum-g1.css": 5,
    "command-palette.css": 1,
    "composer/composer.css": 1,
    "composer/path-completion.css": 1,
    "composer/slash-menu.css": 1,
    "create/create.css": 1,
    "jumpToLatest.css": 1,
    "library/library.css": 1,
    "mcp/mcp.css": 1,
    "page-chat-header.css": 1,
    "page/EnumListbox.css": 1,
    "page/pages-landing.css": 1,
    "projects/projects.css": 1,
    "sessions/sessions.css": 5,
    "settings-dialog.css": 1,
    "shell.css": 3,
    "surface/confirmation.css": 2,
    "surface/surface.css": 2,
    "telemetry/aggregates.css": 1,
    "telemetry/session-detail.css": 1,
    "telemetry/telemetry.css": 3,
  },
};

const sheets = cssFiles(root).map((path) => ({ file: relative(root, path), text: readFileSync(path, "utf8") }));
const counts = sheets.map(({ file, text }) => ({ file, found: scan(file, text) }));

for (const category of Object.keys(baseline) as Category[]) {
  test(`css ratchet: ${category} does not grow`, () => {
    const problems: string[] = [];
    const files = new Set([...Object.keys(baseline[category]), ...counts.map((c) => c.file)]);
    for (const file of [...files].sort()) {
      const findings = counts.find((c) => c.file === file)?.found[category] ?? [];
      const allowed = baseline[category][file] ?? 0;
      if (findings.length > allowed) {
        problems.push(`${category} in ${file} went up from ${allowed} to ${findings.length}. new or moved lines, fix one of:`);
        for (const f of findings) problems.push(`  apps/web/src/${f.file}:${f.line}  ${f.text}  -> ${f.fix}`);
      } else if (findings.length < allowed) {
        problems.push(`${category} in ${file} went down from ${allowed} to ${findings.length}: lower its baseline in cssRatchet.test.ts to ${findings.length}${findings.length ? "" : " (delete the entry)"}`);
      }
    }
    expect(problems.join("\n")).toBe("");
  });
}

test("the ratchet sees what it guards", () => {
  const found = scan("probe.css", `
    .a { padding: 7px var(--g1-space-2); font-size: 12px; z-index: 3; transition: opacity 160ms ease; }
    .a:hover { color: red; }
    @media (hover: hover) and (pointer: fine) { .b:hover { color: red; } }
    @media (hover: hover) { .c:hover { color: red; } }
    .d { padding: 4px 7px 9px 13px; margin: .5rem 1em; font: 600 12px/20px sans-serif; z-index: 31 !important; transition: scale 1s cubic-bezier(.1, .9, .2, 1); }
    .e { padding: var(--g1-space-2); z-index: var(--g1-z-modal); background: linear-gradient(red, blue); transition: scale var(--g1-dur-press) var(--g1-ease-out), opacity 1s cubic-bezier(0.23, 1, 0.32, 1); }
  `);
  expect(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.map((f) => `${f.line} ${f.fix}`)]))).toEqual({
    "raw px font-size": ["2 12px: use a --g1-type-* token (xs, sm, md, lg, xl; --g1-type-input for fields on touch)", "6 12px: use a --g1-type-* token (xs, sm, md, lg, xl; --g1-type-input for fields on touch)"],
    "raw z-index": ["2 use a --g1-z-* token (sticky, drawer, popover, modal, toast)", "6 use a --g1-z-* token (sticky, drawer, popover, modal, toast)"],
    "raw spacing": [
      "2 7px has no exact token: use the nearest, var(--g1-space-2) (8px)",
      "6 4px -> var(--g1-space-1)",
      "6 7px has no exact token: use the nearest, var(--g1-space-2) (8px)",
      "6 9px has no exact token: use the nearest, var(--g1-space-2) (8px)",
      "6 13px has no exact token: use the nearest, var(--g1-space-3) (12px)",
      "6 .5rem has no exact token: use the nearest, var(--g1-space-2) (8px)",
      "6 1em has no exact token: use the nearest, var(--g1-space-4) (16px)",
    ],
    "easing outside the tokens": ["2 use --g1-ease-out (or --g1-ease-drawer for an edge sheet) instead of ease", "6 cubic-bezier(.1, .9, .2, 1) is not a token curve: use --g1-ease-out, --g1-ease-in-out or --g1-ease-drawer"],
    "ungated :hover": ["3 wrap it in @media (hover: hover) and (pointer: fine)", "5 wrap it in @media (hover: hover) and (pointer: fine)"],
  });
});
