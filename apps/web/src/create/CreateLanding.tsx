import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useRef } from "react";
import { chatHref, timeLabel, titleOf, useOnScreen, type useAgentNavAdapter } from "../surface/AgentNavAdapter";
import { surfaceHref } from "../surface/routes";
import type { useActiveChat } from "../useActiveChat";
import { buildLabel, type BuildActivity, type BuildRow } from "./buildActivity";
import { ShellDockSlot } from "../surface/ModuleState";
import { restoreFocus } from "../keyboard";

const starters = [
  "a reading list with statuses",
  "expenses by category",
  "grade eval runs on a rubric",
  "a weekly habit tracker",
];

export function CreateLanding({ build, nav, activity }: { activity: BuildActivity; build: ReturnType<typeof useActiveChat>["build"]; nav: ReturnType<typeof useAgentNavAdapter> }) {
  const prompt = useRef<HTMLTextAreaElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const { catalog, pageCatalog } = nav;
  const made = pageCatalog.items?.filter((page) => page.created_by_route != null).slice(0, 3);
  useEffect(() => {
    if (build.error && (document.activeElement === submit.current || document.activeElement === document.body)) prompt.current?.focus();
  }, [build.error]);
  return <>
    <header data-create-heading="" className="flex min-h-12 shrink-0 items-center justify-between gap-4 border-b px-4 sm:min-h-14 sm:px-6"><strong>create</strong><Button asChild variant="outline"><a href={surfaceHref("/pages")}>all pages</a></Button></header>
    <ShellDockSlot />
    <div className="min-h-0 flex-1 overflow-auto">
      <div data-create-landing="" className="mx-auto max-w-[928px] p-4 text-sm sm:p-6 [&>section]:mt-8 [&>section>header]:mb-2 [&>section>header]:flex [&>section>header]:items-baseline [&>section>header]:justify-between [&>section>header]:gap-3 [&_h2]:font-semibold [&_small]:text-xs [&_small]:text-muted-foreground [&_li>a]:flex [&_li>a]:items-center [&_li>a]:justify-between [&_li>a]:gap-2.5 [&_li>a]:p-3 [&_li>a:hover]:bg-accent">
        <h1 className="mb-2 text-[26px] leading-tight font-semibold tracking-tight text-balance">what should we build?</h1>
        <p className="mb-4 text-pretty text-muted-foreground">describe a page in plain words. achilles opens a new chat in create mode and keeps the result in pages. navigation does not hide progress.</p>
        <Card className="gap-0 p-3"><form onSubmit={(event) => { event.preventDefault(); void build.start(); }} aria-busy={build.pending}>
          <Textarea className="min-h-16 resize-y bg-background" ref={prompt} aria-label="describe your page" aria-describedby="create-build-status" value={build.draft}
            readOnly={build.pending || build.locked} placeholder="a page to track…" onChange={(event) => build.setDraft(event.target.value)} />
          <div data-create-form-actions="" className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground" data-testid="build-facts">create on · runs in a new chat · {build.approvalMode === "ask" ? "ask before running tools" : build.approvalMode === "allow" ? "auto-approve tools" : "checking approval mode…"}</span>
            <Button ref={submit} className="min-w-28 aria-disabled:border aria-disabled:bg-transparent aria-disabled:text-muted-foreground" type="submit" aria-disabled={build.unavailable || !build.draft.trim()} aria-busy={build.unavailable || undefined}>{build.unavailable ? "starting…" : build.error ? "retry build" : "build page"}</Button>
          </div>
          <div id="create-build-status" className="mt-1 text-xs text-muted-foreground [&[role=alert]]:text-destructive" role={build.error ? "alert" : "status"}>
            {build.error ?? (build.pending ? "starting your build chat…" : null)}
          </div>
        </form></Card>
        <div className="mt-3 flex flex-wrap gap-2" aria-label="starter prompts">
          {starters.map((starter) => <Button type="button" variant="outline" size="sm" className="max-sm:min-h-11" key={starter} disabled={build.pending || build.locked} onClick={() => { build.setDraft(starter); prompt.current?.focus(); }}>{starter}</Button>)}
        </div>
        <section aria-labelledby="create-open">
          <header><h2 id="create-open">recent builds</h2>{(activity.stale || activity.rows.some((row) => row.reason)) && <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {activity.stale && <span id="create-refresh-why">zeta was busy</span>}
            {/* the button unmounts once used: a keyboard user keeps their place on the first build row on screen, not <body> */}
            <Button type="button" variant="outline" size="sm" className="max-sm:min-h-11" aria-describedby={activity.stale ? "create-refresh-why" : undefined} onClick={(event) => {
              if (event.detail === 0 && document.activeElement === event.currentTarget) restoreFocus(...event.currentTarget.closest("section")!.querySelectorAll("li > a"));
              activity.refresh();
            }}>refresh</Button></div>}</header>
          {!activity.rows.length ? catalog.error ? <p className="mb-4 text-pretty text-muted-foreground">could not load builds. <Button type="button" variant="outline" size="sm" className="max-sm:min-h-11" onClick={catalog.reload}>retry</Button></p>
            : catalog.loading ? <p role="status">reading recent builds…</p> : <p className="mb-4 text-pretty text-muted-foreground">no recent page builds.</p>
            : <ul>{activity.rows.slice(0, 4).map((row) => <BuildCard key={row.chat.session_id} row={row} onScreen={activity.onScreen} />)}</ul>}
        </section>
        <section aria-labelledby="create-made">
          <header><h2 id="create-made">made here</h2><a href={surfaceHref("/pages")}>all pages</a></header>
          {pageCatalog.error ? <p className="mb-4 text-pretty text-muted-foreground">could not load pages.</p> : made === undefined ? <p role="status">reading pages…</p>
            : !made.length ? <p className="mb-4 text-pretty text-muted-foreground">no created pages in the recent catalog.</p>
            : <ul className="divide-y border-t">{made.map((page) => <li key={page.id}><a href={surfaceHref(page.route)}><strong>{page.title}</strong><small>{page.route}</small></a></li>)}</ul>}
        </section>
      </div>
    </div>
  </>;
}

