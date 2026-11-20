import { useEffect, useRef } from "react";
import { chatHref, timeLabel, titleOf, useOnScreen, type useAgentNavAdapter } from "../surface/AgentNavAdapter";
import { surfaceHref } from "../surface/routes";
import type { useActiveChat } from "../useActiveChat";
import { buildLabel, type BuildActivity, type BuildRow } from "./buildActivity";
import { ShellDockSlot } from "../surface/ModuleState";
import { restoreFocus } from "../keyboard";
import "./create.css";

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
    <header className="create-heading"><strong>create</strong><a href={surfaceHref("/pages")}>all pages</a></header>
    <ShellDockSlot />
    <div className="create-scroll">
      <div className="create-landing">
        <h1>what should we build?</h1>
        <p>describe a page in plain words. achilles opens a new chat in create mode and keeps the result in pages. navigation does not hide progress.</p>
        <form onSubmit={(event) => { event.preventDefault(); void build.start(); }} aria-busy={build.pending}>
          <textarea ref={prompt} aria-label="describe your page" aria-describedby="create-build-status" value={build.draft}
            readOnly={build.pending || build.locked} placeholder="a page to track…" onChange={(event) => build.setDraft(event.target.value)} />
          <div className="create-form-actions">
            <span data-testid="build-facts">create on · runs in a new chat · {build.approvalMode === "ask" ? "ask before running tools" : build.approvalMode === "allow" ? "auto-approve tools" : "checking approval mode…"}</span>
            <button ref={submit} type="submit" aria-disabled={build.unavailable || !build.draft.trim()} aria-busy={build.unavailable || undefined}>{build.unavailable ? "starting…" : build.error ? "retry build" : "build page"}</button>
          </div>
          <div id="create-build-status" className="create-build-status" role={build.error ? "alert" : "status"}>
            {build.error ?? (build.pending ? "starting your build chat…" : null)}
          </div>
        </form>
        <div className="create-starters" aria-label="starter prompts">
          {starters.map((starter) => <button type="button" key={starter} disabled={build.pending || build.locked} onClick={() => { build.setDraft(starter); prompt.current?.focus(); }}>{starter}</button>)}
        </div>
        <section aria-labelledby="create-open">
          <header><h2 id="create-open">recent builds</h2>{(activity.stale || activity.rows.some((row) => row.reason)) && <div className="create-refresh">
            {activity.stale && <span id="create-refresh-why">zeta was busy</span>}
            {/* the button unmounts once used: a keyboard user keeps their place on the first build row on screen, not <body> */}
            <button type="button" aria-describedby={activity.stale ? "create-refresh-why" : undefined} onClick={(event) => {
              if (event.detail === 0 && document.activeElement === event.currentTarget) restoreFocus(...event.currentTarget.closest("section")!.querySelectorAll("li > a"));
              activity.refresh();
            }}>refresh</button></div>}</header>
          {!activity.rows.length ? catalog.error ? <p>could not load builds. <button type="button" onClick={catalog.reload}>retry</button></p>
            : catalog.loading ? <p role="status">reading recent builds…</p> : <p>no recent page builds.</p>
            : <ul>{activity.rows.slice(0, 4).map((row) => <BuildCard key={row.chat.session_id} row={row} onScreen={activity.onScreen} />)}</ul>}
        </section>
        <section aria-labelledby="create-made">
          <header><h2 id="create-made">made here</h2><a href={surfaceHref("/pages")}>all pages</a></header>
          {pageCatalog.error ? <p>could not load pages.</p> : made === undefined ? <p role="status">reading pages…</p>
            : !made.length ? <p>no created pages in the recent catalog.</p>
            : <ul className="create-made">{made.map((page) => <li key={page.id}><a href={surfaceHref(page.route)}><strong>{page.title}</strong><small>{page.route}</small></a></li>)}</ul>}
        </section>
      </div>
    </div>
  </>;
}

function BuildCard({ row, onScreen }: { row: BuildRow; onScreen: (id: string, shown: boolean) => void }) {
  const { chat, state, reason, tools, results } = row;
  const label = buildLabel(row);
  const seen = useOnScreen(chat.session_id, onScreen);
  return <li ref={seen} data-state={state ?? undefined} data-last-known={reason ? "" : undefined}>
    <a href={chatHref(chat)}><span><strong>{titleOf(chat)}</strong>
      <small className="build-meta">{label && <em title={label}>{label.replaceAll(" · ", " ·\u00a0")}</em>}<time dateTime={chat.updated_at}>{timeLabel(chat.updated_at)}</time></small></span>
      <b>{state === "needs you" && !reason ? "answer" : "open chat"}</b></a>
    {tools.length > 0 && <small className="build-tools">{tools.map((tool) => tool.replace(/^achilles__/, "")).join(" ·\u00a0")}</small>}
    {results.length > 0 && <ul className="build-results" aria-label="result pages">{results.map((route) => <li key={route}><a href={surfaceHref(route)}>{route}</a></li>)}</ul>}
  </li>;
}
