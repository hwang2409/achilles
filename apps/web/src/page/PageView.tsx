import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { DetailRecord, type DetailFilter } from "../DetailRecord";
import { FormBlock, refreshSelection, selectRow, useRecordWrites, useSelectedRow } from "./RecordForm";
import { extendWithRecordKeys, recordColumns, schemaColumns } from "./listColumns";
import { usePageTools, type PageTool } from "./usePageTools";
import { RecordMark } from "./RecordMark";
import { observeMetricFit } from "./metricFit";
import { formatMetricValue } from "./metricValue";
import { WRITE_SURFACE } from "../writeSurfaces";

type PageLike = { title: string; route: string; active_layout_version?: number; layout: { blocks: Array<Record<string, unknown>> } };
type InsertCapability = { collection: string; focusFirst: () => void };
type InsertRegistration = { id: string; capability: InsertCapability };
type PageViewProps = { page: PageLike; pageId: string; credential: string; refreshKey: string; onAskChat?: (draft: string) => void; canWrite?: boolean; disabledReason?: string };

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

export function PageView({ page, pageId, credential, refreshKey, onAskChat, canWrite = false, disabledReason }: PageViewProps) {
  const blocks = page.layout.blocks;
  const leadIndex = blocks.findIndex((block) => block.type === "text");
  const lead = leadIndex >= 0 ? String(blocks[leadIndex].text ?? "") : "";
  const content = blocks.filter((_, index) => index !== leadIndex);
  const counts = useMetricCounts(content, pageId, credential, refreshKey);
  const [insertCapabilities, setInsertCapabilities] = useState<InsertRegistration[]>([]);
  const registerInsert = useCallback((id: string, capability: InsertCapability) => {
    setInsertCapabilities((current) => [...current.filter((item) => item.id !== id), { id, capability }]);
    return () => setInsertCapabilities((current) => current.filter((item) => item.id !== id || item.capability !== capability));
  }, []);
  const addFor = (collection: string) => insertCapabilities.find((item) => item.capability.collection === collection)?.capability;
  return <main data-page-content="" className="min-h-0 min-w-0 flex-auto overflow-y-auto p-4 min-[761px]:p-6" data-write-surface={WRITE_SURFACE.pageChat}>
    <header data-page-head="" className="mx-auto mb-6 flex max-w-[720px] flex-col gap-2 min-[761px]:mb-8 min-[761px]:flex-row min-[761px]:items-end min-[761px]:justify-between min-[761px]:gap-6">
      <div><h1 className="text-[26px] leading-tight font-semibold tracking-tight text-balance first-letter:uppercase">{page.title}</h1>{lead && <p data-page-lead="" className="mt-2 max-w-[64ch] text-sm leading-[22px] text-muted-foreground first-letter:uppercase">{lead}</p>}</div>
    </header>
    <div className="mx-auto grid max-w-[720px] gap-6 min-[761px]:gap-8">{groupBlocks(content).map((group, index) => {
      if (group[0].type === "metric") {
        const metrics = group.map(block => metricPresentation(block, counts.get(metricQueryKey(block, pageId, credential) ?? "")));
        return <MetricStrip key={`metric-strip:${index}`} metrics={metrics} blocks={content} />;
      }
      return <LayoutBlock key={blockIdentity(group[0], content)} block={group[0]} pageId={pageId} credential={credential} refreshKey={refreshKey} onAskChat={onAskChat} insertCapability={addFor(String(group[0].collection ?? ""))} onRegisterInsert={registerInsert} canWrite={canWrite} disabledReason={disabledReason} />;
    })}</div>
  </main>;
}

function blockIdentity(block: Record<string, unknown>, blocks: Array<Record<string, unknown>>): string {
  const type = String(block.type);
  const signature = JSON.stringify([type, block.title, block.label, block.collection, block.tool, block.text, block.filter, block.where]);
  const ordinal = blocks.slice(0, blocks.indexOf(block) + 1).filter((candidate) => JSON.stringify([candidate.type, candidate.title, candidate.label, candidate.collection, candidate.tool, candidate.text, candidate.filter, candidate.where]) === signature).length;
  return `${type}:${signature}:${ordinal}`;
}

