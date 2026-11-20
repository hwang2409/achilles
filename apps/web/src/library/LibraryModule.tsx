import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { chatsRoute, surfaceHref, surfaceRoutes } from "../surface/routes";
import { appendPage, libraryMethods, projectBody, projectCatalog, projectCatalogPage, sourceTiers, type Body, type CatalogPage, type CatalogRow, type LibraryKind } from "./catalog";
import { LibraryEdit, LibraryEditor, uneditable, type CreateDraft, type EditDraft } from "./LibraryEditor";
import { createLibraryWriter, REDACTED_NOTICE, REFUSED_NOTICE, savedNotice } from "./libraryWrites";
import "./library.css";

const tabs = surfaceRoutes.filter(({ id }) => id === "skills" || id === "agent-profiles");
const tierRules = {
  project: "wins over home",
  home: "wins over packaged",
  packaged: "read-only",
};
const narrow = "(max-width: 760px), (max-height: 500px)";
const yesNo = (value: boolean) => value ? "yes" : "no";
const PAGE = { scope: "effective", limit: 100 } as const;

type Skipped = Extract<CatalogPage, { state: "data" }>["skipped"];
type DataView = { state: "data"; rows: CatalogRow[]; nextOffset: number | null; skipped: Skipped | null };
// `skipped` on empty: a page whose every file was skipped or shadowed still lists them.
type View = { state: "empty"; skipped?: Skipped } | { state: "no-session" } | { state: "invalid" } | DataView | { state: "failed"; problem: Problem };
// `gone`: zeta's resource_not_found reason, so "refresh list" never depends on the message copy.
type Problem = { message: string; retry: boolean; gone?: boolean };
type More = "idle" | "loading" | Problem;
type Reveal = { state: "loading" } | { state: "data"; body: Body } | { state: "failed"; problem: Problem };
/** Which library_read_v1 methods this zeta advertised; both false means the older status snapshot. */
export type LibraryReads = { catalog: boolean; read: boolean };
/** Present only when this zeta grants library_write_v1. `allowed: false`: this tab controls zeta, but zeta did not list
 * this kind's write method. `feedback`: the last take-control refusal, held by the router so it survives a remount. */
export type LibraryWrite = {
  controller: boolean; allowed: boolean; takeControl: () => Promise<string | null>; feedback: string | null;
  /** In-memory drafts held by the router, keyed `<kind>/new`, so a remount after a socket drop restores the form. */
  drafts: Map<string, CreateDraft>;
  /** The open edit per kind, held by the router for the same reason. */
  edits: Map<LibraryKind, EditDraft>;
  /** The connection's current client (null while reconnecting), for reads after a socket drop. */
  liveClient: () => ZetaClient | null;
  /** Gives back the controller slot taken for an editor, once that editor closes. */
  releaseControl: () => void;
};

const rowKey = (row: CatalogRow) => `${row.scope}/${row.name}`;
const unreadable: Problem = { message: "zeta sent data this view cannot read", retry: true };
function problemOf(error: unknown): Problem {
  const rpc = error as { code?: unknown; data?: { reason?: unknown } } | null;
  if (rpc?.code === -32005) return { message: "not available without an open project", retry: false };
  if (rpc?.code === -32602 && rpc.data?.reason === "resource_not_found") return { message: "no longer exists", retry: false, gone: true };
  if (rpc?.code === -32007) return { message: "too large to show", retry: false };
  return { message: "zeta could not read it", retry: true };
}

