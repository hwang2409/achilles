import { useEffect, useRef, useState, type RefObject } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { layoutSummary } from "./layoutSummary";
import { READ_ONLY_REASON, WRITE_SURFACE } from "../writeSurfaces";

type LayoutVersion = { version: number; created_at: string; block_types: string[]; summary: string | null; active: boolean; action: string | null; restored_from: number | null };
type ToolVersion = { name: string; version: number; created_at: string; active: boolean; restored_from: number | null };
type Versions = { layout: LayoutVersion[]; tools: ToolVersion[] };

const actions: Record<string, string> = { create_page: "created", update_layout: "edited", restore_layout: "restored" };
const when = (stamp: string) => new Date(stamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// the page's layout and tool versions; restore goes through the same guarded store paths as the agent's restore_version
// onChanged refreshes the page behind the dialog: after a restore, and after a 409 or 403 that means the page changed elsewhere
export function HistoryDialog({ pageId, credential, createMode, opener, onClose, onChanged, canWrite = false, disabledReason = READ_ONLY_REASON }: { pageId: string; credential: string; createMode: boolean; opener: RefObject<HTMLElement | null>; onClose(): void; onChanged(): void; canWrite?: boolean; disabledReason?: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loads, setLoads] = useState(0);
  // the one row waiting for "confirm"; restore asks once before it writes
  const [pending, setPending] = useState<string | null>(null);
  const refocus = useRef<string | null>(null);
  const auth = { Authorization: `Bearer ${credential}` };
  // a touch device has no Esc key, so the close control reads "close" there and keeps the "esc" hint on a keyboard
  const touchOnly = window.matchMedia("(any-pointer: coarse)").matches;
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
    if (!canWrite) return;
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
    ? <Badge variant="outline" className="justify-self-center">current</Badge>
    : <Button variant="outline" size="sm" type="button" data-write-surface={WRITE_SURFACE.historyRestore} disabled={busy || blocked || !canWrite} title={!canWrite ? disabledReason : undefined} aria-describedby={blocked ? "history-layout-hint" : undefined} onClick={() => setPending(key)}>restore</Button>;
  // the row in its confirm state; only "confirm" sends the restore
  const confirmRow = (key: string, version: number, kind: string, run: () => void) => <li key={version} data-row={key} className="flex flex-wrap items-center gap-2 border-t py-2 [&>span]:grow">
    <span id={`${key}-ask`}>restore version {version}? the current {kind} stays in history</span>
    <Button variant="outline" size="sm" type="button" data-write-surface={WRITE_SURFACE.historyRestore} disabled={!canWrite} title={!canWrite ? disabledReason : undefined} aria-describedby={`${key}-ask`} onClick={run}>confirm</Button>
    <Button variant="outline" size="sm" type="button" onClick={cancelPending}>cancel</Button>
  </li>;
  const versionRow = (key: string, row: { version: number; active: boolean; created_at: string }, detail: string, blocked = false) => <li key={row.version} data-row={key} className="grid min-h-11 grid-cols-[3em_minmax(0,1fr)_auto] items-center gap-x-3 border-t py-1 first:border-t-0 sm:grid-cols-[3.5em_minmax(0,1fr)_auto_6.5em] max-sm:[&>button]:col-start-3 max-sm:[&>button]:row-span-2 max-sm:[&>button]:row-start-1 max-sm:[&>time]:col-start-2 max-sm:[&>time]:row-start-2">
    <span className="font-semibold tabular-nums">v{row.version}</span>
    <span className="truncate text-muted-foreground">{detail}</span>
    <time className="text-xs text-muted-foreground tabular-nums" dateTime={row.created_at}>{when(row.created_at)}</time>
    {button(key, row, blocked)}
  </li>;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent ref={dialog} data-page-history="" showCloseButton={false} className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-none p-0 sm:max-w-[600px]"
      onCloseAutoFocus={(event) => { event.preventDefault(); opener.current?.focus(); }}
      onEscapeKeyDown={(event) => { if (pending) { event.preventDefault(); cancelPending(); } }}>
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-3 sm:px-6">
        <div><DialogTitle>history</DialogTitle><DialogDescription>restore adds a new version</DialogDescription></div>
        <Button variant="ghost" size="sm" type="button" onClick={onClose}>{touchOnly ? "close" : "esc"}</Button>
      </div>
      <div className="px-4 pb-4 text-sm sm:px-6">
        <p ref={noteRef} tabIndex={-1} className="my-3 text-muted-foreground empty:hidden focus:outline-none [&[role=alert]]:text-destructive" role={note?.error ? "alert" : "status"}>{note?.text ?? (versions ? "" : "loading history…")}</p>
        {!canWrite && <p className="mb-2 text-muted-foreground" role="note">{disabledReason ?? "this tab is read-only; take control to make changes"}</p>}
        {versions && <>
          <section className="border-b py-3 last:border-b-0 [&_h3]:mb-2 [&_h3]:font-semibold" aria-labelledby="history-layout">
            <h3 id="history-layout">layout</h3>
            {!createMode && versions.layout.length > 1 && <p id="history-layout-hint" className="mb-2 text-muted-foreground">turn on create mode to restore a layout.</p>}
            {versions.layout.length === 0 ? <p className="mb-2 text-muted-foreground">this page has no saved layout yet.</p>
              : <ol>{versions.layout.map((row) => {
                const key = `layout-${row.version}`;
                if (pending === key) return confirmRow(key, row.version, "layout", () => void restore("layout", `/api/pages/${pageId}/layout/restore`, row.version, activeLayout!));
                return versionRow(key, row, `${row.restored_from ? `restored from v${row.restored_from} · ` : row.action ? `${actions[row.action] ?? row.action} · ` : ""}${layoutSummary(row.block_types.length, row.summary)}`, !createMode);
              })}</ol>}
          </section>
          {toolNames.map((name) => {
            const rows = versions.tools.filter((row) => row.name === name);
            const active = rows.find((row) => row.active)?.version;
            return <section key={name} className="border-b py-3 last:border-b-0 [&_h3]:mb-2 [&_h3]:font-semibold" aria-label={`tool ${name}`}>
              <h3>tool <code>{name}</code></h3>
              <ol>{rows.map((row) => {
                const key = `tool-${name}-${row.version}`;
                if (pending === key) return confirmRow(key, row.version, "version", () => void restore(name, `/api/pages/${pageId}/tools/${encodeURIComponent(name)}/rollback`, row.version, active!));
                return versionRow(key, row, row.restored_from ? `restored from v${row.restored_from}` : "");
              })}</ol>
            </section>;
          })}
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}