export function LayoutBlock({ block, pageId, credential, refreshKey: chatRefreshKey, onAskChat, insertCapability, onRegisterInsert, canWrite = false, disabledReason }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string; onAskChat?: (draft: string) => void; insertCapability?: InsertCapability; onRegisterInsert?: (id: string, capability: InsertCapability) => () => void; canWrite?: boolean; disabledReason?: string }) {
  const selected = useSelectedRow(pageId);
  const refreshKey = `${chatRefreshKey}:${useRecordWrites(pageId)}`;
  if (block.type === "text") return <p className="text-sm leading-[22px] text-muted-foreground">{String(block.text)}</p>;
  if (block.type === "list") return <ListBlock block={block} pageId={pageId} credential={credential} refreshKey={refreshKey} toolsKey={chatRefreshKey} onAskChat={onAskChat} insertCapability={insertCapability} />;
  if (block.type === "detail") {
    const fields = Array.isArray(block.fields) ? block.fields.map(String) : [];
    const filter = block.filter as DetailFilter | undefined;
    if (filter && typeof block.collection === "string") return <DetailRecord title={String(block.title)} collection={block.collection} fields={fields} filter={filter} pageId={pageId} credential={credential} refreshKey={refreshKey} selected={selected?.collection === block.collection ? selected.record : undefined} />;
    return <section className="min-w-0"><h2 className="mb-3 text-base font-semibold text-balance">{String(block.title)}</h2><p className="text-sm text-muted-foreground">{fields.join(", ")}</p></section>;
  }
  if (block.type === "form") return <FormBlock title={String(block.title)} toolName={String(block.tool)} fields={Array.isArray(block.fields) ? block.fields.map(String) : undefined} pageId={pageId} credential={credential} refreshKey={chatRefreshKey} onRegisterInsert={onRegisterInsert} canWrite={canWrite} disabledReason={disabledReason} />;
  return null;
}

function metricPresentation(block: Record<string, unknown>, count?: string) {
  const fullValue = block.count ? count ?? "…" : block.value == null ? "0" : String(block.value);
  const formatted = formatMetricValue(fullValue);
  const number = formatted.numeric;
  const words = number ? [] : formatted.display.split(/(\s+)/);
  return { block, fullValue, formatted, number, words };
}

type Metric = ReturnType<typeof metricPresentation>;
function MetricStrip({ metrics, blocks }: { metrics: Metric[]; blocks: Metric["block"][] }) {
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => observeMetricFit(strip.current!), [metrics]);
  return <div data-metric-strip="" className="grid min-w-0 grid-cols-[repeat(var(--metric-repeat),minmax(min(100%,max(var(--metric-track-floor),var(--metric-fit,0px))),1fr))] border-t border-l [--metric-repeat:auto-fit] [--metric-track-floor:150px] max-[760px]:[--metric-repeat:auto-fill] max-[760px]:[--metric-track-floor:calc(100%/3)] max-[360px]:[--metric-repeat:auto-fit] max-[360px]:[--metric-track-floor:128px]" ref={strip}>{metrics.map(metric => <MetricBlock key={blockIdentity(metric.block, blocks)} {...metric} />)}</div>;
}

function MetricBlock({ block, fullValue, formatted, number, words }: Metric) {
  const label = String(block.label);
  const status = String(block.status ?? (["queued", "reading", "done", "in-progress", "to-claim", "paid", "sent"].includes(label.toLowerCase()) ? label : "")).toLowerCase();
  const displayValue = formatted.display;
  const isCompacted = displayValue !== fullValue;
  const value = number ? displayValue : words.map((word, index) => word.trim() ? <span key={index} data-metric-word="" className="inline-block max-w-full align-top [overflow-wrap:anywhere]">{word}</span> : word);
  return <section data-metric-block="" className="group relative flex min-h-[86px] min-w-0 items-start gap-2.5 border-r border-b bg-card px-4 py-3.5 max-[760px]:px-2.5 max-[760px]:[&>[data-record-mark]]:absolute max-[760px]:[&>[data-record-mark]]:start-2.5">{status && <RecordMark status={status} />}<div className="grid min-w-0 gap-0.5 min-[761px]:pe-1.5"><span data-metric-label="" className="min-w-0 text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere] max-[760px]:group-has-[>[data-record-mark]]:ps-3.5">{label}</span><span data-metric-value-line="" className="flex min-w-0 flex-wrap items-baseline gap-x-2"><strong data-metric-value="" data-metric-number={number || undefined} className="min-w-0 max-w-full text-[length:var(--metric-value-size,28px)] leading-[calc(1em+6px)] text-balance tabular-nums data-[metric-number]:whitespace-nowrap" title={fullValue} aria-label={fullValue}>{isCompacted ? <span aria-hidden="true">{value}</span> : value}</strong>{block.delta != null && <span data-metric-delta="" data-warning={block.warn || undefined} className="min-w-0 text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere] data-[warning]:text-warning">{String(block.delta)}</span>}</span>{block.detail != null && <small className="min-w-0 text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">{String(block.detail)}</small>}</div></section>;
}

