import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { fieldError, formArguments, formErrors, formFields, keepValues, recordValues, type FormField, type FormValues } from "./formSchema";
import { schemaColumns } from "./listColumns";
import { usePageTools, type PageTool } from "./usePageTools";
import { EnumListbox } from "./EnumListbox";

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
// opener is the exact table row the user picked: two tables on a page can show the same collection.
export type SelectedRow = { collection: string; record: Record<string, unknown>; opener?: HTMLElement };
const selections = new Map<string, SelectedRow>();
export function selectRow(pageId: string, row: SelectedRow | null) {
  if (row) selections.set(pageId, row); else selections.delete(pageId);
  notify();
}
// A table reload (after an agent write, for example) carries the newest copy of the selected record; the form follows it.
// Only a newer revision replaces it, so a reload that started before the form's own save cannot roll the form back.
export function refreshSelection(pageId: string, collection: string, records: Record<string, unknown>[]) {
  const current = selections.get(pageId);
  if (current?.collection !== collection) return;
  const fresh = records.find((record) => record.record_id === current.record.record_id);
  if (fresh && Number(fresh.revision) > Number(current.record.revision)) selectRow(pageId, { ...current, record: fresh });
}
export function useSelectedRow(pageId: string): SelectedRow | null {
  return useSyncExternalStore(subscribe, () => selections.get(pageId) ?? null);
}

export function FormBlock({ title, toolName, fields, pageId, credential, refreshKey, onRegisterInsert, canMutate = true, disabledReason }: { title: string; toolName: string; fields?: string[]; pageId: string; credential: string; refreshKey: string; onRegisterInsert?: (id: string, capability: { collection: string; focusFirst: () => void }) => () => void; canMutate?: boolean; disabledReason?: string }) {
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
  const formRef = useRef<HTMLFormElement>(null);
  const registrationId = useId();
  const onReloadTool = () => setReload((value) => value + 1);
  // without block fields, a form lists its inputs in the table's column order (data schema required first), not the
  // tool input's own required list: an update tool requires only record_id/revision, which would sort title last
  const order = fields ?? (tool && shown ? schemaColumns(shown, tool.collection) : undefined);
  useEffect(() => {
    if (tool?.operation !== "insert" || !onRegisterInsert) return;
    const capability = { collection: tool.collection, focusFirst: () => formRef.current?.querySelector<HTMLElement>("[name]")?.focus() };
    return onRegisterInsert(registrationId, capability);
  }, [onRegisterInsert, registrationId, tool?.collection, tool?.operation]);
  const heading = title;
  const headingNote = tool?.operation === "update" ? row ? `runs ${toolName} on the selected row` : `select a ${tool.collection.replace(/s$/, "")} in the list to edit it` : "";
  const body = tool === undefined ? <p role={error ? "alert" : "status"}>{error ?? "loading form…"}</p>
    : tool === null ? <p aria-disabled="true">no tool assigned</p>
    : tool.operation === "insert" ? <RecordForm tool={tool} order={order} pageId={pageId} credential={credential} onReloadTool={onReloadTool} formRef={formRef} disabled={!canMutate} disabledReason={disabledReason} />
    : tool.operation !== "update" ? <p aria-disabled="true">this tool has no form</p>
    : <RecordForm key={row ? String(row.record_id) : "no-selection"} tool={tool} order={order} row={row ?? undefined} opener={selected?.opener} pageId={pageId} credential={credential} onReloadTool={onReloadTool} disabled={!row || !canMutate} disabledReason={disabledReason} formRef={formRef} />;
  return <section className={`record-form${tool?.operation === "update" && !row ? " record-form-no-selection" : ""}`} data-collection={tool?.collection} data-operation={tool?.operation}><h2>{heading} {headingNote && <small className="form-note">{headingNote}</small>}</h2>{error && tool !== undefined && <p role="alert">{error}</p>}{body}</section>;
}

