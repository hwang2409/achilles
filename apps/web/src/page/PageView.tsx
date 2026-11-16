import { useEffect, useRef, useState } from "react";
import { DetailRecord, type DetailFilter } from "../DetailRecord";
import { FormBlock, refreshSelection, selectRow, useRecordWrites, useSelectedRow } from "./RecordForm";
import { extendWithRecordKeys, recordColumns, schemaColumns } from "./listColumns";
import { usePageTools, type PageTool } from "./usePageTools";
import "./page.css";

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

export function PageView({ page, pageId, credential, refreshKey }: PageViewProps) {
  const blocks = page.layout.blocks;
  const leadIndex = blocks.findIndex((block) => block.type === "text");
  const lead = leadIndex >= 0 ? String(blocks[leadIndex].text ?? "") : "";
  const content = blocks.filter((_, index) => index !== leadIndex);
  return <main className="page-content">
    <header className="page-head">
      <div><h1>{page.title}</h1>{lead && <p className="page-lead">{lead}</p>}</div>
      <span className="page-layout-version">layout v{page.active_layout_version ?? 1}</span>
    </header>
    <div className="page-blocks">{groupBlocks(content).map((group, index) => group.length === 1 ? <LayoutBlock key={index} block={group[0]} pageId={pageId} credential={credential} refreshKey={refreshKey} /> : <div className="metric-strip" key={index}>{group.map((block) => <MetricBlock key={String(block.label)} block={block} pageId={pageId} credential={credential} refreshKey={refreshKey} />)}</div>)}</div>
  </main>;
}

export function LayoutBlock({ block, pageId, credential, refreshKey: chatRefreshKey }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string }) {
  const refreshKey = `${chatRefreshKey}:${useRecordWrites(pageId)}`;
  if (block.type === "text") return <p className="page-text">{String(block.text)}</p>;
  if (block.type === "metric") return <MetricBlock block={block} pageId={pageId} credential={credential} refreshKey={refreshKey} />;
  if (block.type === "list") return <ListBlock block={block} pageId={pageId} credential={credential} refreshKey={refreshKey} toolsKey={chatRefreshKey} />;
  if (block.type === "detail") {
    const fields = Array.isArray(block.fields) ? block.fields.map(String) : [];
    const filter = block.filter as DetailFilter | undefined;
    if (filter && typeof block.collection === "string") return <DetailRecord title={String(block.title)} collection={block.collection} fields={fields} filter={filter} pageId={pageId} credential={credential} refreshKey={refreshKey} />;
    return <section className="record-detail"><h2>{String(block.title)}</h2><p>{fields.join(", ")}</p></section>;
  }
  if (block.type === "form") return <FormBlock title={String(block.title)} toolName={String(block.tool)} fields={Array.isArray(block.fields) ? block.fields.map(String) : undefined} pageId={pageId} credential={credential} refreshKey={chatRefreshKey} />;
  return null;
}

function MetricBlock({ block, pageId, credential, refreshKey }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string }) {
  const [value, setValue] = useState(block.value == null ? (block.count ? "…" : "0") : String(block.value));
  useEffect(() => {
    if (!block.count || typeof block.collection !== "string") return;
    let live = true;
    const query = new URLSearchParams({ limit: "1", ...block.where && { field: String((block.where as Record<string, unknown>).field), equals: JSON.stringify((block.where as Record<string, unknown>).equals) } });
    void fetch(`/api/pages/${pageId}/records/${encodeURIComponent(block.collection)}?${query}`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" }).then((response) => {
      if (live) setValue(response.ok ? Number(response.headers.get("x-achilles-total") ?? 0).toLocaleString() : "—");
    }).catch(() => { if (live) setValue("—"); });
    return () => { live = false; };
  }, [block.collection, block.count, block.where, credential, pageId, refreshKey]);
  const status = String(block.status ?? block.label ?? "").toLowerCase();
  return <section className="metric-block"><span className={`record-mark record-mark-${status}`} aria-hidden="true" /><div><span className="metric-label">{String(block.label)}</span><strong className={block.warn ? "metric-warn" : undefined}>{value}</strong>{block.detail != null && <small>{String(block.detail)}</small>}</div>{block.delta != null && <span className="metric-delta">{String(block.delta)}</span>}</section>;
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
  const has = (id: unknown) => id !== undefined && loadedRecords.some((record) => record.record_id === id);
  const tabStop = has(focusedId) ? focusedId : has(selectedId) ? selectedId : loadedRecords[0]?.record_id;
  const columns = !chosen?.length ? recordColumns(loadedRecords) : extendColumns ? extendWithRecordKeys(chosen, loadedRecords) : chosen;
  const loading = (records === null || chosen === null) && !error;
  const onKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, record: Record<string, unknown>) => { const row = event.currentTarget; if (event.key === "Enter" || event.key === " ") onSelect?.(record, row); else if (event.key === "Escape") onSelect?.(null, row); else if (event.key === "ArrowDown") (row.nextElementSibling as HTMLElement | null)?.focus(); else if (event.key === "ArrowUp") (row.previousElementSibling as HTMLElement | null)?.focus(); else return; event.preventDefault(); };
  return <section className="record-list" aria-busy={loading}><header><h2>{title}</h2><span>{total.toLocaleString()} records</span></header>{error ? <p role="alert">{error}</p> : loading ? <p role="status">loading records…</p> : loadedRecords.length === 0 ? <p>no records yet</p> : <><table role={onSelect ? "grid" : undefined} aria-label={title} data-collection={collection}><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{loadedRecords.slice(0, 5).map((record, index) => <tr key={String(record.record_id ?? index)} data-record-id={record.record_id == null ? undefined : String(record.record_id)} {...onSelect && { tabIndex: record.record_id === tabStop ? 0 : -1, "aria-selected": record.record_id === selectedId, onFocus: () => setFocusedId(record.record_id), onClick: (event: React.MouseEvent<HTMLTableRowElement>) => onSelect(record, event.currentTarget), onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => onKeyDown(event, record) }}>{columns.map((column) => <td key={column} className={column === "status" ? "record-status-cell" : column === "updated" ? "record-updated-cell" : undefined}>{column === "status" ? <span className="record-status"><span className={`record-mark record-mark-${String(record[column] ?? "")}`} aria-hidden="true" />{formatRecordValue(record[column]) || "—"}</span> : formatRecordValue(record[column])}</td>)}</tr>)}</tbody></table>{total > 5 && <p className="record-reveal"><span>show {total - 5} more</span><small>5 of {total}</small></p>}</>}</section>;
}
function formatRecordValue(value: unknown): string { return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""); }