function ListBlock({ block, pageId, credential, refreshKey, toolsKey, onAskChat, insertCapability }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string; toolsKey: string; onAskChat?: (draft: string) => void; insertCapability?: InsertCapability }) {
  const key = `${pageId}:${String(block.collection)}`;
  const list = { title: String(block.title), collection: String(block.collection), pageId, credential, refreshKey, filter: block.filter as DetailFilter | undefined };
  return Array.isArray(block.fields) && block.fields.length > 0 ? <RecordList key={key} {...list} columns={block.fields.map(String)} onAskChat={onAskChat} insertCapability={insertCapability} /> : <SchemaRecordList key={key} {...list} toolsKey={toolsKey} onAskChat={onAskChat} insertCapability={insertCapability} />;
}

function SchemaRecordList({ toolsKey, onAskChat, insertCapability, ...list }: { title: string; collection: string; pageId: string; credential: string; refreshKey: string; filter?: DetailFilter; toolsKey: string; onAskChat?: (draft: string) => void; insertCapability?: InsertCapability }) {
  const { tools, error } = usePageTools(list.pageId, list.credential, toolsKey);
  const last = useRef<PageTool[] | null>(null);
  if (tools !== null) last.current = tools;
  const shown = tools ?? last.current;
  return <RecordList {...list} columns={shown ? schemaColumns(shown, list.collection) : error ? [] : null} extendColumns onAskChat={onAskChat} insertCapability={insertCapability} />;
}

export function RecordList({ title, collection, pageId, credential, refreshKey, filter, columns = [], extendColumns = false, onAskChat, insertCapability }: { title: string; collection: string; pageId: string; credential: string; refreshKey: string; filter?: DetailFilter; columns?: string[] | null; extendColumns?: boolean; onAskChat?: (draft: string) => void; insertCapability?: InsertCapability }) {
  const query = new URLSearchParams({ ...filter && { field: filter.field, equals: JSON.stringify(filter.equals) }, limit: "100" }).toString();
  const [records, setRecords] = useState<Record<string, unknown>[] | null>(null); const [total, setTotal] = useState(0); const [error, setError] = useState<string | null>(null); const [retry, setRetry] = useState(0); const requestSequence = useRef(0);
  useEffect(() => { let live = true; const request = ++requestSequence.current; void fetch(`/api/pages/${pageId}/records/${encodeURIComponent(collection)}?${query}`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(`could not load records (${response.status})`); const value = await response.json(); if (!Array.isArray(value)) throw new Error("invalid records response"); if (live && request === requestSequence.current) { setRecords(value); refreshSelection(pageId, collection, value); setTotal(Number(response.headers.get("x-achilles-total") ?? value.length)); setError(null); } }).catch((caught) => { if (live && request === requestSequence.current) setError(caught instanceof Error ? caught.message : String(caught)); }); return () => { live = false; }; }, [collection, credential, pageId, query, refreshKey, retry]);
  const selected = useSelectedRow(pageId);
  const selectedId = selected?.collection === collection ? selected.record.record_id : undefined;
  return <RecordListView title={title} collection={collection} records={records} columns={columns} extendColumns={extendColumns} total={total} error={error} selectedId={selectedId} onRetry={() => { setRecords(null); setRetry((value) => value + 1); }} onAskChat={onAskChat} insertCapability={insertCapability} onSelect={(record, row) => selectRow(pageId, record && { collection, record, opener: row })} />;
}

