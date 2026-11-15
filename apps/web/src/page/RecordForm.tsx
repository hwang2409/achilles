import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { restoreFocus } from "../keyboard";
import { formArguments, formErrors, formFields, keepValues, recordValues, type FormField, type FormValues } from "./formSchema";
import { usePageTools, type PageTool } from "./usePageTools";

export type { PageTool };
type FieldError = { path: string; expected: string };

const writes = new Map<string, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => { for (const listener of listeners) listener(); };
function notifyRecordWrite(pageId: string) {
  writes.set(pageId, (writes.get(pageId) ?? 0) + 1);
  notify();
}
// Record blocks add this to their refresh key, so a form write reloads them without a chat turn.
export function useRecordWrites(pageId: string): number {
  return useSyncExternalStore(subscribe, () => writes.get(pageId) ?? 0);
}

// One selected row per page: the record table sets it, an update form on the same page edits it.
export type SelectedRow = { collection: string; record: Record<string, unknown> };
const selections = new Map<string, SelectedRow>();
export function selectRow(pageId: string, row: SelectedRow | null) {
  if (row) selections.set(pageId, row); else selections.delete(pageId);
  notify();
}
export function useSelectedRow(pageId: string): SelectedRow | null {
  return useSyncExternalStore(subscribe, () => selections.get(pageId) ?? null);
}

export function FormBlock({ title, toolName, fields, pageId, credential, refreshKey }: { title: string; toolName: string; fields?: string[]; pageId: string; credential: string; refreshKey: string }) {
  const [reload, setReload] = useState(0);
  // Default key matches other blocks on the same refreshKey, so a page with a form and the
  // empty chat starters share one fetch; a manual "reload tool" click forces its own fresh key.
  const { tools, error } = usePageTools(pageId, credential, reload > 0 ? `${refreshKey}:${reload}` : refreshKey);
  // A refetch (chat turn end, "reload tool") keeps the last list on screen, so the form stays mounted with what the user typed.
  const last = useRef<PageTool[] | null>(null);
  if (tools !== null) last.current = tools;
  const shown = tools ?? last.current;
  const tool = shown === null ? undefined : shown.find((item) => item.name === toolName) ?? null;
  const selected = useSelectedRow(pageId);
  const row = tool && selected?.collection === tool.collection ? selected.record : null;
  const onReloadTool = () => setReload((value) => value + 1);
  const heading = tool && tool.operation === "update" && row ? `${title} · ${editingLabel(tool, fields, row)}` : title;
  const body = tool === undefined ? <p role={error ? "alert" : "status"}>{error ?? "loading form…"}</p>
    : tool === null ? <p aria-disabled="true">no tool assigned</p>
    : tool.operation === "insert" ? <RecordForm tool={tool} order={fields} pageId={pageId} credential={credential} onReloadTool={onReloadTool} />
    : tool.operation !== "update" ? <p aria-disabled="true">this tool has no form</p>
    : row ? <RecordForm key={String(row.record_id)} tool={tool} order={fields} row={row} pageId={pageId} credential={credential} onReloadTool={onReloadTool} />
    : <p aria-disabled="true">select a row in the table to edit it</p>;
  return <section className="record-form"><h2>{heading}</h2>{error && tool !== undefined && <p role="alert">{error}</p>}{body}</section>;
}

// Names which record a form edits by its first listed field, in the header and (at narrow widths) above the form itself.
function editingLabel(tool: PageTool, order: string[] | undefined, row: Record<string, unknown>): string {
  const mapped = formFields(tool.input_schema, order);
  const first = ("fields" in mapped ? mapped.fields : []).find((field) => field.name !== "record_id" && field.name !== "revision");
  const value = first ? row[first.name] : undefined;
  return value === null || value === undefined ? "" : String(value);
}

// The table marks each row with its record id (App.tsx), so the form can find its row back after cancel or save.
const tableRow = (recordId: unknown) => document.querySelector<HTMLElement>(`[data-record-id="${CSS.escape(String(recordId))}"]`);

