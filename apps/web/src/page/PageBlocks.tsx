import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { formValuesToArguments, mapToolError, recordForm, type FieldErrors, type FormField, type FormValue, type ToolError } from "./recordForm";

export type PageWriter = {
  credential: string;
  invoke: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
type Page = { id: string };
type Tool = { name: string; operation: string; collection: string; input_schema: unknown; version: number };
type RecordRow = Record<string, unknown>;

export function PageBlocks({ page, blocks, writer, refreshKey }: { page: Page; blocks: Array<Record<string, unknown>>; writer?: PageWriter; refreshKey: string }) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const [writeRefresh, setWriteRefresh] = useState(0);
  useEffect(() => {
    if (!writer) { setTools([]); return; }
    let live = true;
    void writer.invoke(`/api/pages/${encodeURIComponent(page.id)}/tools`, { headers: { Authorization: `Bearer ${writer.credential}` }, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`could not load tools (${response.status})`);
        const value = await response.json() as { tools?: unknown };
        if (!Array.isArray(value.tools)) throw new Error("invalid tools response");
        if (live) setTools(value.tools as Tool[]);
      })
      .catch(() => { if (live) setTools([]); });
    return () => { live = false; };
  }, [page.id, refreshKey, writer]);
  const refresh = `${refreshKey}:${writeRefresh}`;
  return <>{blocks.map((block, index) => {
    if (block.type === "text") return <p key={index}>{String(block.text)}</p>;
    // TODO: computed metrics use this same value shape when the metric branch merges.
    if (block.type === "metric") return <p key={index}><strong>{String(block.label)}:</strong> {String(block.value)}</p>;
    if (block.type === "list") return <RecordList key={index} title={String(block.title)} collection={String(block.collection)} pageId={page.id} writer={writer} refreshKey={refresh} selected={selected} onSelect={setSelected} />;
    if (block.type === "detail") return <RecordDetail key={index} title={String(block.title)} fields={block.fields} selected={selected} />;
    if (block.type === "form") {
      const name = typeof block.tool === "string" ? block.tool : null;
      const tool = tools.find((candidate) => candidate.name === name);
      return <RecordEditor key={index} title={String(block.title)} pageId={page.id} toolName={name} tool={tool} writer={writer} selected={selected} onWritten={() => setWriteRefresh((value) => value + 1)} />;
    }
    return null;
  })}</>;
}

function RecordList({ title, collection, pageId, writer, refreshKey, selected, onSelect }: { title: string; collection: string; pageId: string; writer?: PageWriter; refreshKey: string; selected: RecordRow | null; onSelect: (record: RecordRow) => void }) {
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  useEffect(() => {
    if (!writer) { setRecords([]); setTotal(0); setError(null); return; }
    let live = true;
    const request = ++requestSequence.current;
    void writer.invoke(`/api/pages/${encodeURIComponent(pageId)}/records/${encodeURIComponent(collection)}?limit=100`, { headers: { Authorization: `Bearer ${writer.credential}` }, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`could not load records (${response.status})`);
        const value = await response.json();
        if (!Array.isArray(value)) throw new Error("invalid records response");
        if (live && request === requestSequence.current) {
          setRecords(value); setTotal(Number(response.headers.get("x-achilles-total") ?? value.length)); setError(null);
          const refreshedSelection = value.find((record) => record.record_id === selected?.record_id);
          if (refreshedSelection) onSelect(refreshedSelection);
        }
      })
      .catch((caught) => { if (live && request === requestSequence.current) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { live = false; };
  }, [collection, pageId, refreshKey, writer]);
  const columns = [...new Set(records.flatMap((record) => Object.keys(record).filter((key) => key !== "record_id" && key !== "revision")))];
  if (records.some((record) => "record_id" in record)) columns.push("record_id");
  return <section className="record-list"><h2>{title}</h2>{!writer ? <p>take control to view records</p> : error ? <p role="alert">{error}</p> : records.length === 0 ? <p>no records yet</p> : <><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{records.map((record, index) => {
    const id = String(record.record_id ?? index);
    const active = selected?.record_id === record.record_id;
    const choose = () => onSelect(record);
    return <tr key={id} tabIndex={0} aria-selected={active} onClick={choose} onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } }}>{columns.map((column) => <td key={column}>{formatRecordValue(record[column])}</td>)}</tr>;
  })}</tbody></table>{total > 100 && <p>showing newest 100 of {total}</p>}</>}</section>;
}

function RecordDetail({ title, fields, selected }: { title: string; fields: unknown; selected: RecordRow | null }) {
  const names = Array.isArray(fields) ? fields.filter((field): field is string => typeof field === "string") : [];
  return <section><h2>{title}</h2>{selected ? <dl>{names.map((name) => <div key={name}><dt>{name}</dt><dd>{formatRecordValue(selected[name])}</dd></div>)}</dl> : <p>select a record</p>}</section>;
}