function BuildCard({ row, onScreen }: { row: BuildRow; onScreen: (id: string, shown: boolean) => void }) {
  const { chat, state, reason, tools, results } = row;
  const label = buildLabel(row);
  const seen = useOnScreen(chat.session_id, onScreen);
  return <li className="border-b border-s-2 border-s-transparent data-[state]:border-s-ring data-[state]:bg-card data-[state=failed]:border-s-destructive data-[attention]:border-s-warning data-[attention]:text-warning" ref={seen} data-state={state ?? undefined} data-attention={state === "needs you" && !reason || undefined} data-last-known={reason ? "" : undefined}>
    <a href={chatHref(chat)}><span className="grid min-w-0 gap-1 [overflow-wrap:anywhere]"><strong>{titleOf(chat)}</strong>
      <small className="flex flex-wrap gap-x-2 font-(family-name:--achilles-code-font)">{label && <em title={label}>{label.replaceAll(" · ", " ·\u00a0")}</em>}<time dateTime={chat.updated_at}>{timeLabel(chat.updated_at)}</time></small></span>
      <b className="shrink-0 text-xs">{state === "needs you" && !reason ? "answer" : "open chat"}</b></a>
    {tools.length > 0 && <small className="block px-3 pb-2 [overflow-wrap:anywhere]">{tools.map((tool) => tool.replace(/^achilles__/, "")).join(" ·\u00a0")}</small>}
    {results.length > 0 && <ul className="flex flex-wrap border-t text-xs text-muted-foreground" aria-label="result pages">{results.map((route) => <li key={route}><a href={surfaceHref(route)}>{route}</a></li>)}</ul>}
  </li>;
}
