import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ToolBody, type ItemState, type ToolBodyProps, type ToolItem } from "@fulcrum/react";
import "./tool-summary.css";

const MAX_INPUT = 64_000;
const MAX_TEXT = 180;
const MAX_ROWS = 3;
const MAX_ARG_KEYS = 12;
const MAX_ARRAY_ITEMS = 8;
const HIDDEN_KEYS = new Set(["record_id", "revision"]);
const preferred = ["title", "name", "label", "status", "state"];

type Summary = { lines: string[]; raw: string; fallback: boolean };
type OutputRead = { text: string; overflow: boolean };

const text = (value: unknown, limit = MAX_TEXT): string => {
  const result = (typeof value === "string" ? value : String(value)).slice(0, limit * 4);
  const oneLine = result.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
};

function outputText(output: ToolBodyProps["output"]): OutputRead {
  let result = "";
  for (const chunk of output.chunks()) {
    result += chunk.text;
    if (result.length > MAX_INPUT) return { text: result.slice(0, MAX_INPUT), overflow: true };
  }
  return { text: result, overflow: false };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function dateLike(key: string): boolean {
  return /(?:^|[_-])(date|at|on|time|updated|created|finished|due)(?:$|[_-])/i.test(key) || /^(date|updated|created|finished|due)(?:On|At|Time)?$/i.test(key);
}

function scalarEntries(record: Record<string, unknown>): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key in record) {
    if (entries.length >= 32) break;
    const value = record[key];
    if (!HIDDEN_KEYS.has(key) && isScalar(value)) entries.push([key, value]);
  }
  return entries.sort(([a], [b]) => {
    const priority = (key: string) => {
      const index = preferred.indexOf(key);
      return index >= 0 ? index : dateLike(key) ? preferred.length : preferred.length + 1;
    };
    return priority(a) - priority(b);
  });
}

function recordLine(record: Record<string, unknown>): string {
  const entries = scalarEntries(record).slice(0, 3);
  return entries.length ? entries.map(([, value]) => text(value, 72)).join(" · ") : "record";
}

function parseJson(raw: string): unknown | undefined {
  if (!raw || raw.length > MAX_INPUT) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function errorLines(value: unknown, raw: string): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.code;
    if (isScalar(message)) return [`failed: ${text(message)}`];
  }
  return [`failed: ${text(raw)}`];
}

function arrayLines(value: unknown[]): string[] {
  const records = value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  if (records.length !== value.length) return [];
  const statusKey = records.length && records.every((row) => typeof row.status === "string") ? "status" : records.length && records.every((row) => typeof row.state === "string") ? "state" : undefined;
  const counts = new Map<string, number>();
  if (statusKey) for (const record of records) counts.set(String(record[statusKey]), (counts.get(String(record[statusKey])) ?? 0) + 1);
  const head = `${records.length} rows${counts.size ? ` · ${[...counts].map(([key, count]) => `${count} ${text(key, 40)}`).join(", ")}` : ""}`;
  const lines = records.slice(0, MAX_ROWS).map(recordLine);
  if (records.length > MAX_ROWS) lines.push(`+ ${records.length - MAX_ROWS} more`);
  return [head, ...lines];
}

function parseSummary(raw: string, error: boolean): string[] {
  const value = parseJson(raw);
  if (value === undefined) return [text(raw || "no result")];
  if (error) return errorLines(value, raw);
  if (value === null) return ["no record"];
  if (Array.isArray(value)) {
    const lines = arrayLines(value);
    return lines.length ? lines : [text(raw)];
  }
  if (typeof value === "object") return [recordLine(value as Record<string, unknown>)];
  return [text(raw)];
}

function argValue(value: unknown): string {
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const entry of value) {
      if (values.length >= MAX_ARRAY_ITEMS || !isScalar(entry)) break;
      values.push(text(entry, 32));
    }
    if (values.length && values.length === Math.min(value.length, MAX_ARRAY_ITEMS)) {
      const omission = value.length > MAX_ARRAY_ITEMS ? `, … ${value.length - MAX_ARRAY_ITEMS} more` : "";
      return `in [${values.join(", ")}${omission}]`;
    }
  }
  // long enough to fill a wide card; the header ellipsis cuts it to the room it has, and argsText still caps the line at 260
  return isScalar(value) ? text(value, 200) : "…";
}