export function LibraryModule({ client, kind, reads, write = null }: { client: ZetaClient; kind: LibraryKind; reads: LibraryReads; write?: LibraryWrite | null }) {
  const title = kind === "skills" ? "skills" : "agent profiles";
  const noun = kind === "skills" ? "skill" : "profile";
  const methods = libraryMethods(kind);
  const [catalog, setCatalog] = useState<View | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<More>("idle");
  const attemptRef = useRef(0);
  const focusNew = useRef<Set<string> | null>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const keyboardPick = useRef(false);
  const lastRow = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const returnToList = useRef(false);
  const focusCreated = useRef(false);
  const [writer] = useState(() => createLibraryWriter(undefined, write?.liveClient));
  const draftKey = `${kind}/new`;
  const [creating, setCreating] = useState(() => Boolean(write?.drafts.has(draftKey)));
  const [taking, setTaking] = useState(false);
  const controlFeedback = write?.feedback ?? null;
  // The last save, named; it clears when another item is selected or it is dismissed.
  const [saved, setSaved] = useState<{ name: string; redacted: boolean; where?: string } | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const focusNewButton = useRef(false);
  const [editing, setEditing] = useState<EditDraft | null>(() => write?.edits.get(kind) ?? null);
  const wasEditing = useRef(false);
  // Changes whenever an editor opens or closes.
  const form = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      let view: View;
      try {
        if (reads.catalog) {
          const page = projectCatalogPage(await client.request(methods.catalog, PAGE, { signal: abort.signal }), kind);
          view = page.state === "invalid" ? { state: "failed", problem: unreadable }
            : page.rows.length ? { state: "data", rows: appendPage([], page.rows), nextOffset: page.nextOffset, skipped: page.skipped } : { state: "empty", skipped: page.skipped };
        } else {
          const snapshot = projectCatalog(await client.request("status", {}, { signal: abort.signal }), kind);
          view = snapshot.state === "data" ? { ...snapshot, nextOffset: null, skipped: null } : snapshot;
        }
      } catch (error) {
        view = reads.catalog ? { state: "failed", problem: problemOf(error) } : { state: "invalid" };
      }
      if (!abort.signal.aborted) {
        setCatalog(view);
        setMore("idle");
      }
    })();
    return () => abort.abort();
  }, [client, kind, attempt, reads.catalog, methods.catalog]);

  const rows = catalog?.state === "data" ? catalog.rows : [];
  const selected = rows.find(({ name }) => name === selection);
  useEffect(() => {
    // narrow layouts swap to the detail; on desktop only a keyboard pick moves focus there (a mouse click keeps it).
    if (selected && (keyboardPick.current || focusCreated.current || matchMedia(narrow).matches)) detailHeading.current?.focus();
    keyboardPick.current = false;
    if (selected) focusCreated.current = false;
    if (!selected && returnToList.current) {
      returnToList.current = false;
      (lastRow.current?.isConnected ? lastRow.current : search.current)?.focus();
    }
  }, [selected]);

  // discarding a new item returns focus to "+ new".
  useEffect(() => {
    if (creating || !focusNewButton.current) return;
    focusNewButton.current = false;
    newButton.current?.focus();
  }, [creating]);

  // leaving the editor returns focus to the item's detail.
  useEffect(() => {
    if (!editing && wasEditing.current) {
      focusCreated.current = true;
      detailHeading.current?.focus();
    }
    wasEditing.current = Boolean(editing);
  }, [editing]);

  function refresh() {
    if (!catalog) return;
    setCatalog(null);
    attemptRef.current++;
    setAttempt((n) => n + 1);
  }

  async function loadMore() {
    if (catalog?.state !== "data" || catalog.nextOffset === null || more === "loading") return;
    const started = attemptRef.current;
    setMore("loading");
    let next: More = "idle";
    try {
      const page = projectCatalogPage(await client.request(methods.catalog, { ...PAGE, offset: catalog.nextOffset }), kind);
      if (page.state === "invalid") next = unreadable;
      else if (started === attemptRef.current) {
        focusNew.current = new Set(page.rows.map(({ name }) => name).filter((name) => !rows.some((row) => row.name === name)));
        setCatalog((view) => view?.state === "data" ? { state: "data", rows: appendPage(view.rows, page.rows), nextOffset: page.nextOffset, skipped: page.skipped } : view);
      }
    } catch (error) {
      next = problemOf(error);
    }
    if (started === attemptRef.current) setMore(next);
  }

  function pick(row: CatalogRow, button: HTMLButtonElement, keyboard: boolean) {
    lastRow.current = button;
    if (keyboard && row === selected) {
      detailHeading.current?.focus();
      return;
    }
    keyboardPick.current = keyboard;
    setSelection(row.name);
    if (saved && saved.name !== row.name) setSaved(null);
  }

  // Library tabs stay observers; pressing new or edit takes the controller slot only if it is free.
  function withControl(then: () => void) {
    if (!write || taking || !write.allowed) return;
    setSaved(null);
    if (write.controller) return then();
    setTaking(true);
    void write.takeControl().then((reason) => {
      setTaking(false);
      if (!reason) then();
    });
  }

  function openCreate() {
    form.current++;
    setCreating(true);
  }

  function closeEditor() {
    form.current++;
    write?.drafts.delete(draftKey);
    setCreating(false);
    write?.releaseControl();
  }

  function startEdit(row: CatalogRow, opened: EditDraft["base"]) {
    if (row.scope === "effective") return;
    const draft = { target: { kind, name: row.name, scope: row.scope }, base: opened, text: opened.document, mine: null };
    withControl(() => {
      form.current++;
      write?.edits.set(kind, draft);
      setEditing(draft);
    });
  }

  function closeEdit() {
    form.current++;
    write?.edits.delete(kind);
    setEditing(null);
    write?.releaseControl();
  }

  function showCreated(name: string) {
    closeEditor();
    focusCreated.current = true;
    setSelection(name);
    refresh();
  }

  function backToList() {
    returnToList.current = true;
    setSelection(null);
  }

  // A save reply can land after its form was discarded (a sent write cannot be recalled). It may close or clear only
  // the form that sent it; for any other it only shows the notice and refreshes the list.
  const sender = form.current;
  const lateSave = (name: string, redacted: boolean, where?: string) => {
    if (sender === form.current) return false;
    setSaved({ name, redacted, where });
    refresh();
    return true;
  };

  let content: ReactNode;
  if (!catalog) content = <ModuleState kind="loading" title={reads.catalog ? "reading catalog…" : "reading session snapshot…"} />;
  else if (catalog.state === "failed") content = <ModuleState kind="failed" title={`could not read ${title}: ${catalog.problem.message}`}
    action={catalog.problem.retry ? { label: "retry", run: refresh } : undefined} />;
  else if (catalog.state === "invalid") content = <ModuleState kind="failed" title="could not read the catalog" detail="refresh to try the active session snapshot again." />;
  else if (catalog.state === "empty") content = reads.catalog
    ? <div className="library-empty">
      <ModuleState kind="empty" title={`no ${title} found`} detail="zeta reported no entries in the effective scope." />
      {catalog.skipped && <SkippedFiles skipped={catalog.skipped} />}
    </div>
    : <ModuleState kind="empty" title={`no ${title} in this snapshot`} detail="the active session did not report any entries for this catalog." />;
  else if (catalog.state === "no-session") content = <div className="library-unavailable">
    <ModuleState kind="unsupported" title="no active session" detail="this zeta only reports library catalogs for an active session." />
    <a href={surfaceHref(chatsRoute.path)}>open a chat</a>
  </div>;
  else content = <div className="library-layout" data-detail={Boolean(selected)}>
    <LibraryList view={catalog} kind={kind} title={title} live={reads.catalog} selected={selected} query={query} onQuery={setQuery}
      more={more} onLoadMore={() => void loadMore()} onPick={pick} search={search} focusNew={focusNew} />
    <section className="library-detail" aria-label="catalog detail" onKeyDown={(event) => {
      // Escape returns to the list: the selected row on desktop, the list view on narrow layouts.
      if (event.key !== "Escape" || event.defaultPrevented || !selected) return;
      event.preventDefault();
      if (matchMedia(narrow).matches) backToList();
      else (lastRow.current?.isConnected ? lastRow.current : search.current)?.focus();
    }}>
      {selected ? <>
        <button type="button" className="library-back" onClick={backToList}>‹ back to {title}</button>
        <h2 ref={detailHeading} tabIndex={-1}>{selected.name}</h2>
        <p className="library-description">{selected.description}</p>
        <dl className="library-fields">
          <Field label="source">{selected.source}{!selected.editable && " · read-only"}</Field>
          <Metadata row={selected} />
          {selected.diagnostics?.items.length ? <Field label="warnings"><ul className="library-diagnostics">
            {selected.diagnostics.items.map((message, i) => <li key={i}>{message}</li>)}
            {selected.diagnostics.more > 0 && <li>{selected.diagnostics.more} more</li>}
          </ul></Field> : null}
        </dl>
        {reads.catalog && reads.read ? <LibraryText key={rowKey(selected)} client={client} method={methods.read} row={selected} noun={noun}
          edit={write && { allowed: write.allowed, taking, feedback: controlFeedback, start: (opened) => startEdit(selected, opened) }}
          onGone={() => {
            focusNew.current = new Set();
            setSelection(null);
            refresh();
          }} />
        : <aside className="library-notice">
          <strong>metadata only</strong>
          <p>reading {noun} text requires a newer zeta.</p>
          {!selected.diagnostics && <p>diagnostics unavailable on this zeta.</p>}
        </aside>}
      </> : <p className="library-description">select {kind === "skills" ? "a skill" : "an agent profile"} to see its metadata.</p>}
    </section>
  </div>;
  return <ModuleFrame title={`library / ${title}`}>
    <div className="library">
      <div className="library-bar">
        <nav aria-label="library catalogs">
          {tabs.map((tab) => <a key={tab.id} href={surfaceHref(tab.path)} aria-current={tab.id === kind ? "page" : undefined}>{tab.label}</a>)}
        </nav>
        <div className="library-snapshot">
          <span data-live={reads.catalog || undefined}>{reads.catalog ? "live catalog · effective scope" : "active session snapshot · may be stale"}</span>
          <button type="button" aria-disabled={!catalog} onClick={refresh}>refresh</button>
          {write && !creating && <button type="button" className="library-new" data-write-surface="library.create" aria-disabled={taking || !write.allowed}
            ref={newButton}
            aria-describedby={controlFeedback || !write.allowed ? "library-control-feedback" : undefined} onClick={() => withControl(openCreate)}>{taking ? "taking control…" : `+ new ${noun}`}</button>}
        </div>
        {(controlFeedback || (write && !write.allowed && !creating)) && <p id="library-control-feedback" role="status" className="library-control">{controlFeedback ?? REFUSED_NOTICE}</p>}
      </div>
      {saved && <div role="status" className="library-saved">
        <p>{savedNotice(saved.name, saved.where)}</p>
        {saved.redacted && <p className="library-flag">{REDACTED_NOTICE}</p>}
        <button type="button" aria-label={`dismiss the notice for ${saved.name}`} onClick={() => setSaved(null)}>dismiss</button>
      </div>}
      {creating && write ? <LibraryEditor client={client} kind={kind} writer={writer} rows={rows}
        draft={write.drafts.get(draftKey)} onDraft={(draft) => write.drafts.set(draftKey, draft)} catalogMethod={reads.catalog ? methods.catalog : null}
        controller={write.controller} takeControl={write.takeControl} feedback={write.feedback} blocked={write.allowed ? null : REFUSED_NOTICE} onOpen={showCreated}
        onClose={() => { focusNewButton.current = true; closeEditor(); }}
        onCreated={(name, redacted, where) => {
          if (lateSave(name, redacted, where)) return;
          setSaved({ name, redacted, where });
          showCreated(name);
        }} />
      : editing && write ? <LibraryEdit key={`${editing.target.scope}/${editing.target.name}`} client={client} writer={writer} draft={editing}
        onDraft={(draft) => write.edits.set(kind, draft)} controller={write.controller} takeControl={write.takeControl} feedback={write.feedback}
        blocked={write.allowed ? null : REFUSED_NOTICE} onClose={closeEdit}
        onSaved={(redacted) => {
          if (lateSave(editing.target.name, redacted)) return;
          // a redacted file has no editable copy any more: leave the editor and say why; the masked read view stays.
          if (redacted) {
            setSaved({ name: editing.target.name, redacted });
            closeEdit();
          }
          refresh();
        }} />
      : content}
    </div>
  </ModuleFrame>;
}

