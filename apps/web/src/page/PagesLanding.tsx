import { useState } from "react";
import type { ListState } from "../pageList";
import { timeLabel, type PageLink } from "../surface/AgentNavAdapter";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import { usePageEdit } from "./PageArchive";
import "./pages-landing.css";

type Props = {
  catalog: ListState<PageLink, null>;
  reload: () => void;
  more: (initiator: HTMLButtonElement) => Promise<void>;
};

export function PagesLanding({ catalog: { items, next, loading, error }, reload, more }: Props) {
  // the archived list loads when it is opened, and again after any change on this landing
  const [archived, setArchived] = useState<PageLink[] | "loading" | "failed" | null>(null);
  const loadArchived = () => {
    setArchived("loading");
    // shortcut: one read of at most 200 archived pages, no paging; page it like the live list when archives grow.
    void fetch("/api/pages?archived=1&limit=200", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ pages: PageLink[] }> : Promise.reject(new Error(String(response.status))))
      .then((result) => setArchived(result.pages), () => setArchived("failed"));
  };
  const changed = () => { reload(); if (archived !== null) loadArchived(); };
  return <ModuleFrame title="Pages">
    <div className="pages-landing">
      {error ? <ModuleState kind="failed" title="the page catalog did not load" action={{ label: "retry", run: reload }} />
        : items === null ? <ModuleState kind="loading" title="reading pages…" />
        : items.length === 0 ? <ModuleState kind="empty" title="no pages yet" detail="describe one on Create and an agent builds it." action={{ label: "create a page", run: () => location.assign(surfaceHref("/create")) }} />
        : <section className="page-list" aria-label="page catalog" data-list-state={loading ? "loading" : "ready"} data-loaded-count={items.length}>
          <ul className="pages-grid">
            {items.map((page) => <PageRow key={page.id} page={page} onChanged={changed} />)}
          </ul>
          {next && <button type="button" className="pages-more" aria-disabled={loading} onClick={(event) => { if (!loading) void more(event.currentTarget); }}>
            {loading ? "reading pages…" : "show more pages"}
          </button>}
        </section>}
      {!!items?.length && <p className="pages-hint">to add a page, describe it on <a href={surfaceHref("/create")}>Create</a>.</p>}
      {items !== null && !error && <details className="pages-archived" onToggle={(event) => { if (event.currentTarget.open && archived === null) loadArchived(); }}>
        <summary>archived pages</summary>
        {archived === "loading" || archived === null ? <p className="pages-archived-note" role="status">reading archived pages…</p>
          : archived === "failed" ? <p className="pages-archived-note" role="status">archived pages did not load <button type="button" className="link-button" onClick={loadArchived}>retry</button></p>
          : archived.length === 0 ? <p className="pages-archived-note">no archived pages. archive hides a page from Pages and search, and keeps its records and versions.</p>
          : <ul className="pages-grid" aria-label="archived pages">{archived.map((page) => <PageRow key={page.id} page={page} onChanged={changed} />)}</ul>}
      </details>}
    </div>
  </ModuleFrame>;
}

function PageRow({ page, onChanged }: { page: PageLink; onChanged: () => void }) {
  const edit = usePageEdit(page, onChanged);
  const archived = !!page.archived_at;
  const facts = <>
    <span className="pages-route" id={`page-route-${page.id}`}>{page.route}</span>
    <div className="pages-facts">
      {!Number.isNaN(Date.parse(page.updated_at)) && <span>changed <time dateTime={page.updated_at} title={new Date(page.updated_at).toLocaleString()}>{timeLabel(page.updated_at)}</time></span>}
      {page.create_mode && <span>Create on</span>}
    </div>
  </>;
  // while renaming, the row is not a link: a click in the title field must not open the page
  return <li className="pages-row" data-archived={archived || undefined}>
    {edit.editing ? <div className="pages-card">{edit.input(`title of ${page.title}`)}{facts}</div>
      : <a className="pages-card" data-page-id={page.id} href={surfaceHref(page.route)} aria-labelledby={`page-title-${page.id} page-route-${page.id}`}>
        <h2 id={`page-title-${page.id}`}>{page.title}</h2>
        {facts}
      </a>}
    <div className="pages-row-actions" aria-busy={edit.pending || undefined}>
      {!archived && <button type="button" aria-label={`rename ${page.title}`} onClick={edit.startRename}>rename</button>}
      {page.id !== "home" && (archived
        ? <button type="button" aria-label={`restore ${page.title}`} onClick={() => void edit.restore()}>restore</button>
        : <button type="button" aria-label={`archive ${page.title}`} onClick={() => void edit.archive()}>archive</button>)}
    </div>
    {edit.error && <p className="page-edit-error" role="alert">{edit.error}</p>}
  </li>;
}
