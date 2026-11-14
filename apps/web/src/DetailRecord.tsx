import { useEffect, useRef, useState } from "react";

export type DetailFilter = { field: string; equals: string | number | boolean | null };

type DetailRecordProps = {
  title: string;
  collection: string;
  fields: string[];
  filter: DetailFilter;
  pageId: string;
  credential: string;
  refreshKey: string;
};

type DetailRecordViewProps = Pick<DetailRecordProps, "title" | "collection" | "fields" | "filter"> & {
  records: Record<string, unknown>[] | null;
  total: number;
  error: string | null;
};

export function DetailRecord({ title, collection, fields, filter, pageId, credential, refreshKey }: DetailRecordProps) {
  const [records, setRecords] = useState<Record<string, unknown>[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  useEffect(() => {
    let live = true;
    const request = ++requestSequence.current;
    const query = new URLSearchParams({ field: filter.field, equals: JSON.stringify(filter.equals) });
    setRecords(null);
    setError(null);
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
    });
    return () => { live = false; };
  }, [collection, credential, filter.equals, filter.field, pageId, refreshKey]);
  return <DetailRecordView title={title} collection={collection} fields={fields} filter={filter} records={records} total={total} error={error} />;
}

export function DetailRecordView({ title, collection, fields, filter, records, total, error }: DetailRecordViewProps) {
  const filterValue = formatValue(filter.equals) || "—";
  return <section className="record-detail">
    <h2>{title}</h2>
    {error ? <p role="alert">{error}</p>
      : records === null ? <p role="status">loading record…</p>
      : records.length === 0 ? <p>no {collection} with {filter.field} = {filterValue} yet</p>
      : <><dl>{fields.map((field) => <div key={field}><dt>{field}</dt><dd>{formatValue(records[0][field]) || "—"}</dd></div>)}</dl>{total > 1 && <p className="match-note">{total} records match</p>}</>}
  </section>;
}

function formatValue(value: unknown): string {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
}