// The form finds its row back after cancel or save: the row that opened it while it is still on the page, else the first
// table of the collection (App.tsx marks each table with its collection and each row with its record id; ids are unique per collection).
const tableRow = (opener: HTMLElement | undefined, collection: string, recordId: unknown) => {
  if (opener?.isConnected && opener.dataset.recordId === String(recordId)) return opener;
  return document.querySelector<HTMLElement>(`table[data-collection="${CSS.escape(collection)}"] tr[data-record-id="${CSS.escape(String(recordId))}"]`);
};

// With a row, the form edits that record: record_id and revision come from the row and are never inputs.
export function RecordForm({ tool, order, row, opener, pageId, credential, onReloadTool, disabled = false, disabledReason, formRef }: { tool: PageTool; order?: string[]; row?: Record<string, unknown>; opener?: HTMLElement; pageId: string; credential: string; onReloadTool: () => void; disabled?: boolean; disabledReason?: string; formRef?: RefObject<HTMLFormElement | null> }) {
  const mapped = formFields(tool.input_schema, order);
  const fields = "fields" in mapped ? mapped.fields.filter((field) => !row || (field.name !== "record_id" && field.name !== "revision")) : [];
  // typed holds only what the user changed, so a reloaded row shows its new values under the user's edits
  const [typed, setTyped] = useState<FormValues>({});
  const values = keepValues(fields, row ? { ...recordValues(fields, row), ...typed } : typed);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "status" | "alert" | "conflict" | "row-conflict" | "row-changed"; text: string } | null>(null);
  // The row arrives at a new revision (an agent write): a clean form just shows it; a form with edits keeps them over
  // the new values and says so. The form's own save and "reload row" are the user's choice and need no note.
  const chosenRevision = useRef<unknown>(undefined);
  const [seenRow, setSeenRow] = useState(row);
  if (row && row.revision !== seenRow?.revision) {
    setSeenRow(row);
    if (row.revision !== chosenRevision.current && Object.keys(typed).length > 0) {
      const changed = fields.filter((field) => JSON.stringify(row[field.name]) !== JSON.stringify(seenRow?.[field.name])).map((field) => field.name);
      setMessage({ kind: "row-changed", text: `this record changed${changed.length ? ` (${changed.join(", ")})` : ""}; your edits are kept — review and save, or discard` });
    }
  }
  const [busy, setBusy] = useState(false);
  const internalForm = useRef<HTMLFormElement>(null);
  const form = formRef ?? internalForm;
  const idPrefix = useId();
  // a new notice can render below the visible part of the scrolling page blocks (M-3 in firstrun-2a2a863); a
  // successful save on a row scrolls to the row instead, since that is what "saved" means to the user here
  useEffect(() => { if (!message) return; (row && message.kind === "status" ? tableRow(opener, tool.collection, row.record_id) : form.current?.querySelector(".record-form-actions"))?.scrollIntoView({ block: "nearest" }); }, [message]);
  if ("unsupported" in mapped) return <p aria-disabled="true">this form needs the chat: unsupported field {mapped.unsupported}</p>;

  const focusField = (name?: string) => form.current?.querySelector<HTMLElement>(name ? `[name="${CSS.escape(name)}"]` : "[name]")?.focus();
  // Clears the selection and hands focus back to the row, whether triggered by the cancel button or Escape.
  // The row is often off screen (a long table below the form); focus() scrolls it into view.
  const cancel = () => {
    if (!row) return;
    const target = tableRow(opener, tool.collection, row.record_id);
    selectRow(pageId, null);
    target?.focus();
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled || busy) return;
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
        const field = fields.find((candidate) => candidate.name === name);
        if (body?.error && field) { setFieldErrors({ [name]: fieldError(field, body.error.expected) }); focusField(name); }
        else setMessage({ kind: "alert", text: body?.error ? `${path || "input"}: ${body.error.expected}` : body?.detail ?? `could not ${row ? "save" : "add"} (${response.status})` });
        return;
      }
      setTyped({});
      setMessage({ kind: "status", text: row ? "saved" : "added" });
      // the saved record (new revision) stays selected, so the next save does not conflict with itself; the effect above scrolls it into view
      if (row && body) { chosenRevision.current = body.revision; selectRow(pageId, { collection: tool.collection, record: body, opener }); }
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
      chosenRevision.current = current.revision;
      selectRow(pageId, { collection: tool.collection, record: current, opener });
      notifyRecordWrite(pageId);
      focusField();
    } catch (caught) {
      setMessage({ kind: "alert", text: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  return <>
    <form ref={form} noValidate onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === "Escape" && row && !event.defaultPrevented && !event.nativeEvent.isComposing) { event.preventDefault(); cancel(); } }}>
    {disabled && disabledReason && <p className="form-note" role="note">{disabledReason}</p>}
    {fields.map((field) => <Field key={field.name} id={`${idPrefix}-${field.name}`} field={field} value={disabled ? field.kind === "boolean" ? false : "" : values[field.name]} error={fieldErrors[field.name] ?? null} disabled={disabled} onChange={(value) => { setTyped((current) => ({ ...current, [field.name]: value })); setMessage((current) => current?.kind === "status" ? null : current); }} />)}
    <div className="record-form-actions">
      {/* a mouse save keeps focus where the user was (webkit never focuses a clicked button), and the button is not disabled
          while busy, since a disabled button drops focus; submit() ignores a second click */}
      <button type="submit" className="primary" disabled={disabled || busy} aria-disabled={busy || undefined} onMouseDown={(event) => event.preventDefault()}>{row ? (busy ? "saving…" : "save") : busy ? "adding…" : "add"}</button>
      {row && <button type="button" onClick={cancel}>cancel</button>}
      {message?.kind === "row-changed" && <button type="button" onClick={() => { setTyped({}); setMessage(null); focusField(); }}>discard</button>}
      {/* a changed record is news, not an error: the user's edits are safe */}
      {message && <p role={message.kind === "status" || message.kind === "row-changed" ? "status" : "alert"}>{message.text}</p>}
      {message?.kind === "row-conflict" && <button type="button" onClick={() => void reloadRow()}>reload row</button>}
      {message?.kind === "conflict" && <button type="button" onClick={() => { setMessage(null); onReloadTool(); focusField(); }}>reload tool</button>}
    </div>
    </form>
  </>;
}