// With a row, the form edits that record: record_id and revision come from the row and are never inputs.
export function RecordForm({ tool, order, row, pageId, credential, onReloadTool }: { tool: PageTool; order?: string[]; row?: Record<string, unknown>; pageId: string; credential: string; onReloadTool: () => void }) {
  const mapped = formFields(tool.input_schema, order);
  const fields = "fields" in mapped ? mapped.fields.filter((field) => !row || (field.name !== "record_id" && field.name !== "revision")) : [];
  const selectedValue = row && fields[0] ? row[fields[0].name] : undefined;
  const selectedLabel = selectedValue === null || selectedValue === undefined ? "" : String(selectedValue);
  // typed holds only what the user changed, so a reloaded row shows its new values under the user's edits
  const [typed, setTyped] = useState<FormValues>({});
  const values = keepValues(fields, row ? { ...recordValues(fields, row), ...typed } : typed);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "status" | "alert" | "conflict" | "row-conflict"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const idPrefix = useId();
  // a new notice can render below the visible part of the scrolling page blocks (M-3 in firstrun-2a2a863)
  useEffect(() => { if (message) form.current?.querySelector(".record-form-actions")?.scrollIntoView({ block: "nearest" }); }, [message]);
  if ("unsupported" in mapped) return <p aria-disabled="true">this form needs the chat: unsupported field {mapped.unsupported}</p>;

  const focusField = (name?: string) => form.current?.querySelector<HTMLElement>(name ? `[name="${CSS.escape(name)}"]` : "[name]")?.focus();
  // Clears the selection and hands focus back to the row, whether triggered by the cancel button or Escape.
  const cancel = () => {
    if (!row) return;
    const recordId = row.record_id;
    selectRow(pageId, null);
    restoreFocus(tableRow(recordId));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    const errors = formErrors(fields, values);
    setFieldErrors(errors);
    const first = Object.keys(errors)[0];
    if (first !== undefined) { focusField(first); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/pages/${pageId}/tools/${encodeURIComponent(tool.name)}/invoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ arguments: { ...formArguments(fields, values), ...(row && { record_id: row.record_id, revision: row.revision }) }, version: tool.version }),
      });
      const body = await response.json().catch(() => null) as ({ error?: FieldError; detail?: string } & Record<string, unknown>) | null;
      if (response.status === 409 && row && body?.error?.path === "/revision") { setMessage({ kind: "row-conflict", text: "this row changed since you selected it. your edits are kept." }); return; }
      if (response.status === 409) { setMessage({ kind: "conflict", text: "this tool changed; reload" }); return; }
      if (!response.ok) {
        const path = body?.error?.path ?? "";
        const name = path.split("/")[1];
        if (body?.error && fields.some((field) => field.name === name)) { setFieldErrors({ [name]: body.error.expected }); focusField(name); }
        else setMessage({ kind: "alert", text: body?.error ? `${path || "input"}: ${body.error.expected}` : body?.detail ?? `could not ${row ? "save" : "add"} (${response.status})` });
        return;
      }
      setTyped({});
      setMessage({ kind: "status", text: row ? "saved" : "added" });
      // the saved record (new revision) stays selected, so the next save does not conflict with itself; scroll it into view, since edits can happen off screen
      if (row && body) { selectRow(pageId, { collection: tool.collection, record: body }); tableRow(body.record_id)?.scrollIntoView({ block: "nearest" }); }
      notifyRecordWrite(pageId);
      if (!row) focusField();
    } catch (caught) {
      setMessage({ kind: "alert", text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setBusy(false);
    }
  };
  // shortcut: finds the row in the newest 100 records (the table's own limit); a by-id read would need a new route.
  const reloadRow = async () => {
    setMessage(null);
    try {
      const response = await fetch(`/api/pages/${pageId}/records/${encodeURIComponent(tool.collection)}?limit=100`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" });
      if (!response.ok) throw new Error(`could not reload the row (${response.status})`);
      const records = await response.json() as Record<string, unknown>[];
      const current = Array.isArray(records) ? records.find((record) => record.record_id === row?.record_id) : undefined;
      if (!current) { setMessage({ kind: "alert", text: "this row is no longer in the table" }); return; }
      selectRow(pageId, { collection: tool.collection, record: current });
      notifyRecordWrite(pageId);
      focusField();
    } catch (caught) {
      setMessage({ kind: "alert", text: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  return <>
    {row && <p className="record-form-selected">selected: {selectedLabel}</p>}
    <form ref={form} noValidate onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === "Escape" && row && !event.defaultPrevented) { event.preventDefault(); cancel(); } }}>
    {fields.map((field) => <Field key={field.name} id={`${idPrefix}-${field.name}`} field={field} value={values[field.name]} error={fieldErrors[field.name] ?? null} onChange={(value) => { setTyped((current) => ({ ...current, [field.name]: value })); setMessage((current) => current?.kind === "status" ? null : current); }} />)}
    <div className="record-form-actions">
      <button type="submit" className="primary" disabled={busy}>{row ? (busy ? "saving…" : "save") : busy ? "adding…" : "add"}</button>
      {row && <button type="button" onClick={cancel}>cancel</button>}
      {message && <p role={message.kind === "status" ? "status" : "alert"}>{message.text}</p>}
      {message?.kind === "row-conflict" && <button type="button" onClick={() => void reloadRow()}>reload row</button>}
      {message?.kind === "conflict" && <button type="button" onClick={() => { setMessage(null); onReloadTool(); focusField(); }}>reload tool</button>}
    </div>
    </form>
  </>;
}

function Field({ id, field, value, error, onChange }: { id: string; field: FormField; value: string | boolean; error: string | null; onChange: (value: string | boolean) => void }) {
  const described = [field.description ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const common = { id, name: field.name, "aria-required": field.required, "aria-invalid": error ? true : undefined, "aria-describedby": described };
  const control = field.kind === "boolean" ? <input {...common} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
    : field.kind === "enum" ? <select {...common} value={String(value)} onChange={(event) => onChange(event.target.value)}><option value="">{field.required ? "choose…" : "none"}</option>{field.options.map((option, index) => <option key={index} value={JSON.stringify(option)}>{String(option)}</option>)}</select>
    : <input {...common} type={field.kind === "string" ? "text" : "number"} step={field.kind === "integer" ? 1 : "any"} value={String(value)} onChange={(event) => onChange(event.target.value)} />;
  return <div className={`record-field${field.kind === "boolean" ? " record-field-check" : ""}`}>
    <label htmlFor={id}>{field.name}{field.required && <span className="required-mark" aria-hidden="true"> *</span>}</label>
    {control}
    {field.description && <small id={`${id}-help`}>{field.description}</small>}
    {error && <p id={`${id}-error`} className="field-error">{error}</p>}
  </div>;
}
