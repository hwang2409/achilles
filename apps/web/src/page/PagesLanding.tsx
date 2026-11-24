import { Button } from "@/components/ui/button";
import type { ListState } from "../pageList";
import { timeLabel, type PageLink } from "../surface/AgentNavAdapter";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";

type Props = {
  catalog: ListState<PageLink, null>;
  reload: () => void;
  more: (initiator: HTMLButtonElement) => Promise<void>;
};

export function PagesLanding({ catalog: { items, next, loading, error }, reload, more }: Props) {
  const titles = new Map(items?.map(({ route, title }) => [route, title]));
  return <ModuleFrame title="Pages" subtitle="Open a page you built with Zeta.">
    <div className="px-4 py-6 sm:px-6">
      {error ? <ModuleState kind="failed" title="the page catalog did not load" action={{ label: "retry", run: reload }} />
        : items === null ? <ModuleState kind="loading" title="reading pages…" />
        : items.length === 0 ? <ModuleState kind="empty" title="no pages yet" detail="pages you build will appear here." />
        : <section data-page-list="" aria-label="page catalog" data-list-state={loading ? "loading" : "ready"} data-loaded-count={items.length}>
          <ul className="border-t">
            {items.map((page) => <li key={page.id}>
              <a className="grid items-baseline gap-x-4 gap-y-1 border-b p-4 [overflow-wrap:anywhere] hover:bg-accent focus-visible:bg-accent sm:grid-cols-[minmax(0,1fr)_minmax(0,.7fr)_minmax(0,1fr)]" data-page-id={page.id} href={surfaceHref(page.route)} aria-labelledby={`page-title-${page.id} page-route-${page.id}`}>
                <h2 className="text-base font-semibold" id={`page-title-${page.id}`}>{page.title}</h2>
                <span className="font-(family-name:--achilles-code-font) text-sm text-[var(--link)]" id={`page-route-${page.id}`}>{page.route}</span>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                  {!Number.isNaN(Date.parse(page.updated_at)) && <span>changed <time dateTime={page.updated_at} title={new Date(page.updated_at).toLocaleString()}>{timeLabel(page.updated_at)}</time></span>}
                  <span>{page.chat_count} {page.chat_count === 1 ? "chat" : "chats"}</span>
                  {page.create_mode && <span>Create on</span>}
                </div>
                {page.created_by_route !== null && <span className="text-xs text-muted-foreground sm:col-span-full">made from {titles.get(page.created_by_route) ?? page.created_by_route}</span>}
              </a>
            </li>)}
          </ul>
          {next && <Button variant="outline" size="lg" type="button" className="mt-4" aria-disabled={loading} onClick={(event) => { if (!loading) void more(event.currentTarget); }}>
            {loading ? "reading pages…" : "show more pages"}
          </Button>}
        </section>}
    </div>
  </ModuleFrame>;
}
