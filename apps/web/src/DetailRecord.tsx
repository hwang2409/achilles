import { useEffect, useRef, useState } from "react";
import { RecordMark } from "./page/RecordMark";

export type DetailFilter = { field: string; equals: string | number | boolean | null };

type DetailRecordProps = {
  title: string;
  collection: string;
  fields: string[];
  filter: DetailFilter;
  pageId: string;
  credential: string;
  refreshKey: string;
  selected?: Record<string, unknown>;
};

type DetailRecordViewProps = Pick<DetailRecordProps, "title" | "collection" | "fields" | "filter"> & {
  records: Record<string, unknown>[] | null;
  total: number;
  error: string | null;
  selected?: Record<string, unknown>;
};

export function DetailRecord({ title, collection, fields, filter, pageId, credential, refreshKey, selected }: DetailRecordProps) {
  const [records, setRecords] = useState<Record<string, unknown>[] | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const queryKey = `${filter.field}:${JSON.stringify(filter.equals)}`;
  const previousQuery = useRef(queryKey);
  useEffect(() => {
    let live = true;
    const request = ++requestSequence.current;
    const query = new URLSearchParams({ field: filter.field, equals: JSON.stringify(filter.equals), limit: "1" });
    setError(null);
    if (previousQuery.current !== queryKey) setRecords(null);
    previousQuery.current = queryKey;
    setRefreshing(true);
    void fetch(`/api/pages/${pageId}/records/${encodeURIComponent(collection)}?${query}`, {
      headers: { Authorization: `Bearer ${credential}` },
      cache: "no-store",
    }).then(async (response) => {
      if (!response.ok) throw new Error(`could not load record (${response.status})`);
      const value = await response.json();
      if (!Array.isArray(value)) throw new Error("invalid records response");
      if (live && request === requestSequence.current) {
        setRecords(value);
        setTotal(Number(response.headers.get("x-achilles-total") ?? value.length));
      }
    }).catch((caught) => {
      if (live && request === requestSequence.current) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (live && request === requestSequence.current) setRefreshing(false);
    });
    return () => { live = false; };
  }, [collection, credential, filter.equals, filter.field, pageId, refreshKey, queryKey]);
  return <DetailRecordView title={title} collection={collection} fields={fields} filter={filter} records={records} total={total} error={error} refreshing={refreshing} selected={selected} />;
}

export function DetailRecordView({ title, collection, fields, filter, records, total, error, refreshing, selected }: DetailRecordViewProps & { refreshing: boolean }) {
  const filterValue = formatValue(filter.equals) || "—";
  const selectedMatches = selected !== undefined;
  const shownRecords = selected ? [selected] : records;
  const firstRecord = shownRecords?.[0];
  const selectedTitle = selectedMatches ? String(selected.title ?? selected.name ?? selected.label ?? title) : title;
  return <section data-record-detail="" className="min-w-0 [&>p]:text-sm [&>p]:text-muted-foreground">
    <h2 className="mb-3 text-base font-semibold text-balance">{selectedMatches ? <>{selectedTitle} <small className="text-xs font-normal text-muted-foreground">selected</small></> : title}</h2>
    <DetailRecordBody error={error} refreshing={refreshing} records={shownRecords} firstRecord={firstRecord} collection={collection} filter={filter} filterValue={filterValue} fields={fields} total={total} selectedMatches={selectedMatches} />
  </section>;
}

function DetailRecordBody({ error, refreshing, records, firstRecord, collection, filter, filterValue, fields, total, selectedMatches }: { error: string | null; refreshing: boolean; records: Record<string, unknown>[] | null; firstRecord?: Record<string, unknown>; collection: string; filter: DetailFilter; filterValue: string; fields: string[]; total: number; selectedMatches: boolean }) {
  if (error) return <p role="alert">{error}</p>;
  if (records === null) return <>{refreshing && <p role="status">loading record…</p>}</>;
  if (!firstRecord) return <>{refreshing && <p role="status">loading record…</p>}<p>no {collection} with {filter.field} = {filterValue} yet</p></>;
  return <>{refreshing && <p role="status">loading record…</p>}<dl className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-x-4 [&_dt]:text-muted-foreground [&_dd]:whitespace-pre-wrap [&_:is(dt,dd)]:min-w-0 [&_:is(dt,dd)]:border-b [&_:is(dt,dd)]:py-2 [&_:is(dt,dd)]:[overflow-wrap:anywhere] [&_[data-record-mark]]:me-2">{fields.map((field) => <div className="contents" key={field}><dt>{field}</dt><dd>{field === "status" ? <><RecordMark status={String(firstRecord[field] ?? "")} />{formatValue(firstRecord[field]) || "—"}</> : formatValue(firstRecord[field]) || "—"}</dd></div>)}</dl>{total > 1 && !selectedMatches && <p className="mt-2">{total} records match</p>}</>;
}

function formatValue(value: unknown): string {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
}