export function RecordListView({ title, collection, records, columns: chosen = [], extendColumns = false, total, error, selectedId, onRetry, onAskChat, insertCapability, onSelect }: { title: string; collection?: string; records: Record<string, unknown>[] | null; columns?: string[] | null; extendColumns?: boolean; total: number; error: string | null; selectedId?: unknown; onRetry?: () => void; onAskChat?: (draft: string) => void; insertCapability?: InsertCapability; onSelect?: (record: Record<string, unknown> | null, row: HTMLElement) => void }) {
  const loadedRecords = records ?? [];
  const [focusedId, setFocusedId] = useState<unknown>(undefined);
  const [expanded, setExpanded] = useState(false);
  const projection = recordListProjection(loadedRecords, total, expanded, focusedId, selectedId);
  const columns = !chosen?.length ? recordColumns(loadedRecords) : extendColumns ? extendWithRecordKeys(chosen, loadedRecords) : chosen;
  const loading = (records === null || chosen === null) && !error;
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, record: Record<string, unknown>) => handleRecordKeyDown(event, record, onSelect);
  const retry = () => { onRetry?.(); };
  const listName = collection?.replace(/[_-]+/g, " ").toLowerCase() || "records";
  const itemName = listName === "books" ? "book" : listName === "notes" ? "note" : "record";
  const ask = () => onAskChat?.(`add a ${itemName} to this page`);
  const add = !loading && !error && !projection.loaded.length && insertCapability
    ? <Button variant="outline" type="button" onClick={insertCapability.focusFirst}>Add a {itemName}</Button>
    : null;
  return <section data-record-list="" className="min-w-0" data-collection={collection} aria-busy={loading}>
    <RecordListHeader title={title} loading={loading} error={error} total={total} hasRecords={projection.loaded.length > 0} action={onAskChat ? add : null} />
    {(!error && !loading && projection.loaded.length === 0 || error || loading) && <RecordListState error={error} loading={loading} listName={listName} itemName={itemName} onRetry={retry} onAskChat={onAskChat} ask={ask} add={add} />}
    {!error && !loading && projection.loaded.length > 0 && <>
      <LoadedRecordTable columns={columns} records={projection.visible} collection={collection} title={title} selectedId={selectedId} tabStop={projection.tabStop} onSelect={onSelect} onFocus={setFocusedId} onKeyDown={onKeyDown} />
      {projection.showReveal && <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground"><Button variant="ghost" size="sm" type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "show less" : `show ${projection.loadedRemaining} more`}</Button><small>{expanded ? `${projection.loaded.length} of ${projection.total}` : `${projection.visible.length} of ${projection.total}`}</small></div>}
    </>}
  </section>;
}

function RecordListHeader({ title, loading, error, total, hasRecords, action }: { title: string; loading: boolean; error: string | null; total: number; hasRecords: boolean; action: ReactNode }) {
  return <header className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2"><h2 className="text-base font-semibold text-balance first-letter:uppercase">{title}{loading ? " loading…" : error ? "" : <> <span data-record-count="" className="ms-1 text-xs font-normal text-muted-foreground">{total.toLocaleString()}</span></>}</h2>{!loading && !error && hasRecords && <span className="text-xs text-muted-foreground">sorted by updated</span>}{action}</header>;
}