function Field({ id, field, value, error, disabled = false, onChange }: { id: string; field: FormField; value: string | boolean; error: string | null; disabled?: boolean; onChange: (value: string | boolean) => void }) {
  const described = [field.description ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const common = { id, name: field.name, "aria-required": field.required, "aria-invalid": error ? true : undefined, "aria-describedby": described, disabled };
  const control = field.kind === "boolean" ? <input {...common} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
    : field.kind === "enum" ? <EnumListbox id={common.id} name={common.name} required={common["aria-required"]} value={String(value)} options={["", ...field.options.map((option) => JSON.stringify(option))]} onChange={onChange} label={`${field.name}${field.required ? " *" : ""}`} aria-describedby={described} invalid={Boolean(error)} disabled={disabled} />
    : field.kind === "string" ? <input {...common} placeholder={disabled ? "—" : undefined} type="text" value={String(value)} onChange={(event) => onChange(event.target.value)} />
    // a phone keypad without a minus key only when the schema rules out negatives
    : <input {...common} placeholder={disabled ? "—" : undefined} type="number" step={field.multipleOf ?? (field.kind === "integer" ? 1 : "any")} min={field.minimum} inputMode={field.minimum !== undefined && field.minimum >= 0 ? (field.kind === "integer" ? "numeric" : "decimal") : undefined} value={String(value)} onChange={(event) => onChange(event.target.value)} />;
  return <div className={`record-field${field.kind === "boolean" ? " record-field-check" : ""}`}>
    {field.kind !== "enum" && <label htmlFor={id}>{field.name}{field.required && <span className="required-mark" aria-hidden="true"> *</span>}</label>}
    {control}
    {field.description && <small id={`${id}-help`}>{field.description}</small>}
    {error && <p id={`${id}-error`} className="field-error">{error}</p>}
  </div>;
}
