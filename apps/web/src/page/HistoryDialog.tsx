import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { wrapTab } from "../keyboard";
import "../settings-dialog.css";

type LayoutVersion = { version: number; created_at: string; block_types: string[]; active: boolean; action: string | null };
type ToolVersion = { name: string; version: number; created_at: string; active: boolean };
type Versions = { layout: LayoutVersion[]; tools: ToolVersion[] };

const actions: Record<string, string> = { create_page: "created", update_layout: "edited", restore_layout: "restored" };
const when = (stamp: string) => new Date(stamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// the page's layout and tool versions; restore goes through the same guarded store paths as the agent's restore_version
export function HistoryDialog({ pageId, credential, createMode, onClose, onRestored }: { pageId: string; credential: string; createMode: boolean; onClose(): void; onRestored(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loads, setLoads] = useState(0);
  const auth = { Authorization: `Bearer ${credential}` };
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close(); // a still-open modal makes the rest of the page inert, so focus() below would do nothing
      // back to the header control that opened it: the visible "history" button, or ••• when it is folded into the menu
      // (the menu item is gone by then, and webkit does not focus a clicked button, so the focused element says nothing)
      [...document.querySelectorAll<HTMLElement>(".chat-actions > button")].find((button) => button.offsetParent !== null && (button.textContent === "history" || button.classList.contains("header-overflow")))?.focus();
    };
  }, []);
  useEffect(() => {
    let current = true;
    void fetch(`/api/pages/${pageId}/versions`, { headers: auth, cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(`could not load history (${response.status})`); return response.json() as Promise<Versions>; })
      .then((body) => { if (current) setVersions(body); })
      .catch((caught) => { if (current) setNote({ text: caught instanceof Error ? caught.message : String(caught), error: true }); });
    return () => { current = false; };
  }, [pageId, credential, loads]);

  const restore = async (label: string, url: string, version: number, expected: number) => {
    setBusy(true);
    try {
      const response = await fetch(url, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ version, expected_version: expected }) });
      if (response.ok) { setNote({ text: `restored ${label} v${version}`, error: false }); onRestored(); }
      else if (response.status === 409) setNote({ text: `${label} changed since this list loaded. the list is updated; try again.`, error: true });
      else {
        const body = await response.json().catch(() => ({})) as { detail?: string; error?: { message?: string } };
        setNote({ text: body.detail ?? body.error?.message ?? `could not restore (${response.status})`, error: true });
      }
    } catch { setNote({ text: "could not restore: achilles is not reachable", error: true }); }
    finally { setBusy(false); setLoads((value) => value + 1); }
  };

  const activeLayout = versions?.layout.find((row) => row.active)?.version;
  const toolNames = [...new Set(versions?.tools.map((row) => row.name))];
  const button = (row: { active: boolean }, run: () => void, blocked = false) => row.active
    ? <span className="history-current">current</span>
    : <button type="button" disabled={busy || blocked} onClick={run}>restore</button>;
  return <dialog
    ref={dialog}
    className="settings-dialog history-dialog"
    aria-labelledby="history-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    onKeyDown={(event) => wrapTab(event, event.currentTarget)}
  >
    <div className="settings-panel">
      <div className="settings-titlebar"><div><span className="settings-mark" /><h2 id="history-title">history</h2></div><div><span>restore adds a new version</span><button type="button" onClick={onClose}>esc</button></div></div>
      <div className="settings-content">
        <p className={note?.error ? "history-note history-error" : "history-note"} role={note?.error ? "alert" : "status"}>{note?.text ?? (versions ? "" : "loading history…")}</p>
        {versions && <>
          <section className="history-group" aria-labelledby="history-layout">
            <h3 id="history-layout">layout</h3>
            {!createMode && versions.layout.length > 1 && <p className="history-hint">turn on create mode to restore a layout.</p>}
            {versions.layout.length === 0 ? <p className="history-hint">this page has no saved layout yet.</p>
              : <ol>{versions.layout.map((row) => <li key={row.version}>
                <span className="history-version">v{row.version}</span>
                <span className="history-detail">{row.action ? `${actions[row.action] ?? row.action} · ` : ""}{row.block_types.join(", ") || "no blocks"}</span>
                <time dateTime={row.created_at}>{when(row.created_at)}</time>
                {button(row, () => void restore("layout", `/api/pages/${pageId}/layout/restore`, row.version, activeLayout!), !createMode)}
              </li>)}</ol>}
          </section>
          {toolNames.map((name) => {
            const rows = versions.tools.filter((row) => row.name === name);
            const active = rows.find((row) => row.active)?.version;
            return <section key={name} className="history-group" aria-label={`tool ${name}`}>
              <h3>tool <code>{name}</code></h3>
              <ol>{rows.map((row) => <li key={row.version}>
                <span className="history-version">v{row.version}</span>
                <span className="history-detail" />
                <time dateTime={row.created_at}>{when(row.created_at)}</time>
                {button(row, () => void restore(name, `/api/pages/${pageId}/tools/${encodeURIComponent(name)}/rollback`, row.version, active!))}
              </li>)}</ol>
            </section>;
          })}
        </>}
      </div>
    </div>
  </dialog>;
}
