import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { wrapTab } from "../keyboard";
import "../settings-dialog.css";

type LayoutVersion = { version: number; created_at: string; block_types: string[]; active: boolean; action: string | null; restored_from: number | null };
type ToolVersion = { name: string; version: number; created_at: string; active: boolean; restored_from: number | null };
type Versions = { layout: LayoutVersion[]; tools: ToolVersion[] };

const actions: Record<string, string> = { create_page: "created", update_layout: "edited", restore_layout: "restored" };
const when = (stamp: string) => new Date(stamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// the page's layout and tool versions; restore goes through the same guarded store paths as the agent's restore_version
// onChanged refreshes the page behind the dialog: after a restore, and after a 409 or 403 that means the page changed elsewhere
export function HistoryDialog({ pageId, credential, createMode, opener, onClose, onChanged }: { pageId: string; credential: string; createMode: boolean; opener: RefObject<HTMLElement | null>; onClose(): void; onChanged(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loads, setLoads] = useState(0);
  // the one row waiting for "confirm"; restore asks once before it writes
  const [pending, setPending] = useState<string | null>(null);
  const refocus = useRef<string | null>(null);
  const auth = { Authorization: `Bearer ${credential}` };
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close(); // a still-open modal makes the rest of the page inert, so focus() below would do nothing
      opener.current?.focus();
    };
  }, []);
  useEffect(() => {
    // focus the row's confirm button when it opens, and its restore button again when it closes
    const key = pending ?? refocus.current;
    refocus.current = null;
    if (key) dialog.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"] button`)?.focus();
  }, [pending]);
  const cancelPending = () => { refocus.current = pending; setPending(null); };
  useEffect(() => {
    let current = true;
    void fetch(`/api/pages/${pageId}/versions`, { headers: auth, cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(`could not load history (${response.status})`); return response.json() as Promise<Versions>; })
      .then((body) => { if (current) setVersions(body); })
      .catch((caught) => { if (current) setNote({ text: caught instanceof Error ? caught.message : String(caught), error: true }); });
    return () => { current = false; };
  }, [pageId, credential, loads]);

  const restore = async (label: string, url: string, version: number, expected: number) => {
    setPending(null);
    setBusy(true);
    try {
      const response = await fetch(url, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ version, expected_version: expected }) });
      if (response.ok) { const body = await response.json() as { version: number }; setNote({ text: `restored ${label} v${version} as v${body.version}`, error: false }); onChanged(); }
      else if (response.status === 409) { setNote({ text: `${label} changed since this list loaded. the list is updated; try again.`, error: true }); onChanged(); }
      else {
        const body = await response.json().catch(() => ({})) as { error?: { hint?: string } };
        setNote({ text: body.error?.hint ?? `could not restore (${response.status})`, error: true });
        // a 403 means create mode went off in another tab; the refreshed page disables the layout restores
        if (response.status === 403) onChanged();
      }
    } catch { setNote({ text: "could not restore: achilles is not reachable", error: true }); }
    finally {
      setBusy(false);
      setLoads((value) => value + 1);
      // the confirm row is gone, so focus would drop to the body; the note says what happened, at the top of a long list
      noteRef.current?.focus();
      noteRef.current?.scrollIntoView({ block: "nearest" });
    }
  };

  const activeLayout = versions?.layout.find((row) => row.active)?.version;
  const toolNames = [...new Set(versions?.tools.map((row) => row.name))];
  const button = (key: string, row: { active: boolean }, blocked = false) => row.active
    ? <span className="history-current">current</span>
    : <button type="button" disabled={busy || blocked} aria-describedby={blocked ? "history-layout-hint" : undefined} onClick={() => setPending(key)}>restore</button>;
  // the row in its confirm state; only "confirm" sends the restore
  const confirmRow = (key: string, version: number, kind: string, run: () => void) => <li key={version} data-row={key} className="history-confirm">
    <span id={`${key}-ask`}>restore version {version}? the current {kind} stays in history</span>
    <button type="button" aria-describedby={`${key}-ask`} onClick={run}>confirm</button>
    <button type="button" onClick={cancelPending}>cancel</button>
  </li>;
  return <dialog
    ref={dialog}
    className="settings-dialog history-dialog"
    aria-labelledby="history-title"
    onCancel={(event) => { event.preventDefault(); if (pending) cancelPending(); else onClose(); }}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    onKeyDown={(event) => wrapTab(event, event.currentTarget)}
  >
    <div className="settings-panel">
      <div className="settings-titlebar"><div><span className="settings-mark" /><h2 id="history-title">history</h2></div><div><span>restore adds a new version</span><button type="button" onClick={onClose}>esc</button></div></div>
      <div className="settings-content">
        <p ref={noteRef} tabIndex={-1} className={note?.error ? "history-note history-error" : "history-note"} role={note?.error ? "alert" : "status"}>{note?.text ?? (versions ? "" : "loading history…")}</p>
        {versions && <>
          <section className="history-group" aria-labelledby="history-layout">
            <h3 id="history-layout">layout</h3>
            {!createMode && versions.layout.length > 1 && <p id="history-layout-hint" className="history-hint">turn on create mode to restore a layout.</p>}
            {versions.layout.length === 0 ? <p className="history-hint">this page has no saved layout yet.</p>
              : <ol>{versions.layout.map((row) => {
                const key = `layout-${row.version}`;
                if (pending === key) return confirmRow(key, row.version, "layout", () => void restore("layout", `/api/pages/${pageId}/layout/restore`, row.version, activeLayout!));
                return <li key={row.version} data-row={key}>
                  <span className="history-version">v{row.version}</span>
                  <span className="history-detail">{row.restored_from ? `restored from v${row.restored_from} · ` : row.action ? `${actions[row.action] ?? row.action} · ` : ""}{row.block_types.join(", ") || "no blocks"}</span>
                  <time dateTime={row.created_at}>{when(row.created_at)}</time>
                  {button(key, row, !createMode)}
                </li>;
              })}</ol>}
          </section>
          {toolNames.map((name) => {
            const rows = versions.tools.filter((row) => row.name === name);
            const active = rows.find((row) => row.active)?.version;
            return <section key={name} className="history-group" aria-label={`tool ${name}`}>
              <h3>tool <code>{name}</code></h3>
              <ol>{rows.map((row) => {
                const key = `tool-${name}-${row.version}`;
                if (pending === key) return confirmRow(key, row.version, "version", () => void restore(name, `/api/pages/${pageId}/tools/${encodeURIComponent(name)}/rollback`, row.version, active!));
                return <li key={row.version} data-row={key}>
                  <span className="history-version">v{row.version}</span>
                  <span className="history-detail">{row.restored_from ? `restored from v${row.restored_from}` : ""}</span>
                  <time dateTime={row.created_at}>{when(row.created_at)}</time>
                  {button(key, row)}
                </li>;
              })}</ol>
            </section>;
          })}
        </>}
      </div>
    </div>
  </dialog>;
}