type ListProps = {
  view: DataView; kind: LibraryKind; title: string; live: boolean; selected: CatalogRow | undefined;
  query: string; onQuery: (query: string) => void; more: More; onLoadMore: () => void;
  onPick: (row: CatalogRow, button: HTMLButtonElement, keyboard: boolean) => void;
  search: RefObject<HTMLInputElement | null>; focusNew: RefObject<Set<string> | null>;
};

/** The catalog list: filter, source groups, load more and the skipped files. Selection and detail stay with the module. */
function LibraryList({ view, kind, title, live, selected, query, onQuery, more, onLoadMore, onPick, search, focusNew }: ListProps) {
  const list = useRef<HTMLElement>(null);
  // After "load more" or "refresh list", keyboard focus moves to the first new row below the old ones,
  // else the first new row shown (it landed in an earlier group), else the filter.
  useEffect(() => {
    const added = focusNew.current;
    if (!added) return;
    focusNew.current = null;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-row]") ?? [])];
    const isNew = (button: HTMLButtonElement) => added.has(button.dataset.row ?? "");
    let lastOld = -1;
    buttons.forEach((button, i) => { if (!isNew(button)) lastOld = i; });
    (buttons.find((button, i) => i > lastOld && isNew(button)) ?? buttons.find(isNew) ?? search.current)?.focus();
  }, [view, focusNew, search]);

  const { rows } = view;
  const partial = view.nextOffset !== null;
  const term = query.trim().toLowerCase();
  const matches = rows.filter((row) => [row.name, row.description, ...("keywords" in row ? row.keywords : [])]
    .some((text) => text.toLowerCase().includes(term)));
  return <section ref={list} className="library-list" aria-label={`${title} catalog`}>
    <div className="library-filter">
      <input ref={search} type="search" aria-label={`filter ${title}`} placeholder={kind === "skills" ? "filter by name or keyword" : "filter by name or description"}
        value={query} onChange={(event) => onQuery(event.target.value)} />
      <span role="status">{term ? `${matches.length} of ${rows.length}` : matches.length} {partial ? "loaded" : term ? "" : "found"}</span>
    </div>
    {live && !rows.some(({ source }) => source === "project") &&
      <p className="library-hint">no project {kind === "skills" ? "skills" : "profiles"} found · zeta loads them from .zeta/{kind === "skills" ? "skills" : "agents"} in the open chat's project</p>}
    {matches.length === 0 && <p className="library-no-matches">{partial ? "no matches in the loaded rows. load more to search the rest." : "no matches. try a different search."}</p>}
    {sourceTiers.map((source) => {
      const group = matches.filter((row) => row.source === source);
      return group.length > 0 && <section className="library-group" key={source} aria-labelledby={`library-${source}`}>
        <h2 id={`library-${source}`}>{source} <small>{tierRules[source]} · {group.length}{partial && " loaded"}{problemCount(group)}</small></h2>
        <ul>
          {group.map((row) => <li key={row.name}>
            {/* detail 0: activated by Enter or Space, not a pointer. */}
            <button type="button" data-row={row.name} aria-current={row === selected || undefined} onClick={(event) => onPick(row, event.currentTarget, event.detail === 0)}>
              <strong>{row.name}</strong>
              {!row.editable && <small>read-only</small>}
              <span>{row.description}</span>
              {row.diagnostics?.items.length ? <span className="library-warning">warning · {row.diagnostics.items[0]}</span> : null}
            </button>
          </li>)}
        </ul>
      </section>;
    })}
    {view.nextOffset !== null && <div className="library-more">
      <button type="button" aria-disabled={more === "loading"} onClick={onLoadMore}>{more === "loading" ? "loading more…" : "load more"}</button>
      {typeof more === "object" && <span role="alert">could not load more: {more.message}</span>}
    </div>}
    {view.skipped && <SkippedFiles skipped={view.skipped} />}
  </section>;
}