function argsText(item: ToolItem): string {
  const args = item.tool_call.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const parts: string[] = [];
  let length = 0;
  for (const key of Object.keys(args as Record<string, unknown>)) {
    if (parts.length >= MAX_ARG_KEYS || length >= 260) break;
    const part = `${key} ${argValue((args as Record<string, unknown>)[key])}`;
    const next = parts.length ? `${parts.join(" · ")} · ${part}` : part;
    if (next.length > 260) break;
    parts.push(part);
    length = next.length;
  }
  return parts.join(" · ");
}

const PATH_BUDGET = 56;
// the argument a reader needs, shown without its key: tool name pattern -> argument keys
const PRIMARY: [RegExp, string[]][] = [
  [/^(read|edit|write|multi_?edit|view|cat|ls|list_dir|notebook_?edit)$/, ["path", "file_path", "notebook_path"]],
  [/^(bash|shell|exec|run_background)$/, ["command", "cmd"]],
  [/^(grep|glob|search|find|rg|web_?search)$/, ["pattern", "query"]],
  [/^(fetch|web_?fetch)$/, ["url"]],
];

/** Shorten a path for one row: relative to cwd when inside it, then cut in the middle so the file name stays. */
export function displayPath(path: string, cwd?: string | null): string {
  const base = cwd?.replace(/\/+$/, "");
  let result = text(path, 4096);
  if (base && result === base) result = ".";
  else if (base && result.startsWith(`${base}/`)) result = result.slice(base.length + 1);
  if (result.length <= PATH_BUDGET) return result;
  const name = result.slice(result.lastIndexOf("/") + 1);
  const tail = Math.min(PATH_BUDGET - 1, Math.max(Math.ceil(PATH_BUDGET / 2), name.length + 1));
  return `${result.slice(0, PATH_BUDGET - 1 - tail)}…${result.slice(-tail)}`;
}

function primaryText(item: ToolItem, cwd?: string | null): string | undefined {
  const args = item.tool_call.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const name = item.tool_call.name.trim().toLowerCase().replace(/-/g, "_");
  const keys = PRIMARY.find(([pattern]) => pattern.test(name))?.[1];
  const key = keys?.find((candidate) => typeof (args as Record<string, unknown>)[candidate] === "string" && ((args as Record<string, string>)[candidate]).trim());
  if (!key) return undefined;
  const value = (args as Record<string, string>)[key];
  if (key.includes("path")) return displayPath(value, cwd);
  // commands show exactly what ran: no path rewriting
  return text(value, 200);
}

/** One-line argument summary for a collapsed tool row; cwd is the session cwd, or null when unknown. */
export function toolArgumentSummary(item: ToolItem, cwd?: string | null): string { return primaryText(item, cwd) ?? argsText(item); }

export function summarizeToolOutput(output: ToolBodyProps["output"], error = false, state: ItemState = "done"): Summary {
  const read = outputText(output);
  const incomplete = Boolean(output.omission || output.protocolTruncated || read.overflow || !["done", "error"].includes(state));
  if (incomplete) {
    const reason = state === "streaming" ? "output still streaming" : "output truncated or omitted";
    return { lines: [reason], raw: read.text, fallback: true };
  }
  return { lines: parseSummary(read.text, error), raw: read.text || "no retained result", fallback: false };
}

const MAX_RAW_NODES = 512;
const MAX_RAW_DEPTH = 12;
const MAX_RAW_TEXT = 16_000;

type RawState = { nodes: number; seen: WeakSet<object>; text: number; truncated: boolean };

