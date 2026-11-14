import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { emptyValues, formArguments, formFields, type FormField, type FormValues } from "./formSchema";

export type PageTool = { name: string; operation: string; collection: string; input_schema: unknown; version: number };
type FieldError = { path: string; expected: string };

const writes = new Map<string, number>();
const listeners = new Set<() => void>();
function notifyRecordWrite(pageId: string) {
  writes.set(pageId, (writes.get(pageId) ?? 0) + 1);
  for (const listener of listeners) listener();
}
// Record blocks add this to their refresh key, so a form write reloads them without a chat turn.
export function useRecordWrites(pageId: string): number {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => writes.get(pageId) ?? 0);
}

export function FormBlock({ title, toolName, pageId, credential, refreshKey }: { title: string; toolName: string; pageId: string; credential: string; refreshKey: string }) {
  const [tool, setTool] = useState<PageTool | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    void fetch(`/api/pages/${pageId}/tools`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`could not load tools (${response.status})`);
        const body = await response.json() as { tools?: PageTool[] };
        if (live) { setTool(body.tools?.find((item) => item.name === toolName) ?? null); setError(null); }
      })
      .catch((caught) => { if (live) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { live = false; };
  }, [credential, pageId, toolName, refreshKey, reload]);
  const body = error ? <p role="alert">{error}</p>
    : tool === undefined ? <p role="status">loading form…</p>
    : tool === null ? <p aria-disabled="true">no tool assigned</p>
    : tool.operation !== "insert" ? <p aria-disabled="true">edit forms need a selected row</p>
    : <RecordForm tool={tool} pageId={pageId} credential={credential} onReloadTool={() => setReload((value) => value + 1)} />;
  return <section className="record-form"><h2>{title}</h2>{body}</section>;
}

export function RecordForm({ tool, pageId, credential, onReloadTool }: { tool: PageTool; pageId: string; credential: string; onReloadTool: () => void }) {
  const mapped = formFields(tool.input_schema);
  const fields = "fields" in mapped ? mapped.fields : [];
  const [values, setValues] = useState<FormValues>(() => emptyValues(fields));
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [message, setMessage] = useState<{ kind: "status" | "alert" | "conflict"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const idPrefix = useId();
  if ("unsupported" in mapped) return <p aria-disabled="true">this form needs the chat: unsupported field {mapped.unsupported}</p>;

  const focusField = (name?: string) => form.current?.querySelector<HTMLElement>(name ? `[name="${CSS.escape(name)}"]` : "[name]")?.focus();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setFieldError(null); setMessage(null);
    try {
      const response = await fetch(`/api/pages/${pageId}/tools/${encodeURIComponent(tool.name)}/invoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ arguments: formArguments(fields, values), version: tool.version }),
      });
      const body = await response.json().catch(() => null) as { error?: FieldError; detail?: string } | null;
      if (response.status === 409) { setMessage({ kind: "conflict", text: "this tool changed; reload" }); return; }
      if (!response.ok) {
        const path = body?.error?.path ?? "";
        const name = path.split("/")[1];
        if (body?.error && fields.some((field) => field.name === name)) { setFieldError(body.error); focusField(name); }
        else setMessage({ kind: "alert", text: body?.error ? `${path || "input"}: ${body.error.expected}` : body?.detail ?? `could not add (${response.status})` });
        return;
      }
      setValues(emptyValues(fields));
      setMessage({ kind: "status", text: "added" });
      notifyRecordWrite(pageId);
      focusField();
    } catch (caught) {
      setMessage({ kind: "alert", text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setBusy(false);
    }
  };

  return <form ref={form} noValidate onSubmit={(event) => void submit(event)}>
    {fields.map((field) => <Field key={field.name} id={`${idPrefix}-${field.name}`} field={field} value={values[field.name] ?? (field.kind === "boolean" ? false : "")} error={fieldError?.path === `/${field.name}` ? fieldError.expected : null} onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />)}
    <div className="record-form-actions">
      <button type="submit" className="primary" disabled={busy}>{busy ? "adding…" : "add"}</button>
      {message && <p role={message.kind === "status" ? "status" : "alert"}>{message.text}</p>}
      {message?.kind === "conflict" && <button type="button" onClick={() => { setMessage(null); onReloadTool(); }}>reload tool</button>}
    </div>
  </form>;
}

function Field({ id, field, value, error, onChange }: { id: string; field: FormField; value: string | boolean; error: string | null; onChange: (value: string | boolean) => void }) {
  const described = [field.description ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const common = { id, name: field.name, "aria-required": field.required, "aria-invalid": error ? true : undefined, "aria-describedby": described };
  const control = field.kind === "boolean" ? <input {...common} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
    : field.kind === "enum" ? <select {...common} value={String(value)} onChange={(event) => onChange(event.target.value)}><option value="">{field.required ? "choose…" : "none"}</option>{field.options.map((option, index) => <option key={index} value={String(index)}>{String(option)}</option>)}</select>
    : <input {...common} type={field.kind === "string" ? "text" : "number"} step={field.kind === "integer" ? 1 : "any"} value={String(value)} onChange={(event) => onChange(event.target.value)} />;
  return <div className={`record-field${field.kind === "boolean" ? " record-field-check" : ""}`}>
    <label htmlFor={id}>{field.name}{field.required && <span className="required-mark" aria-hidden="true"> *</span>}</label>
    {control}
    {field.description && <small id={`${id}-help`}>{field.description}</small>}
    {error && <p id={`${id}-error`} className="field-error">{error}</p>}
  </div>;
}
