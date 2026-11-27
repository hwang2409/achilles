import { useEffect, useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { supportsFeature } from "../zeta";
import { ACCOUNT_LIST_IDLE_FEATURE, readAccounts } from "../zeta/accounts";
import { parseDefaults } from "../settings/SettingsModule";
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

// the login command when zeta's default provider is claude or codex and has no usable account, else null. only a hint: the guess is
// wrong for API-key mode or when serve runs another provider, so the build stays available and reports a real missing login itself.
function useMissingLogin(client: ZetaClient | null) {
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !supportsFeature(client, ACCOUNT_LIST_IDLE_FEATURE)) return;
    let live = true;
    Promise.all([client.request("state_settings", { collection: "mcp", limit: 1 }), readAccounts(client)]).then(([settings, { accounts }]) => {
      const provider = parseDefaults(settings)?.provider;
      const login = provider === "codex" ? "codex" : provider === "claude" ? "anthropic" : null;
      // other providers (a test or local model) need no account login
      const ready = !login || accounts.some((row) => row.available && row.account.startsWith(`${login}:`));
      if (live) setMissing(ready ? null : `zeta login ${login}`);
    }, () => {});
    return () => { live = false; };
  }, [client]);
  return missing;
}

export function CreateLanding({ build, nav, activity, client }: { activity: BuildActivity; build: ReturnType<typeof useActiveChat>["build"]; nav: ReturnType<typeof useAgentNavAdapter>; client: ZetaClient | null }) {
  const missingLogin = useMissingLogin(client);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const { catalog, pageCatalog } = nav;
  const made = pageCatalog.items?.filter((page) => page.created_by_route != null).slice(0, 3);
  useEffect(() => {
    if (build.error && (document.activeElement === submit.current || document.activeElement === document.body)) prompt.current?.focus();
  }, [build.error]);
  return <>
    <header className="create-heading"><strong>Create</strong></header>
    <ShellDockSlot />
    <div className="create-scroll">
      <div className="create-landing">
        <h1>what should we build?</h1>
        {missingLogin && <p data-testid="login-hint">no model login found. if builds fail, run <code>{missingLogin}</code> in a terminal or sign in on <a href={surfaceHref("/accounts")}>accounts</a>.</p>}
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
