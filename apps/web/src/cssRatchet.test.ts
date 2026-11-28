import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// the css ratchet: raw values that tokens.css already names may only go down. a rise fails with the line and the token
// to use; a drop fails until the baseline below is lowered to the new count, so the ratchet tightens with every cleanup.
const root = import.meta.dir;

type Finding = { file: string; line: number; text: string; fix: string };
type Category = "raw px font-size" | "raw z-index" | "raw px spacing" | "built-in easing" | "ungated :hover";

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

function scan(file: string, text: string): Record<Category, Finding[]> {
  const found: Record<Category, Finding[]> = { "raw px font-size": [], "raw z-index": [], "raw px spacing": [], "built-in easing": [], "ungated :hover": [] };
  const { decls, rules } = parse(text);
  for (const { prop, value, line } of decls) {
    const at = { file, line, text: `${prop}: ${value}` };
    if (prop === "font-size" && RAW_PX.test(value)) found["raw px font-size"].push({ ...at, fix: "use a --g1-type-* token (xs, sm, md, lg, xl; --g1-type-input for fields on touch)" });
    RAW_PX.lastIndex = 0;
    if (prop === "z-index" && /^-?\d+$/.test(value)) found["raw z-index"].push({ ...at, fix: "use a --g1-z-* token (sticky, drawer, popover, modal, toast)" });
    if (/^(padding|margin)(-[a-z-]+)?$|^(row-|column-)?gap$/.test(prop)) {
      const raw = [...value.matchAll(RAW_PX)].map((m) => Math.abs(Number.parseFloat(m[0])));
      if (raw.length) {
        const tokens = [...new Set(raw.map((px) => `${px}px -> var(--g1-space-${nearestSpace(px).step}) (${nearestSpace(px).px}px)`))];
        found["raw px spacing"].push({ ...at, fix: `use a --g1-space-* token: ${tokens.join(", ")}` });
      }
    }
    if (/^(transition|animation)(-timing-function)?$/.test(prop)) {
      for (const m of value.matchAll(EASING)) {
        const token = m[1] === "ease-in-out" ? "--g1-ease-in-out" : m[1] === "linear" ? "a --g1-ease-* token" : "--g1-ease-out (or --g1-ease-drawer for an edge sheet)";
        found["built-in easing"].push({ ...at, fix: `use ${token} instead of ${m[1]}` });
      }
    }
  }
  for (const { selector, line, parents } of rules) {
    const gated = parents.some((p) => p.startsWith("@media") && /\(\s*hover\s*:\s*hover\s*\)/.test(p));
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
    "composer/composer.css": 4,
    "composer/vim-composer.css": 1,
    "create/create.css": 1,
    "jumpToLatest.css": 1,
    "library/library.css": 2,
    "page-chat-header.css": 1,
    "sessions/sessions.css": 1,
    "settings-dialog.css": 1,
    "shell.css": 6,
    "style.css": 6,
    "surface/surface.css": 2,
    "telemetry/session-detail.css": 2,
    "telemetry/telemetry.css": 3,
  },
  "raw z-index": {
    "agents/agents.css": 1,
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
  "raw px spacing": {
    "accounts/accounts.css": 12,
    "agents/agents.css": 28,
    "chat/auth-error-recovery.css": 5,
    "chat/fulcrum-g1.css": 11,
    "chat/markdown.css": 19,
    "chat/tool-summary.css": 4,
    "chat/transcript.css": 8,
    "command-palette.css": 19,
    "composer/composer-commands.css": 6,
    "composer/composer.css": 17,
    "composer/path-completion.css": 3,
    "composer/slash-menu.css": 4,
    "composer/vim-composer.css": 2,
    "create/create.css": 22,
    "library/library.css": 61,
    "mcp/mcp.css": 26,
    "page-chat-header.css": 4,
    "page/EnumListbox.css": 7,
    "page/pages-landing.css": 5,
    "projects/projects.css": 23,
    "sessions/sessions.css": 28,
    "settings-dialog.css": 29,
    "settings/settings-place.css": 12,
    "shell.css": 35,
    "style.css": 68,
    "surface/confirmation.css": 24,
    "surface/surface.css": 10,
    "telemetry/aggregates.css": 46,
    "telemetry/session-detail.css": 56,
    "telemetry/telemetry.css": 76,
  },
  "built-in easing": {
    "composer/composer.css": 3,
    "shell.css": 5,
  },
  "ungated :hover": {
    "agents/agents.css": 2,
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
    .c { padding: var(--g1-space-2); z-index: var(--g1-z-modal); background: linear-gradient(red, blue); transition: scale var(--g1-dur-press) var(--g1-ease-out); }
  `);
  expect(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.map((f) => `${f.line} ${f.text}`)]))).toEqual({
    "raw px font-size": ["2 font-size: 12px"],
    "raw z-index": ["2 z-index: 3"],
    "raw px spacing": ["2 padding: 7px var(--g1-space-2)"],
    "built-in easing": ["2 transition: opacity 160ms ease"],
    "ungated :hover": ["3 .a:hover"],
  });
  expect(found["raw px spacing"][0].fix).toBe("use a --g1-space-* token: 7px -> var(--g1-space-2) (8px)");
});