function SkippedFiles({ skipped }: { skipped: Skipped }) {
  const total = skipped.items.length + skipped.more;
  return skipped.items.length > 0 && <details className="library-skipped">
    <summary>{total} {total === 1 ? "file" : "files"} skipped or shadowed</summary>
    <ul>
      {skipped.items.map(({ source, file, reason }, i) => <li key={i}><span>{source} · {file}</span> {reason}</li>)}
      {skipped.more > 0 && <li>{skipped.more} more</li>}
    </ul>
  </details>;
}

/**
 * The selected row's untrusted text. Rendered with `key={rowKey(row)}`, so a new selection is a new instance:
 * a late read for the old row lands on an unmounted instance and never shows. Unmounting also aborts the request.
 */
type EditControl = { allowed: boolean; taking: boolean; feedback: string | null; start: (opened: { revision: string; document: string }) => void };
function LibraryText({ client, method, row, noun, edit, onGone }: { client: ZetaClient; method: string; row: CatalogRow; noun: string; edit: EditControl | null; onGone: () => void }) {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pending = useRef<AbortController | null>(null);
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (reveal?.state === "data" || reveal?.state === "failed") region.current?.focus();
  }, [reveal]);

  // One click is one read for this row's {name, scope}.
  async function show() {
    if (reveal?.state === "loading") return;
    const abort = new AbortController();
    pending.current = abort;
    setReveal({ state: "loading" });
    let next: Reveal;
    try {
      const body = projectBody(await client.request(method, { name: row.name, scope: row.scope }, { signal: abort.signal }), row.name);
      next = body ? { state: "data", body } : { state: "failed", problem: unreadable };
    } catch (error) {
      next = { state: "failed", problem: problemOf(error) };
    }
    setReveal(next);
    // clear first and set on the next frame, so a second show of the same text is announced again.
    setAnnouncement("");
    if (next.state !== "data") return;
    const message = [`${noun} text loaded`, next.body.redacted && "some secret-like text was removed", next.body.truncated && "truncated at 128 KiB"];
    requestAnimationFrame(() => setAnnouncement(message.filter(Boolean).join(". ")));
  }

  const gone = reveal?.state === "failed" && reveal.problem.gone;
  return <section className="library-text" aria-label={`${noun} text`}>
    <p className="library-untrusted">file text is untrusted. it is shown as plain text and never sent to a model.</p>
    <p role="status" className="library-visually-hidden">{announcement}</p>
    <div className="library-text-actions">
      {reveal?.state === "data"
        ? <button type="button" onClick={() => setReveal(null)}>hide text</button>
        : (!reveal || reveal.state === "loading" || reveal.problem.retry) &&
          <button type="button" aria-disabled={reveal?.state === "loading"} onClick={() => void show()}>
            {reveal?.state === "loading" ? `reading ${noun} text…` : reveal ? "retry" : `show ${noun} text`}
          </button>}
      {gone && <button type="button" onClick={onGone}>refresh list</button>}
    </div>
    {reveal?.state === "failed" && <div ref={region} tabIndex={-1} className="library-text-region">
      <p role="alert" className="library-error">could not show the text: {reveal.problem.message}</p>
    </div>}
    {reveal?.state === "data" && <div ref={region} tabIndex={-1} role="region" aria-label={`${row.name} ${noun} text`} className="library-text-region">
      {reveal.body.redacted && <p className="library-flag">redacted: some secret-like text was removed from this file</p>}
      {reveal.body.truncated && <p className="library-flag">truncated at 128 KiB</p>}
      <pre className="library-body">{reveal.body.text}</pre>
      {reveal.body.truncated && <p className="library-flag">text truncated at 128 KiB</p>}
    </div>}
    {edit && reveal?.state === "data" && <EditEntry edit={edit} row={row} body={reveal.body} />}
  </section>;
}

