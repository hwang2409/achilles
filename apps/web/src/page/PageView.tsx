import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { DetailRecord, type DetailFilter } from "../DetailRecord";
import { FormBlock, refreshSelection, selectRow, useRecordWrites, useSelectedRow } from "./RecordForm";
import { extendWithRecordKeys, recordColumns, schemaColumns } from "./listColumns";
import { usePageTools, type PageTool } from "./usePageTools";
import "./page.css";
import { RecordMark } from "./RecordMark";

type PageLike = { title: string; route: string; active_layout_version?: number; layout: { blocks: Array<Record<string, unknown>> } };
type PageViewProps = { page: PageLike; pageId: string; credential: string; refreshKey: string };

function groupBlocks(blocks: Array<Record<string, unknown>>): Array<Array<Record<string, unknown>>> {
  const groups: Array<Array<Record<string, unknown>>> = [];
  for (const block of blocks) {
    if (block.type === "metric" && groups.at(-1)?.[0]?.type === "metric") groups.at(-1)!.push(block);
    else groups.push([block]);
  }
  return groups;
}

type CountEntry = { value: string; generation: string; request: number };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function metricQueryKey(block: Record<string, unknown>, pageId: string, credential: string): string | null {
  if (!block.count || typeof block.collection !== "string") return null;
  return `${pageId}\0${credential}\0${block.collection}\0${canonical(block.where ?? null)}`;
}

function useMetricCounts(blocks: Array<Record<string, unknown>>, pageId: string, credential: string, chatRefreshKey: string): Map<string, string> {
  const writes = useRecordWrites(pageId);
  const generation = `${chatRefreshKey}:${writes}`;
  const entries = useRef(new Map<string, CountEntry>());
  const requestSequence = useRef(0);
  const [, redraw] = useState(0);
  const queries = blocks.filter((block) => metricQueryKey(block, pageId, credential)).map((block) => ({ block, key: metricQueryKey(block, pageId, credential)! }));
  const queryShape = queries.map(({ key }) => key).join("\n");
  useEffect(() => {
    const current = new Set(queries.map(({ key }) => key));
    for (const key of entries.current.keys()) if (!current.has(key)) entries.current.delete(key);
    for (const { block, key } of queries) {
      const previous = entries.current.get(key);
      if (previous?.generation === generation) continue;
      const request = ++requestSequence.current;
      entries.current.set(key, { value: "…", generation, request });
      const query = new URLSearchParams({ limit: "1" });
      if (block.where && typeof block.where === "object") {
        const where = block.where as Record<string, unknown>;
        query.set("field", String(where.field));
        query.set("equals", JSON.stringify(where.equals));
      }
      void fetch(`/api/pages/${pageId}/records/${encodeURIComponent(String(block.collection))}?${query}`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" }).then((response) => {
        const entry = entries.current.get(key);
        if (!entry || entry.request !== request) return;
        entry.value = response.ok ? Number(response.headers.get("x-achilles-total") ?? 0).toLocaleString() : "—";
        redraw((value) => value + 1);
      }).catch(() => {
        const entry = entries.current.get(key);
        if (entry?.request === request) { entry.value = "—"; redraw((value) => value + 1); }
      });
    }
    redraw((value) => value + 1);
    // queryShape changes only when the current metric requests change; settled and in-flight entries are reused.
  }, [credential, generation, pageId, queryShape]);
  return new Map(queries.map(({ key }) => [key, entries.current.get(key)?.value ?? "…"]));
}

export function PageView({ page, pageId, credential, refreshKey }: PageViewProps) {
  const blocks = page.layout.blocks;
  const leadIndex = blocks.findIndex((block) => block.type === "text");
  const lead = leadIndex >= 0 ? String(blocks[leadIndex].text ?? "") : "";
  const content = blocks.filter((_, index) => index !== leadIndex);
  const counts = useMetricCounts(content, pageId, credential, refreshKey);
  return <main className="page-content">
    <header className="page-head">
      <div><h1>{page.title}</h1>{lead && <p className="page-lead">{lead}</p>}</div>
      <span className="page-layout-version">layout v{page.active_layout_version ?? 1}</span>
    </header>
    <div className="page-blocks">{groupBlocks(content).map((group, index) => {
      if (group[0].type === "metric") return <div className="metric-strip" key={`metric-strip:${index}`}>{group.map((block) => <MetricBlock key={blockIdentity(block, content)} block={block} value={counts.get(metricQueryKey(block, pageId, credential) ?? "")} />)}</div>;
      return <LayoutBlock key={blockIdentity(group[0], content)} block={group[0]} pageId={pageId} credential={credential} refreshKey={refreshKey} />;
    })}</div>
  </main>;
}

function blockIdentity(block: Record<string, unknown>, blocks: Array<Record<string, unknown>>): string {
  const type = String(block.type);
  const signature = JSON.stringify([type, block.title, block.label, block.collection, block.tool, block.text, block.filter, block.where]);
  const ordinal = blocks.slice(0, blocks.indexOf(block) + 1).filter((candidate) => JSON.stringify([candidate.type, candidate.title, candidate.label, candidate.collection, candidate.tool, candidate.text, candidate.filter, candidate.where]) === signature).length;
  return `${type}:${signature}:${ordinal}`;
}