function initialValues(fields: FormField[], selected: RecordRow | null): Record<string, FormValue> {
  return Object.fromEntries(fields.map((field) => {
    const current = selected?.[field.name];
    if (field.type === "enum") {
      const option = field.options?.find(({ argument }) => Object.is(argument, current));
      return [field.name, option?.value ?? field.defaultValue ?? ""];
    }
    if (field.type === "boolean") return [field.name, typeof current === "boolean" ? current : field.defaultValue ?? false];
    return [field.name, current === undefined || current === null ? field.defaultValue ?? "" : String(current)];
  }));
}

function RecordEditor({ title, pageId, toolName, tool, writer, selected, onWritten }: { title: string; pageId: string; toolName: string | null; tool?: Tool; writer?: PageWriter; selected: RecordRow | null; onWritten: () => void }) {
  if (!toolName) return <p aria-disabled="true">{title}: no tool for this form yet — ask the chat</p>;
  if (!writer) return <p aria-disabled="true">{title}: take control to edit</p>;
  if (!tool) return <p aria-disabled="true">{title}: no tool for this form yet — ask the chat</p>;
  if (tool.operation === "update" && !selected) return <p aria-disabled="true">{title}: select a record to edit</p>;
  return <ActiveRecordForm title={title} pageId={pageId} tool={tool} writer={writer} selected={tool.operation === "update" ? selected : null} onWritten={onWritten} />;
}

function ActiveRecordForm({ title, pageId, tool, writer, selected, onWritten }: { title: string; pageId: string; tool: Tool; writer: PageWriter; selected: RecordRow | null; onWritten: () => void }) {
  const definition = useMemo(() => recordForm(tool.input_schema), [tool.input_schema]);
  const identity = `${tool.name}:${String(selected?.record_id ?? "insert")}:${String(selected?.revision ?? "")}`;
  const [values, setValues] = useState<Record<string, FormValue>>(() => initialValues(definition.fields, selected));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValues(initialValues(definition.fields, selected)); setErrors({}); setStatus(null); }, [definition.fields, identity]);
  if (definition.fallback) return <p>{definition.fallback}</p>;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const hidden = selected ? { record_id: selected.record_id, revision: selected.revision } : {};
    const converted = formValuesToArguments(definition.fields, values, hidden);
    setErrors(converted.errors); setStatus(null);
    if (Object.keys(converted.errors).length) return;
    setSaving(true);
    try {
      const response = await writer.invoke(`/api/pages/${encodeURIComponent(pageId)}/tools/${encodeURIComponent(tool.name)}/invoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${writer.credential}`, "content-type": "application/json" },
        body: JSON.stringify({ arguments: converted.arguments, version: tool.version }),
      });
      const body = await response.json().catch(() => null) as { error?: ToolError } | null;
      if (response.status === 409) { setStatus("this record changed; reload it"); return; }
      if (!response.ok) {
        const mapped = body?.error ? mapToolError(body.error) : null;
        if (mapped) setErrors({ [mapped.field]: mapped.message });
        else setStatus(`could not save (${response.status})`);
        return;
      }
      setStatus("saved");
      if (!selected) setValues(initialValues(definition.fields, null));
      onWritten();
    } catch { setStatus("could not save"); }
    finally { setSaving(false); }
  };
  return <form onSubmit={submit}><h2>{title}</h2>{definition.fields.map((field) => <FormControl key={field.name} idPrefix={tool.name} field={field} value={values[field.name] ?? (field.type === "boolean" ? false : "")} error={errors[field.name]} onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />)}{status && <p role={status === "saved" ? "status" : "alert"}>{status}</p>}<button type="submit" disabled={saving}>{saving ? "saving…" : "save"}</button></form>;
}

function FormControl({ idPrefix, field, value, error, onChange }: { idPrefix: string; field: FormField; value: FormValue; error?: string; onChange: (value: FormValue) => void }) {
  const id = `record-${idPrefix}-${field.name}`;
  const describedBy = error ? `${id}-error` : undefined;
  const label = <>{field.name}{field.required && " *"}</>;
  if (field.type === "boolean") return <div><label><input id={id} name={field.name} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /> {label}</label>{error && <p id={describedBy}>{error}</p>}</div>;
  if (field.type === "enum") return <div><label htmlFor={id}>{label}</label><select id={id} name={field.name} required={field.required} value={String(value)} aria-describedby={describedBy} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)}><option value="">select…</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{error && <p id={describedBy}>{error}</p>}</div>;
  const type = field.format === "uri" ? "url" : field.format === "date" ? "date" : field.type === "number" || field.type === "integer" ? "number" : "text";
  return <div><label htmlFor={id}>{label}</label><input id={id} name={field.name} type={type} step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined} required={field.required} value={String(value)} aria-describedby={describedBy} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />{error && <p id={describedBy}>{error}</p>}</div>;
}

function formatRecordValue(value: unknown): string { return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""); }
