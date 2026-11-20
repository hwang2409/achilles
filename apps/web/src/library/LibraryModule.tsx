import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { chatsRoute, surfaceHref, surfaceRoutes } from "../surface/routes";
import { appendPage, libraryMethods, projectBody, projectCatalog, projectCatalogPage, sourceTiers, type Body, type CatalogPage, type CatalogRow, type LibraryKind } from "./catalog";
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

type View = { state: "empty" } | { state: "no-session" } | { state: "invalid" } | { state: "data"; rows: CatalogRow[]; nextOffset: number | null; skipped: Extract<CatalogPage, { state: "data" }>["skipped"] | null } | { state: "failed"; problem: Problem };
type Problem = { message: string; retry: boolean };
type Reveal = { state: "loading" } | { state: "data"; body: Body } | { state: "failed"; problem: Problem };
/** Which library_read_v1 methods this zeta advertised; both false means the older status snapshot. */
export type LibraryReads = { catalog: boolean; read: boolean };

const rowKey = (row: CatalogRow) => `${row.scope}/${row.name}`;
const unreadable: Problem = { message: "zeta sent data this view cannot read", retry: true };
function problemOf(error: unknown): Problem {
  const rpc = error as { code?: unknown; data?: { reason?: unknown } } | null;
  if (rpc?.code === -32005) return { message: "not available without an open project", retry: false };
  if (rpc?.code === -32602 && rpc.data?.reason === "resource_not_found") return { message: "no longer exists", retry: false };
  if (rpc?.code === -32007) return { message: "too large to show", retry: false };
  return { message: "zeta could not read it", retry: true };
}