export function LayoutBlock({ block, pageId, credential, refreshKey: chatRefreshKey }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string }) {
  const selected = useSelectedRow(pageId);
  const refreshKey = `${chatRefreshKey}:${useRecordWrites(pageId)}`;
  if (block.type === "text") return <p className="page-text">{String(block.text)}</p>;
  if (block.type === "metric") return <MetricBlock block={block} value={block.count ? "…" : undefined} />;
  if (block.type === "list") return <ListBlock block={block} pageId={pageId} credential={credential} refreshKey={refreshKey} toolsKey={chatRefreshKey} />;
  if (block.type === "detail") {
    const fields = Array.isArray(block.fields) ? block.fields.map(String) : [];
    const filter = block.filter as DetailFilter | undefined;
    if (filter && typeof block.collection === "string") return <DetailRecord title={String(block.title)} collection={block.collection} fields={fields} filter={filter} pageId={pageId} credential={credential} refreshKey={refreshKey} selected={selected?.collection === block.collection ? selected.record : undefined} />;
    return <section className="record-detail"><h2>{String(block.title)}</h2><p>{fields.join(", ")}</p></section>;
  }
  if (block.type === "form") return <FormBlock title={String(block.title)} toolName={String(block.tool)} fields={Array.isArray(block.fields) ? block.fields.map(String) : undefined} pageId={pageId} credential={credential} refreshKey={chatRefreshKey} />;
  return null;
}

function compactMetricValue(value: string): string {
  const numeric = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(numeric);
}

function MetricBlock({ block, value }: { block: Record<string, unknown>; value?: string }) {
  const fullValue = block.count ? value ?? "…" : block.value == null ? "0" : String(block.value);
  const displayValue = fullValue.length > 10 ? compactMetricValue(fullValue) : fullValue;
  const label = String(block.label);
  const status = String(block.status ?? (["queued", "reading", "done", "in-progress", "to-claim", "paid", "sent"].includes(label.toLowerCase()) ? label : "")).toLowerCase();
  return <section className="metric-block">{status && <RecordMark status={status} />}<div><span className="metric-label">{label}</span><span className="metric-value-line"><strong className="metric-value" title={fullValue} aria-label={`${label}: ${fullValue}`}>{displayValue}</strong>{block.delta != null && <span className={`metric-delta${block.warn ? " metric-warn" : ""}`}>{String(block.delta)}</span>}</span>{block.detail != null && <small>{String(block.detail)}</small>}</div></section>;
}

function ListBlock({ block, pageId, credential, refreshKey, toolsKey }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string; toolsKey: string }) {
  const key = `${pageId}:${String(block.collection)}`;
  const list = { title: String(block.title), collection: String(block.collection), pageId, credential, refreshKey, filter: block.filter as DetailFilter | undefined };
  return Array.isArray(block.fields) && block.fields.length > 0 ? <RecordList key={key} {...list} columns={block.fields.map(String)} /> : <SchemaRecordList key={key} {...list} toolsKey={toolsKey} />;
}

function SchemaRecordList({ toolsKey, ...list }: { title: string; collection: string; pageId: string; credential: string; refreshKey: string; filter?: DetailFilter; toolsKey: string }) {
  const { tools, error } = usePageTools(list.pageId, list.credential, toolsKey);
  const last = useRef<PageTool[] | null>(null);
  if (tools !== null) last.current = tools;
  const shown = tools ?? last.current;
  return <RecordList {...list} columns={shown ? schemaColumns(shown, list.collection) : error ? [] : null} extendColumns />;
}

export function RecordList({ title, collection, pageId, credential, refreshKey, filter, columns = [], extendColumns = false }: { title: string; collection: string; pageId: string; credential: string; refreshKey: string; filter?: DetailFilter; columns?: string[] | null; extendColumns?: boolean }) {
  const query = new URLSearchParams({ ...filter && { field: filter.field, equals: JSON.stringify(filter.equals) }, limit: "100" }).toString();
  const [records, setRecords] = useState<Record<string, unknown>[] | null>(null); const [total, setTotal] = useState(0); const [error, setError] = useState<string | null>(null); const requestSequence = useRef(0);
  useEffect(() => { let live = true; const request = ++requestSequence.current; void fetch(`/api/pages/${pageId}/records/${encodeURIComponent(collection)}?${query}`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(`could not load records (${response.status})`); const value = await response.json(); if (!Array.isArray(value)) throw new Error("invalid records response"); if (live && request === requestSequence.current) { setRecords(value); refreshSelection(pageId, collection, value); setTotal(Number(response.headers.get("x-achilles-total") ?? value.length)); setError(null); } }).catch((caught) => { if (live && request === requestSequence.current) setError(caught instanceof Error ? caught.message : String(caught)); }); return () => { live = false; }; }, [collection, credential, pageId, query, refreshKey]);
  const selected = useSelectedRow(pageId);
  const selectedId = selected?.collection === collection ? selected.record.record_id : undefined;
  return <RecordListView title={title} collection={collection} records={records} columns={columns} extendColumns={extendColumns} total={total} error={error} selectedId={selectedId} onSelect={(record, row) => selectRow(pageId, record && { collection, record, opener: row })} />;
}

