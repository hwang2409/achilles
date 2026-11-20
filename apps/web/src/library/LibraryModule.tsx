import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { chatsRoute, surfaceHref, surfaceRoutes } from "../surface/routes";
import { projectCatalog, sourceTiers, type Catalog, type CatalogRow, type LibraryKind } from "./catalog";
import "./library.css";

const tabs = surfaceRoutes.filter(({ id }) => id === "skills" || id === "agent-profiles");
const tierRules = {
  project: "wins over home",
  home: "wins over packaged",
  packaged: "read-only",
};
const narrow = "(max-width: 760px), (max-height: 500px)";
const yesNo = (value: boolean) => value ? "yes" : "no";

export function LibraryModule({ client, kind }: { client: ZetaClient; kind: LibraryKind }) {
  const title = kind === "skills" ? "skills" : "agent profiles";
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const lastRow = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const returnToList = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const projected = projectCatalog(await client.request("status", {}, { signal: abort.signal }), kind);
        if (!abort.signal.aborted) setCatalog(projected);
      } catch {
        if (!abort.signal.aborted) setCatalog({ state: "invalid" });
      }
    })();
    return () => abort.abort();
  }, [client, kind, attempt]);

  const rows = catalog?.state === "data" ? catalog.rows : [];
  const selected = rows.find(({ name }) => name === selection);
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
    setAttempt((n) => n + 1);
  }

  const term = query.trim().toLowerCase();
  const matches = rows.filter((row) => [row.name, row.description, ...("keywords" in row ? row.keywords : [])]
    .some((text) => text.toLowerCase().includes(term)));

  let content: ReactNode;
  if (!catalog) content = <ModuleState kind="loading" title="reading session snapshot…" />;
  else if (catalog.state === "invalid") content = <ModuleState kind="failed" title="could not read the catalog" detail="refresh to try the active session snapshot again." />;
  else if (catalog.state === "empty") content = <ModuleState kind="empty" title={`no ${title} in this snapshot`} detail="the active session did not report any entries for this catalog." />;
  else if (catalog.state === "no-session") content = <div className="library-unavailable">
    <ModuleState kind="unsupported" title="no active session" detail="this zeta only reports library catalogs for an active session." />
    <a href={surfaceHref(chatsRoute.path)}>open a chat</a>
  </div>;
  else content = <div className="library-layout" data-detail={Boolean(selected)}>
    <section className="library-list" aria-label={`${title} catalog`}>
      <div className="library-filter">
        <input ref={search} type="search" aria-label={`filter ${title}`} placeholder={kind === "skills" ? "filter by name or keyword" : "filter by name or description"}
          value={query} onChange={(event) => setQuery(event.target.value)} />
        <span role="status">{matches.length} {term ? `of ${rows.length}` : "found"}</span>
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
                {source === "packaged" && <small>read-only</small>}
                <span>{row.description}</span>
              </button>
            </li>)}
          </ul>
        </section>;
      })}
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
          <Field label="source">{selected.source}{selected.source === "packaged" && " · read-only"}</Field>
          <Metadata row={selected} />
        </dl>
        <aside className="library-notice">
          <strong>metadata only</strong>
          <p>reading {kind === "skills" ? "skill" : "profile"} text requires a newer zeta.</p>
          <p>diagnostics are not reported by this zeta snapshot.</p>
        </aside>
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
          <span>active session snapshot · may be stale</span>
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