// arguments are JSON.parse data from a Zeta/Fulcrum frame capped at 1 MiB; these limits bound the rendered preview, not key discovery.
function formatRaw(value: unknown): string {
  const state: RawState = { nodes: 0, seen: new WeakSet(), text: 0, truncated: false };
  const visit = (current: unknown, depth: number, indent: string): string => {
    if (state.nodes++ >= MAX_RAW_NODES || depth > MAX_RAW_DEPTH) {
      state.truncated = true;
      return "[truncated]";
    }
    if (current === null) return "null";
    if (typeof current === "string") {
      const clipped = current.length > MAX_RAW_TEXT;
      if (clipped) state.truncated = true;
      return JSON.stringify(clipped ? current.slice(0, MAX_RAW_TEXT) : current);
    }
    if (typeof current === "number" || typeof current === "boolean") return String(current);
    if (typeof current === "bigint") return `${current}n`;
    if (typeof current !== "object") return JSON.stringify(String(current));
    if (state.seen.has(current)) return "[circular]";
    state.seen.add(current);
    const nextIndent = `${indent}  `;
    const entries: string[] = [];
    for (const key of Object.keys(current)) {
      if (state.nodes >= MAX_RAW_NODES || state.text >= MAX_RAW_TEXT) { state.truncated = true; break; }
      const label = Array.isArray(current) ? "" : `${JSON.stringify(key)}: `;
      const child = `${nextIndent}${label}${visit((current as Record<string, unknown>)[key], depth + 1, nextIndent)}`;
      state.text += child.length;
      entries.push(child);
    }
    state.seen.delete(current);
    const open = Array.isArray(current) ? "[" : "{";
    const close = Array.isArray(current) ? "]" : "}";
    if (state.truncated) entries.push(`${nextIndent}[truncated]`);
    return entries.length ? `${open}\n${entries.join(",\n")}\n${indent}${close}` : `${open}${close}`;
  };
  const formatted = visit(value, 0, "");
  return formatted.length > MAX_RAW_TEXT ? `${formatted.slice(0, MAX_RAW_TEXT - 14)}\n[truncated]` : formatted;
}

export function formatToolArguments(value: unknown): string { return formatRaw(value); }

export function toolErrorLine(output: ToolBodyProps["output"]): string {
  const { text: raw } = outputText(output);
  return raw ? errorLines(parseJson(raw), raw)[0] : "Tool failed without an error message.";
}

export function ToolSummaryBody({ item, output, state }: ToolBodyProps): ReactNode {
  const [rawOpen, setRawOpen] = useState(false);
  const rawRef = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    const details = rawRef.current;
    const row = details?.closest<HTMLElement>("[data-virtual-id]");
    const card = details?.closest<HTMLDetailsElement>('details[data-part="tool"]');
    if (!details || !row || !card) return;
    let frame: number | null = null;
    const syncOwnerHeight = () => {
      frame = null;
      if (!details.open || !card.open) { row.style.removeProperty("min-height"); return; }
      // the virtual owner can retain its old measured height after a mobile-to-desktop remount; publish the disclosure's actual bottom.
      const rowBox = row.getBoundingClientRect();
      const detailsBox = details.getBoundingClientRect();
      row.style.minHeight = `${Math.ceil(detailsBox.bottom - rowBox.top)}px`;
    };
    const scheduleOwnerHeight = () => {
      if (frame === null) frame = requestAnimationFrame(syncOwnerHeight);
    };
    scheduleOwnerHeight();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleOwnerHeight);
    observer?.observe(details);
    card.addEventListener("toggle", scheduleOwnerHeight);
    return () => { card.removeEventListener("toggle", scheduleOwnerHeight); observer?.disconnect(); if (frame !== null) cancelAnimationFrame(frame); row.style.removeProperty("min-height"); };
  }, [rawOpen]);

  const summary = summarizeToolOutput(output, item.is_error || state === "error", state);
  const useFulcrumBody = summary.fallback;
  const rawResult = rawOpen && !useFulcrumBody ? parseJson(summary.raw) : undefined;
  const showPreview = !useFulcrumBody && (summary.lines.length > 1 || text(summary.raw) !== summary.lines[0]);
  return <>
    {useFulcrumBody ? <ToolBody item={item} output={output} state={state} /> : showPreview ? <div data-part="tool-output"><div data-part="tool-summary-preview">{summary.lines.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}</div></div> : <ToolBody item={item} output={output} state={state} />}
    <details ref={rawRef} data-part="tool-raw" onToggle={(event) => setRawOpen(event.currentTarget.open)}>
      <summary>raw</summary>
      {rawOpen && !useFulcrumBody ? <pre>{`${item.tool_call.meta?.argumentsTruncated ? "arguments truncated by zeta\n" : ""}arguments\n${formatRaw(item.tool_call.arguments)}\n\nresult\n${rawResult && typeof rawResult === "object" ? formatRaw(rawResult) : summary.raw}`}</pre> : null}
      {rawOpen && useFulcrumBody ? <p>fulcrum shows the complete retained result above.</p> : null}
    </details>
  </>;
}
