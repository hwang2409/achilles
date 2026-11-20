import type { ListState } from "../pageList";
import { timeLabel, type PageLink } from "../surface/AgentNavAdapter";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import "./pages-landing.css";

type Props = {
  catalog: ListState<PageLink, null>;
  reload: () => void;
  more: (initiator: HTMLButtonElement) => Promise<void>;
};

export function PagesLanding({ catalog: { items, next, loading, error }, reload, more }: Props) {
  const titles = new Map(items?.map(({ route, title }) => [route, title]));
  return <ModuleFrame title="pages">
    <div className="pages-landing">
      {error ? <ModuleState kind="failed" title="the page catalog did not load" action={{ label: "retry", run: reload }} />
        : items === null ? <ModuleState kind="loading" title="reading pages…" />
        : items.length === 0 ? <ModuleState kind="empty" title="no pages yet" detail="pages you build will appear here." />
        : <section className="page-list" aria-label="page catalog" data-list-state={loading ? "loading" : "ready"} data-loaded-count={items.length}>
          <ul className="pages-grid">
            {items.map((page) => <li key={page.id}>
              <a className="pages-card" data-page-id={page.id} href={surfaceHref(page.route)} aria-labelledby={`page-title-${page.id} page-route-${page.id}`}>
                <h2 id={`page-title-${page.id}`}>{page.title}</h2>
                <span className="pages-route" id={`page-route-${page.id}`}>{page.route}</span>
                <div className="pages-facts">
                  {!Number.isNaN(Date.parse(page.updated_at)) && <span>changed <time dateTime={page.updated_at} title={new Date(page.updated_at).toLocaleString()}>{timeLabel(page.updated_at)}</time></span>}
                  <span>{page.chat_count} {page.chat_count === 1 ? "chat" : "chats"}</span>
                  <span className="pages-mode" data-on={page.create_mode}>{page.create_mode ? "create on" : "create off"}</span>
                </div>
                {page.created_by_route !== null && <span className="pages-origin">made from {titles.get(page.created_by_route) ?? page.created_by_route}</span>}
              </a>
            </li>)}
          </ul>
          {next && <button type="button" className="pages-more" aria-disabled={loading} onClick={(event) => { if (!loading) void more(event.currentTarget); }}>
            {loading ? "reading pages…" : "show more pages"}
          </button>}
        </section>}
    </div>
  </ModuleFrame>;
}