export function RecordListView({ title, collection, records, columns: chosen = [], extendColumns = false, total, error, selectedId, onSelect }: { title: string; collection?: string; records: Record<string, unknown>[] | null; columns?: string[] | null; extendColumns?: boolean; total: number; error: string | null; selectedId?: unknown; onSelect?: (record: Record<string, unknown> | null, row: HTMLElement) => void }) {
  const loadedRecords = records ?? [];
  const [focusedId, setFocusedId] = useState<unknown>(undefined);
  const [expanded, setExpanded] = useState(false);
  const projection = recordListProjection(loadedRecords, total, expanded, focusedId, selectedId);
  const columns = !chosen?.length ? recordColumns(loadedRecords) : extendColumns ? extendWithRecordKeys(chosen, loadedRecords) : chosen;
  const loading = (records === null || chosen === null) && !error;
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, record: Record<string, unknown>) => handleRecordKeyDown(event, record, onSelect);
  return <section className="record-list" aria-busy={loading}><header><h2>{title} <span className="record-count">{total.toLocaleString()}</span></h2><span>sorted by updated</span></header>{error ? <p role="alert">{error}</p> : loading ? <p role="status">loading records…</p> : projection.loaded.length === 0 ? <p>no records yet</p> : <><LoadedRecordTable columns={columns} records={projection.visible} collection={collection} title={title} selectedId={selectedId} tabStop={projection.tabStop} onSelect={onSelect} onFocus={setFocusedId} onKeyDown={onKeyDown} />{projection.showReveal && <div className="record-reveal"><button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "show less" : `show ${projection.loadedRemaining} more`}</button><small>{expanded ? `${projection.loaded.length} of ${projection.total}` : `${projection.visible.length} of ${projection.total}`}</small></div>}</>}</section>;
}

type RecordListProjection = { loaded: Record<string, unknown>[]; visible: Record<string, unknown>[]; tabStop: unknown; loadedRemaining: number; total: number; showReveal: boolean };

function recordListProjection(records: Record<string, unknown>[], total: number, expanded: boolean, focusedId: unknown, selectedId: unknown): RecordListProjection {
  const visible = expanded ? records : records.slice(0, 5);
  const visibleHas = (id: unknown) => id !== undefined && visible.some((record) => record.record_id === id);
  const tabStop = visibleHas(focusedId) ? focusedId : visibleHas(selectedId) ? selectedId : visible[0]?.record_id;
  const loadedRemaining = Math.max(records.length - visible.length, 0);
  return { loaded: records, visible, tabStop, loadedRemaining, total, showReveal: records.length > 5 };
}

function handleRecordKeyDown(event: KeyboardEvent<HTMLTableRowElement>, record: Record<string, unknown>, onSelect?: (record: Record<string, unknown> | null, row: HTMLElement) => void) {
  const row = event.currentTarget;
  if (event.key === "Enter" || event.key === " ") onSelect?.(record, row);
  else if (event.key === "Escape") onSelect?.(null, row);
  else if (event.key === "ArrowDown") (row.nextElementSibling as HTMLElement | null)?.focus();
  else if (event.key === "ArrowUp") (row.previousElementSibling as HTMLElement | null)?.focus();
  else return;
  event.preventDefault();
}

function LoadedRecordTable({ columns, records, collection, title, selectedId, tabStop, onSelect, onFocus, onKeyDown }: { columns: string[]; records: Record<string, unknown>[]; collection?: string; title: string; selectedId?: unknown; tabStop?: unknown; onSelect?: (record: Record<string, unknown> | null, row: HTMLElement) => void; onFocus: (id: unknown) => void; onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>, record: Record<string, unknown>) => void }) {
  return <table role={onSelect ? "grid" : undefined} aria-label={title} data-collection={collection}><thead><tr>{columns.map((column) => <th key={column} data-column={column}>{column}</th>)}</tr></thead><tbody>{records.map((record, index) => <tr key={String(record.record_id ?? index)} data-record-id={record.record_id == null ? undefined : String(record.record_id)} {...onSelect && { tabIndex: record.record_id === tabStop ? 0 : -1, "aria-selected": record.record_id === selectedId, onFocus: () => onFocus(record.record_id), onClick: (event: MouseEvent<HTMLTableRowElement>) => onSelect(record, event.currentTarget), onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => onKeyDown(event, record) }}>{columns.map((column) => <td key={column} data-column={column} className={column === "updated" ? "record-updated-cell" : undefined}>{column === "status" ? <span className="record-status"><RecordMark status={String(record[column] ?? "")} />{formatRecordValue(record[column]) || "—"}</span> : formatRecordValue(record[column])}</td>)}</tr>)}</tbody></table>;
}

function formatRecordValue(value: unknown): string { return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""); }