function RecordListState({ error, loading, listName, itemName, onRetry, onAskChat, ask, add }: { error: string | null; loading: boolean; listName: string; itemName: string; onRetry: () => void; onAskChat?: (draft: string) => void; ask: () => void; add: ReactNode }) {
  if (error) return <Alert data-record-list-state="error" variant="destructive" className="gap-2 rounded-none text-foreground"><div className="grid gap-2"><strong>could not load {listName}</strong><p className="text-sm text-muted-foreground">{listName} request failed: {error}. your data is safe; nothing was changed.</p><div className="flex flex-wrap gap-2"><Button variant="outline" type="button" onClick={onRetry}>try again</Button>{onAskChat && <Button variant="ghost" type="button" onClick={() => onAskChat(`help me understand why the ${listName} list could not load: ${error}`)}>ask the chat why</Button>}</div></div></Alert>;
  if (loading) return <div data-record-list-state="loading" className="grid gap-2 border-t pt-3" role="status" aria-label="loading records">{[58, 82, 68, 92, 74].map((width) => <Skeleton key={width} className="h-8 rounded-none" style={{ width: `${width}%` }} aria-hidden="true" />)}</div>;
  return <div data-record-list-state="empty" className="grid gap-2 border-t py-4"><strong>No {listName} yet</strong><p className="mb-2 text-sm text-muted-foreground">{onAskChat ? "Ask the page chat to add the first entry." : add ? "Add the first entry to this list." : "New entries will appear here."}</p><div className="flex flex-wrap gap-2">{onAskChat ? <Button variant="outline" type="button" onClick={ask}>Ask the chat</Button> : add}</div></div>;
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
  const board = columns.length === 4 && ["title", "author", "status", "updated"].every((column) => columns.includes(column));
  const mobileBoard = board ? "min-[280px]:max-[640px]:grid-cols-[minmax(0,1fr)_72px] min-[280px]:max-[640px]:[grid-template-areas:'title_status'_'author_updated'] min-[280px]:max-[640px]:gap-y-0.5" : columns.length <= 4 ? "min-[280px]:max-[640px]:grid-cols-2" : "";
  return <Table className="table-fixed max-[640px]:block max-[640px]:border-b" role={onSelect ? "grid" : "table"} aria-label={title} data-collection={collection}><TableHeader className="max-[640px]:sr-only" role="rowgroup"><TableRow role="row">{columns.map((column) => <TableHead className="h-8 px-2 text-xs font-normal first:w-[43%] first:ps-3 nth-2:w-[27%] nth-3:w-[18%] nth-4:w-[16%] last:text-right" role="columnheader" scope="col" key={column} data-column={column}>{column}</TableHead>)}</TableRow></TableHeader><TableBody className="max-[640px]:block" role="rowgroup">{records.map((record, index) => <TableRow className={cn("aria-selected:cursor-pointer aria-selected:bg-sidebar-accent aria-selected:inset-shadow-[2px_0_var(--selection)] aria-[selected=false]:cursor-pointer focus-visible:-outline-offset-2 max-[640px]:grid max-[640px]:items-baseline max-[640px]:gap-x-2 max-[640px]:gap-y-1 max-[640px]:border-t max-[640px]:border-b-0 max-[640px]:px-2 max-[640px]:py-2", mobileBoard)} role="row" key={String(record.record_id ?? index)} data-record-id={record.record_id == null ? undefined : String(record.record_id)} {...onSelect && { tabIndex: record.record_id === tabStop ? 0 : -1, "aria-selected": record.record_id === selectedId, onFocus: () => onFocus(record.record_id), onClick: (event: MouseEvent<HTMLTableRowElement>) => onSelect(record, event.currentTarget), onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => onKeyDown(event, record) }}>{columns.map((column) => {
    const value = formatRecordValue(record[column]);
    const content = value.trim() ? value : <span className="text-muted-foreground">—</span>;
    return <TableCell role={onSelect ? "gridcell" : "cell"} key={column} data-column={column} data-label={column} className={cn(
      "h-10 min-w-0 truncate px-2 py-0 first:ps-3 not-first:text-muted-foreground max-[640px]:grid max-[640px]:h-auto max-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] max-[640px]:gap-x-2 max-[640px]:overflow-visible max-[640px]:p-0 max-[640px]:text-start max-[640px]:whitespace-normal max-[640px]:[overflow-wrap:anywhere] max-[640px]:before:text-xs max-[640px]:before:text-muted-foreground max-[640px]:before:content-[attr(data-label)]",
      column === "updated" && "text-right",
      columns.length <= 4 && "min-[280px]:max-[640px]:grid-cols-1",
      board && "min-[280px]:max-[640px]:block min-[280px]:max-[640px]:before:content-none min-[280px]:max-[640px]:data-[column=title]:[grid-area:title] min-[280px]:max-[640px]:data-[column=author]:[grid-area:author] min-[280px]:max-[640px]:data-[column=status]:[grid-area:status] min-[280px]:max-[640px]:data-[column=updated]:[grid-area:updated] min-[280px]:max-[640px]:data-[column=status]:text-right min-[280px]:max-[640px]:data-[column=updated]:text-right",
    )}>{column === "status" ? <span className="inline-flex min-w-0 items-center gap-2 max-[640px]:gap-1 [&>[data-record-mark]]:m-0"><RecordMark status={String(record[column] ?? "")} />{content}</span> : content}</TableCell>;
  })}</TableRow>)}</TableBody></Table>;
}

function formatRecordValue(value: unknown): string { return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""); }