/** The edit control for a revealed item, or why it cannot be edited here. Only zeta's raw `document` can be edited. */
function EditEntry({ edit, row, body }: { edit: EditControl; row: CatalogRow; body: Body }) {
  const why = !row.editable ? "built-in items are read-only." : uneditable(body);
  if (why || !body.editable) return <p className="library-edit-why">{why}</p>;
  const opened = body.editable;
  return <div className="library-text-actions">
    <button type="button" data-write-surface="library.edit" aria-disabled={edit.taking || !edit.allowed}
      aria-describedby={edit.feedback || !edit.allowed ? "library-control-feedback" : undefined} onClick={() => edit.start(opened)}>{edit.taking ? "taking control…" : "edit"}</button>
  </div>;
}

function problemCount(rows: CatalogRow[]) {
  const count = rows.filter((row) => row.diagnostics?.items.length).length;
  return count > 0 && ` · ${count} ${count === 1 ? "has" : "have"} a problem`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function Metadata({ row }: { row: CatalogRow }) {
  if ("keywords" in row) return <Field label="keywords">{row.keywords.length ? <ul className="library-keywords">
    {row.keywords.map((word, i) => <li key={i}>{word}</li>)}
  </ul> : "none"}</Field>;
  return <>
    <Field label="model">{row.model ?? "not specified"}</Field>
    <Field label="tools">{row.tools === null ? "not specified" : row.tools.join(", ") || "none"}</Field>
    <Field label="can delegate">{yesNo(row.allowDelegation)}</Field>
    <Field label="accepts follow-ups">{yesNo(row.acceptsFollowUps)}</Field>
    <Field label="explicit finish">{yesNo(row.explicitFinish)}</Field>
    <Field label="max turns">{row.maxTurns ?? "not specified"}</Field>
  </>;
}
