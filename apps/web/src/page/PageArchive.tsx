import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { NavIcon } from "../surface/SurfaceNav";
import { useInlineRename } from "../useInlineRename";
import "./page-archive.css";

export type PageChange = { title?: string; archived?: boolean };
export type ChangedPage = { id: string; route: string; title: string; archived_at: string | null };

// PATCH /api/pages/{id}: the one write for rename, archive and restore. the server's refusal text is the error.
export async function patchPage(id: string, change: PageChange): Promise<ChangedPage> {
  const response = await fetch(`/api/pages/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
  if (!response.ok) throw new Error((await response.text()) || `the page did not change (${response.status})`);
  return await response.json() as ChangedPage;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Rename and archive one page: a click-to-edit title plus the writes. A blank or unchanged title is not sent. */
export function usePageEdit(page: { id: string; title: string }, onChanged: (page: ChangedPage) => void) {
  const rename = useInlineRename();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = async (change: PageChange) => {
    setPending(true); setError(null);
    try { onChanged(await patchPage(page.id, change)); } catch (caught) { setError(message(caught)); } finally { setPending(false); }
  };
  // the control that started the rename gets focus back when the editor closes (enter, esc, or blur)
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (rename.editing || !opener.current) return;
    if (opener.current.isConnected && document.activeElement === document.body) opener.current.focus();
    opener.current = null;
  }, [rename.editing]);
  const startRename = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rename.start(page.title, (value) => {
      const title = value.trim();
      if (title && title !== page.title) void run({ title });
    });
  };
  const input = (label: string) => <input className="page-title-edit" aria-label={label} maxLength={200} {...rename.bind()} />;
  return { editing: rename.editing, input, startRename, archive: () => run({ archived: true }), restore: () => run({ archived: false }), error, pending };
}

/** The page header crumb: the page title opens "rename page" and "archive page". home has no menu: it cannot be archived. */
export function PageCrumbMenu({ page, onChanged }: { page: { id: string; title: string }; onChanged: (page: ChangedPage) => void }) {
  const edit = usePageEdit(page, onChanged);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("button")?.focus();
    const outside = (event: Event) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [open]);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const items = [...menu.current?.querySelectorAll<HTMLElement>("button") ?? []];
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };
  const choose = (action: () => void) => { setOpen(false); action(); };
  // enter or esc unmounts the editor and drops focus to <body>: hand it back to the title
  const wasEditing = useRef(false);
  useEffect(() => {
    if (edit.editing) { wasEditing.current = true; return; }
    if (wasEditing.current && document.activeElement === document.body) trigger.current?.focus();
    wasEditing.current = false;
  }, [edit.editing]);
  if (edit.editing) return edit.input("page title");
  return <span className="page-crumb-menu" onKeyDown={keys}>
    <button ref={trigger} type="button" className="page-crumb-button" title={page.title} aria-haspopup="true" aria-expanded={open} aria-controls={open ? "page-actions" : undefined} aria-busy={edit.pending || undefined} onClick={() => setOpen((value) => !value)}>{page.title}<NavIcon d="M4 6l4 4 4-4" /></button>
    {open && <div className="page-actions" id="page-actions" ref={menu} role="group" aria-label={`${page.title} actions`}>
      <button type="button" onClick={() => choose(edit.startRename)}>rename page</button>
      <button type="button" onClick={() => choose(() => void edit.archive())}>archive page</button>
    </div>}
    {edit.error && <span className="page-edit-error" role="alert">{edit.error}</span>}
  </span>;
}

/** Shown on an archived page's route: the page still works, and one click restores it to Pages and the palette. */
export function ArchivedBar({ page, onChanged }: { page: { id: string; title: string }; onChanged: (page: ChangedPage) => void }) {
  const edit = usePageEdit(page, onChanged);
  return <div className="page-archived-bar" role="status">
    <span>archived</span><span aria-hidden="true">·</span>
    <button type="button" className="link-button" aria-label={`restore ${page.title}`} aria-busy={edit.pending || undefined} onClick={() => { if (!edit.pending) void edit.restore(); }}>restore</button>
    <span className="page-archived-note">hidden from Pages and search; its records and versions are kept</span>
    {edit.error && <span className="page-edit-error" role="alert">{edit.error}</span>}
  </div>;
}