export function LibraryModule({ client, kind, reads }: { client: ZetaClient; kind: LibraryKind; reads: LibraryReads }) {
  const title = kind === "skills" ? "skills" : "agent profiles";
  const noun = kind === "skills" ? "skill" : "profile";
  const methods = libraryMethods(kind);
  const [catalog, setCatalog] = useState<View | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<"idle" | "loading" | Problem>("idle");
  const attemptRef = useRef(0);
  const list = useRef<HTMLElement>(null);
  const focusNew = useRef<Set<string> | null>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const keyboardPick = useRef(false);
  const lastRow = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const returnToList = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      let view: View;
      try {
        if (reads.catalog) {
          const page = projectCatalogPage(await client.request(methods.catalog, PAGE, { signal: abort.signal }), kind);
          view = page.state === "invalid" ? { state: "failed", problem: unreadable }
            : page.rows.length ? { state: "data", rows: appendPage([], page.rows), nextOffset: page.nextOffset, skipped: page.skipped } : { state: "empty" };
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
  // After "load more" or "refresh list", keyboard focus moves to the first new row shown (or the filter when none is visible).
  useEffect(() => {
    const added = focusNew.current;
    if (!added || catalog?.state !== "data") return;
    focusNew.current = null;
    const rowButtons = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-row]") ?? [])];
    (rowButtons.find((button) => added.has(button.dataset.row ?? "")) ?? search.current)?.focus();
  }, [catalog]);
  useEffect(() => {
    // narrow layouts swap to the detail; on desktop only a keyboard pick moves focus there (a mouse click keeps it).
    if (selected && (keyboardPick.current || matchMedia(narrow).matches)) detailHeading.current?.focus();
    keyboardPick.current = false;
    if (!selected && returnToList.current) {
      returnToList.current = false;
      (lastRow.current?.isConnected ? lastRow.current : search.current)?.focus();
    }
  }, [selected]);

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
    let next: typeof more = "idle";
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

  const partial = catalog?.state === "data" && catalog.nextOffset !== null;
  const term = query.trim().toLowerCase();
  const matches = rows.filter((row) => [row.name, row.description, ...("keywords" in row ? row.keywords : [])]
    .some((text) => text.toLowerCase().includes(term)));

  let content: ReactNode;
  if (!catalog) content = <ModuleState kind="loading" title={reads.catalog ? "reading catalog…" : "reading session snapshot…"} />;
  else if (catalog.state === "failed") content = <ModuleState kind="failed" title={`could not read ${title}: ${catalog.problem.message}`}
    action={catalog.problem.retry ? { label: "retry", run: refresh } : undefined} />;
  else if (catalog.state === "invalid") content = <ModuleState kind="failed" title="could not read the catalog" detail="refresh to try the active session snapshot again." />;
  else if (catalog.state === "empty") content = reads.catalog
    ? <ModuleState kind="empty" title={`no ${title} found`} detail="zeta reported no entries in the effective scope." />
    : <ModuleState kind="empty" title={`no ${title} in this snapshot`} detail="the active session did not report any entries for this catalog." />;
  else if (catalog.state === "no-session") content = <div className="library-unavailable">
    <ModuleState kind="unsupported" title="no active session" detail="this zeta only reports library catalogs for an active session." />
    <a href={surfaceHref(chatsRoute.path)}>open a chat</a>
  </div>;
  else content = <div className="library-layout" data-detail={Boolean(selected)}>
    <section ref={list} className="library-list" aria-label={`${title} catalog`}>
      <div className="library-filter">
        <input ref={search} type="search" aria-label={`filter ${title}`} placeholder={kind === "skills" ? "filter by name or keyword" : "filter by name or description"}
          value={query} onChange={(event) => setQuery(event.target.value)} />
        <span role="status">{term ? `${matches.length} of ${rows.length}` : matches.length} {partial ? "loaded" : term ? "" : "found"}</span>
      </div>
      {reads.catalog && !rows.some(({ source }) => source === "project") &&
        <p className="library-hint">no project {kind === "skills" ? "skills" : "profiles"} loaded · they appear when a chat is open in a project that has them</p>}
      {matches.length === 0 && <p className="library-no-matches">{partial ? "no matches in the loaded rows. load more to search the rest." : "no matches. try a different search."}</p>}
      {sourceTiers.map((source) => {
        const group = matches.filter((row) => row.source === source);
        return group.length > 0 && <section className="library-group" key={source} aria-labelledby={`library-${source}`}>
          <h2 id={`library-${source}`}>{source} <small>{tierRules[source]} · {group.length}{partial && " loaded"}{problemCount(group)}</small></h2>
          <ul>
            {group.map((row) => <li key={row.name}>
              <button type="button" data-row={row.name} aria-current={row === selected || undefined} onClick={(event) => {
                lastRow.current = event.currentTarget;
                // detail 0: activated by Enter or Space, not a pointer.
                if (event.detail === 0 && row === selected) detailHeading.current?.focus();
                keyboardPick.current = event.detail === 0;
                setSelection(row.name);
              }}>
                <strong>{row.name}</strong>
                {!row.editable && <small>read-only</small>}
                <span>{row.description}</span>
                {row.diagnostics?.items.length ? <span className="library-warning">warning · {row.diagnostics.items[0]}</span> : null}
              </button>
            </li>)}
          </ul>
        </section>;
      })}
      {catalog.nextOffset !== null && <div className="library-more">
        <button type="button" aria-disabled={more === "loading"} onClick={() => void loadMore()}>{more === "loading" ? "loading more…" : "load more"}</button>
        {typeof more === "object" && <span role="alert">could not load more: {more.message}</span>}
      </div>}
      {catalog.skipped && catalog.skipped.items.length > 0 && <details className="library-skipped">
        <summary>{catalog.skipped.items.length + catalog.skipped.more} {catalog.skipped.items.length + catalog.skipped.more === 1 ? "file" : "files"} skipped or shadowed</summary>
        <ul>
          {catalog.skipped.items.map(({ source, file, reason }, i) => <li key={i}><span>{source} · {file}</span> {reason}</li>)}
          {catalog.skipped.more > 0 && <li>{catalog.skipped.more} more</li>}
        </ul>
      </details>}
    </section>
    <section className="library-detail" aria-label="catalog detail">
      {selected ? <>
        <button type="button" className="library-back" onClick={() => {
          returnToList.current = true;
          setSelection(null);
        }}>‹ back to {title}</button>
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
        </div>
      </div>
      {content}
    </div>
  </ModuleFrame>;
}

/**
 * The selected row's untrusted text. Rendered with `key={rowKey(row)}`, so a new selection is a new instance:
 * unmounting aborts the pending read, and an aborted read never publishes.
 */
function LibraryText({ client, method, row, noun, onGone }: { client: ZetaClient; method: string; row: CatalogRow; noun: string; onGone: () => void }) {
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
    if (abort.signal.aborted) return;
    setReveal(next);
    // clear first and set on the next frame, so a second show of the same text is announced again.
    setAnnouncement("");
    if (next.state !== "data") return;
    const message = [`${noun} text loaded`, next.body.redacted && "some secret-like text was removed", next.body.truncated && "truncated at 128 KiB"];
    requestAnimationFrame(() => setAnnouncement(message.filter(Boolean).join(". ")));
  }

  const gone = reveal?.state === "failed" && reveal.problem.message === "no longer exists";
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
  </section>;
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
