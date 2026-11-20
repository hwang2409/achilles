import { useEffect, useRef } from "react";
import { chatHref, timeLabel, titleOf, type useAgentNavAdapter } from "../surface/AgentNavAdapter";
import { surfaceHref } from "../surface/routes";
import type { useActiveChat } from "../useActiveChat";
import "./create.css";

const starters = [
  "a reading list with statuses",
  "expenses by category",
  "grade eval runs on a rubric",
  "a weekly habit tracker",
];

export function CreateLanding({ build, nav }: { build: ReturnType<typeof useActiveChat>["build"]; nav: ReturnType<typeof useAgentNavAdapter> }) {
  const prompt = useRef<HTMLTextAreaElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const { catalog, pageCatalog } = nav;
  const open = catalog.chats.filter((chat) => chat.last_state === "running" || chat.last_state === "approval" || chat.last_state === "failed").slice(0, 4);
  const made = pageCatalog.items?.filter((page) => page.created_by_route != null).slice(0, 3);
  useEffect(() => {
    if (build.error && (document.activeElement === submit.current || document.activeElement === document.body)) prompt.current?.focus();
  }, [build.error]);
  return <>
    <header className="create-heading"><strong>create</strong><a href={surfaceHref("/pages")}>all pages</a></header>
    <div className="create-scroll">
      <div className="create-landing">
        <h1>what should we build?</h1>
        <p>describe a page in plain words. achilles opens a new chat in create mode and keeps the result in pages.</p>
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
          <header><h2 id="create-open">still open</h2><span>recent chats that may need attention</span></header>
          {catalog.error ? <p>could not load chats. <button type="button" onClick={catalog.reload}>retry</button></p>
            : catalog.loading ? <p role="status">reading recent chats…</p>
            : !open.length ? <p>no recent chats running or waiting for attention.</p>
            : <ul>{open.map((chat) => {
              const status = chat.last_state === "approval" ? "needs you" : chat.last_state;
              return <li key={chat.session_id} data-state={chat.last_state}>
                <a href={chatHref(chat)}><span><strong>{titleOf(chat)}</strong> <small>{chat.page_title}</small></span>
                  <span><small>{status} · {timeLabel(chat.updated_at)}</small><b>{chat.last_state === "approval" ? "answer" : "open chat"}</b></span></a>
              </li>;
            })}</ul>}
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
