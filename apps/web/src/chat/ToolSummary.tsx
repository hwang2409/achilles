import type { ReactNode } from "react";
import type { ToolBodyProps, ToolItem } from "@fulcrum/react";
import "./tool-summary.css";

const MAX_INPUT = 64_000;
const MAX_TEXT = 180;
const MAX_ROWS = 3;
const HIDDEN_KEYS = new Set(["record_id", "revision"]);
const preferred = ["title", "name", "label", "status", "state"];

type Summary = { lines: string[]; raw: string };

const text = (value: unknown, limit = MAX_TEXT): string => {
  const result = typeof value === "string" ? value : String(value);
  const oneLine = result.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
};

function outputText(output: ToolBodyProps["output"]): string {
  let result = "";
  for (const chunk of output.chunks()) {
    result += chunk.text;
    if (result.length > MAX_INPUT) return result.slice(0, MAX_INPUT + 1);
  }
  return result;
}

function scalarEntries(record: Record<string, unknown>): [string, unknown][] {
  const entries = Object.entries(record).filter(([key, value]) => !HIDDEN_KEYS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"));
  return [...entries].sort(([a], [b]) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    return (ai < 0 ? preferred.length : ai) - (bi < 0 ? preferred.length : bi);
  });
}

function recordLine(record: Record<string, unknown>): string {
  const entries = scalarEntries(record).slice(0, 3);
  return entries.length ? entries.map(([key, value]) => `${key} ${text(value, 72)}`).join(" · ") : "record";
}

function parseSummary(raw: string, error: boolean): string[] {
  let value: unknown;
  try {
    if (!raw || raw.length > MAX_INPUT) return [text(raw || "no result")];
    value = JSON.parse(raw);
  } catch {
    return [text(raw || "no result")];
  }
  if (error) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const message = record.message ?? record.error ?? record.code;
      if (typeof message === "string" || typeof message === "number") return [`failed: ${text(message)}`];
    }
    return [`failed: ${text(raw)}`];
  }
  if (value === null) return ["no record"];
  if (Array.isArray(value)) {
    const records = value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
    if (records.length !== value.length) return [text(raw)];
    const statusKey = records.length && records.every((row) => typeof row.status === "string") ? "status" : records.length && records.every((row) => typeof row.state === "string") ? "state" : undefined;
    const counts = new Map<string, number>();
    if (statusKey) for (const record of records) counts.set(String(record[statusKey]), (counts.get(String(record[statusKey])) ?? 0) + 1);
    const head = `${records.length} rows${counts.size ? ` · ${[...counts].map(([key, count]) => `${count} ${text(key, 40)}`).join(", ")}` : ""}`;
    const lines = records.slice(0, MAX_ROWS).map(recordLine);
    if (records.length > MAX_ROWS) lines.push(`+ ${records.length - MAX_ROWS} more`);
    return [head, ...lines];
  }
  if (typeof value === "object") return [recordLine(value as Record<string, unknown>)];
  return [text(raw)];
}

function argsText(item: ToolItem): string {
  const args = item.tool_call.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const parts = Object.entries(args as Record<string, unknown>).slice(0, 6).map(([key, value]) => {
    if (Array.isArray(value) && value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))) return `${key} in [${value.map((entry) => text(entry, 32)).join(", ")}]`;
    if (["string", "number", "boolean"].includes(typeof value)) return `${key} ${text(value, 48)}`;
    return `${key} …`;
  });
  return text(parts.join(" · "), 260);
}

export function toolArgumentSummary(item: ToolItem): string {
  return argsText(item);
}

export function summarizeToolOutput(output: ToolBodyProps["output"], error = false): Summary {
  const raw = outputText(output);
  const incomplete = Boolean(output.omission || output.protocolTruncated);
  const lines = incomplete ? [text(raw || "output was truncated or omitted")] : parseSummary(raw, error);
  return { lines, raw: incomplete ? `${raw}\n(output was truncated or omitted)` : raw || "no retained result" };
}

function json(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? "{}"; } catch { return "unable to format arguments"; }
}

export function ToolSummaryBody({ item, output, state }: ToolBodyProps): ReactNode {
  const summary = summarizeToolOutput(output, item.is_error || state === "error");
  return <>
    <div data-part="tool-summary-preview">{summary.lines.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}</div>
    <details data-part="tool-raw">
      <summary>raw</summary>
      <pre>{`arguments\n${json(item.tool_call.arguments)}\n\nresult\n${summary.raw}`}</pre>
    </details>
  </>;
}
