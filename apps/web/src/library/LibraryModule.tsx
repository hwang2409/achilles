import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { chatsRoute, surfaceHref, surfaceRoutes } from "../surface/routes";
import { appendPage, libraryMethods, projectBody, projectCatalog, projectCatalogPage, sourceTiers, type Body, type CatalogRow, type LibraryKind } from "./catalog";
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

type View = { state: "empty" } | { state: "no-session" } | { state: "invalid" } | { state: "data"; rows: CatalogRow[]; nextOffset: number | null } | { state: "failed"; problem: Problem };
type Problem = { message: string; retry: boolean };
type Reveal = { key: string } & ({ state: "loading" } | { state: "data"; body: Body } | { state: "failed"; problem: Problem });
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
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const pendingRead = useRef<AbortController | null>(null);
  const attemptRef = useRef(0);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
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
            : page.rows.length ? { state: "data", rows: appendPage([], page.rows), nextOffset: page.nextOffset } : { state: "empty" };
        } else {
          const snapshot = projectCatalog(await client.request("status", {}, { signal: abort.signal }), kind);
          view = snapshot.state === "data" ? { ...snapshot, nextOffset: null } : snapshot;
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
  const selectedKey = selected ? rowKey(selected) : null;
  // A body belongs to one selection: drop it and abandon its read when the selection changes.
  useEffect(() => {
    setReveal(null);
    return () => {
      pendingRead.current?.abort();
      pendingRead.current = null;
    };
  }, [selectedKey]);
  const shown = reveal && reveal.key === selectedKey ? reveal : null;
  useEffect(() => {
    if (selected && matchMedia(narrow).matches) detailHeading.current?.focus();
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
      else setCatalog((view) => view?.state === "data" && started === attemptRef.current
        ? { state: "data", rows: appendPage(view.rows, page.rows), nextOffset: page.nextOffset } : view);
    } catch (error) {
      next = problemOf(error);
    }
    if (started === attemptRef.current) setMore(next);
  }

  // One click is one read for the selected {name, scope}; a response for an older selection is dropped.
  async function showText(row: CatalogRow) {
    pendingRead.current?.abort();
    const abort = new AbortController();
    pendingRead.current = abort;
    const key = rowKey(row);
    setReveal({ key, state: "loading" });
    let next: Reveal;
    try {
      const body = projectBody(await client.request(methods.read, { name: row.name, scope: row.scope }, { signal: abort.signal }), row.name);
      next = body ? { key, state: "data", body } : { key, state: "failed", problem: unreadable };
    } catch (error) {
      next = { key, state: "failed", problem: problemOf(error) };
    }
    if (!abort.signal.aborted) setReveal(next);
  }

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
    <section className="library-list" aria-label={`${title} catalog`}>
      <div className="library-filter">
        <input ref={search} type="search" aria-label={`filter ${title}`} placeholder={kind === "skills" ? "filter by name or keyword" : "filter by name or description"}
          value={query} onChange={(event) => setQuery(event.target.value)} />
        <span role="status">{matches.length} {term ? `of ${rows.length}` : catalog.nextOffset === null ? "found" : "loaded"}</span>
      </div>
      {matches.length === 0 && <p className="library-no-matches">no matches. try a different search.</p>}
      {sourceTiers.map((source) => {
        const group = matches.filter((row) => row.source === source);
        return group.length > 0 && <section className="library-group" key={source} aria-labelledby={`library-${source}`}>
          <h2 id={`library-${source}`}>{source} <small>{tierRules[source]} · {group.length}</small></h2>
          <ul>
            {group.map((row) => <li key={row.name}>
              <button type="button" aria-current={row === selected || undefined} onClick={(event) => {
                lastRow.current = event.currentTarget;
                setSelection(row.name);
              }}>
                <strong>{row.name}</strong>
                {!row.editable && <small>read-only</small>}
                <span>{row.description}</span>
              </button>
            </li>)}
          </ul>
        </section>;
      })}
      {catalog.nextOffset !== null && <div className="library-more">
        <button type="button" aria-disabled={more === "loading"} onClick={() => void loadMore()}>{more === "loading" ? "loading more…" : "load more"}</button>
        {typeof more === "object" && <span role="alert">could not load more: {more.message}</span>}
      </div>}
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
          {reads.catalog && <Field label="scope">{selected.scope}</Field>}
          <Metadata row={selected} />
          {selected.diagnostics && <Field label="diagnostics">{selected.diagnostics.items.length ? <ul className="library-diagnostics">
            {selected.diagnostics.items.map((message, i) => <li key={i}>{message}</li>)}
            {selected.diagnostics.more > 0 && <li>{selected.diagnostics.more} more</li>}
          </ul> : "none"}</Field>}
        </dl>
        {reads.catalog && reads.read ? <section className="library-text" aria-label={`${noun} text`}>
          <p className="library-untrusted">file text is untrusted. it is shown as plain text and never sent to a model.</p>
          {!shown ? <button type="button" onClick={() => void showText(selected)}>show {noun} text</button>
            : shown.state === "loading" ? <p role="status">reading {noun} text…</p>
            : shown.state === "failed" ? <p role="alert">could not show the text: {shown.problem.message}
              {shown.problem.retry && <button type="button" onClick={() => void showText(selected)}>retry</button>}</p>
            : <>
              {shown.body.redacted && <p className="library-flag">redacted: some secret-like text was removed</p>}
              {shown.body.truncated && <p className="library-flag">truncated at 128 KiB</p>}
              <pre className="library-body">{shown.body.text}</pre>
            </>}
        </section> : <aside className="library-notice">
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
          <span>{reads.catalog ? "live catalog · effective scope" : "active session snapshot · may be stale"}</span>
          <button type="button" aria-disabled={!catalog} onClick={refresh}>refresh</button>
        </div>
      </div>
      {content}
    </div>
  </ModuleFrame>;
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
