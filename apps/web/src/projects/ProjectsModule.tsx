import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ZetaError, type ZetaClient } from "@fulcrum/zeta";
import { NoAnswer } from "../zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import type { MemoryActions } from "./MemoryActions";
import { MAX_RESOLVE, memoryWriteAccess, type MemoryAction, type MemoryReceipt } from "./memoryWrites";
import { canAcceptMemory, hasKindText, isMemoryId, memoryKinds, projectReads, readInbox, readKindText, readMemory, readMessage, readProjects, Unreadable,
  type Body, type InboxRow, type MemoryKind, type MemoryRow, type MemoryPage, type Page, type ProjectRow } from "./reads";
import "./projects.css";

type Tab = "memory" | "inbox";
type Problem = { message: string; retry: boolean };
const tabs: Tab[] = ["memory", "inbox"];
/** Borrows control for one read and gives it back: see `Connection.withControl`. */
export type WithControl = <T>(read: (client: ZetaClient) => Promise<T>) => Promise<{ value: T } | { refused: string }>;
/** What a reveal needs from the page: the current role, the borrow, and the reveals a dropped socket cut short. */
export type Control = { observer: boolean; withControl: WithControl; dropped: Set<string> };
// `borrowing`: one borrow at a time. While it runs, every reveal keeps its observer presentation and waits.
type Borrow = Control & { borrowing: boolean };
// the selected project's name is looked up by paging the list; past this many pages it shows as unknown.
const NAME_PAGES = 20;
const dropped: Problem = { message: "connection dropped; show again", retry: true };
const CONTROL_NOTE = "projects-control-note";

// /projects, /projects/<id>, /projects/<id>/memory, /projects/<id>/inbox. Ids are zeta project ids, never bodies.
function parse(path: string): { id: string; tab: Tab; known: boolean } | null {
  const [, , id, tab] = path.split("/");
  return id ? { id: decodeURIComponent(id), tab: tab === "inbox" ? "inbox" : "memory", known: !tab || tab === "memory" || tab === "inbox" } : null;
}
const hrefOf = (id?: string, tab?: Tab) => id ? `/projects/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}` : "/projects";

function problemOf(error: unknown): Problem | "observer" {
  if (error instanceof NoAnswer) return { message: "zeta did not answer; show again", retry: true };
  if (error instanceof Unreadable) return { message: "zeta sent data this view cannot read", retry: true };
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof ZetaError && error.kind === "closed") return dropped;
  if (code === -32008) return "observer";
  if (code === -32602) return { message: "it no longer exists", retry: false };
  if (code === -32007) return { message: "it is too large to show", retry: false };
  if (code === -32000) return { message: "zeta found this project's stored state invalid. check it with `zeta project show`.", retry: false };
  if (code === -32005 || code === -32009 || code === -32004) return { message: "zeta is busy or the state changed while reading", retry: true };
  return { message: "zeta could not read it", retry: true };
}

export function ProjectsModule({ client, control, actions }: { client: ZetaClient; control: Control; actions?: MemoryActions }) {
  // read the address here, not from the router: a reconnect remounts this module after pushState changed it.
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const back = () => setPath(location.pathname);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const go = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (href !== location.pathname) history.pushState(null, "", surfaceHref(href));
    setPath(href);
  };
  const projects = usePages(client, (reader, cursor, signal) => readProjects(reader, cursor, { signal }), [actions?.refresh], projectReads(client));
  const [borrowing, setBorrowing] = useState(false);
  const borrow: Borrow = { ...control, observer: control.observer || borrowing, borrowing: borrowing || !!actions?.working, withControl: async (read) => {
    setBorrowing(true);
    try { return await control.withControl(read); } finally { setBorrowing(false); }
  } };
  const route = parse(path);
  // an unknown view segment shows memory: say so in the address too.
  useEffect(() => { if (route && !route.known) { const href = hrefOf(route.id, "memory"); history.replaceState(null, "", surfaceHref(href)); setPath(href); } }, [route?.id, route?.known]);
  const listed = projects.state === "data" ? projects.rows : [];
  const lookup = useProjectLookup(client, projectReads(client) ? route?.id ?? null : null, listed, actions?.refresh);
  if (!projectReads(client)) return <ModuleFrame title="Projects">
    <ModuleState kind="unsupported" title="projects need a newer zeta" detail="the zeta that achilles talks to cannot list projects. update zeta, then check again. chats, pages and the library still work."
      action={{ label: "check again", run: () => location.reload() }} />
  </ModuleFrame>;
  const link = (href: string, children: ReactNode, current?: boolean) =>
    <a href={surfaceHref(href)} aria-current={current ? "page" : undefined} onClick={(event) => go(event, href)}>{children}</a>;
  if (!route) return <ModuleFrame title="Projects">
    <div className="projects">
      <Paged view={projects} noun="projects" empty="no projects yet. zeta creates one when a chat opens in a git folder.">
        {(rows) => <ul className="projects-list">
          {rows.map((row) => <li key={row.id}>{link(hrefOf(row.id), <>
            <strong data-row={row.id} title={row.name}>{row.name}</strong>
            <span title={row.path ?? undefined}>{row.path ?? "no folder"}</span>
            <small>{row.sessions} {row.sessions === 1 ? "session" : "sessions"} · {row.memory} memory · {row.inbox.new} new in inbox</small>
          </>)}</li>)}
        </ul>}
      </Paged>
    </div>
  </ModuleFrame>;
  const project = lookup.names.get(route.id);
  const name = project?.name ?? (lookup.state === "reading" ? "…" : "unknown project");
  if (lookup.state === "missing") return <ModuleFrame title="Projects">
    <div className="projects">
      <div className="projects-bar">{link(hrefOf(), "‹ all projects")}</div>
      <ModuleState kind="empty" title="no project with this id" detail="it may have been removed, or the address is wrong." />
    </div>
  </ModuleFrame>;
  return <ModuleFrame title={`Projects / ${name}`}>
    <div className="projects">
      <div className="projects-bar">
        {link(hrefOf(), "‹ all projects")}
        <nav aria-label="project views">
          {tabs.map((tab) => <span key={tab}>{link(hrefOf(route.id, tab), tab, tab === route.tab)}</span>)}
        </nav>
      </div>
      {project?.path && <p className="projects-note projects-path" title={project.path}>{project.path}</p>}
      {route.tab === "memory"
        ? <MemoryTab key={route.id} client={client} projectId={route.id} control={borrow} projectName={name} actions={actions} refresh={actions?.refresh ?? 0} />
        : <InboxTab key={route.id} client={client} projectId={route.id} control={borrow} names={lookup.names} />}
    </div>
  </ModuleFrame>;
}

type Lookup = { names: ReadonlyMap<string, ProjectRow>; state: "found" | "reading" | "missing" | "unknown" };

/** Names from every loaded list page, plus a bounded search for the selected project when it is not loaded yet. */
function useProjectLookup(client: ZetaClient, id: string | null, listed: ProjectRow[], refresh?: number): Lookup {
  const [searched, setSearched] = useState<{ id: string; rows: ProjectRow[]; state: Lookup["state"] } | null>(null);
  const names = new Map<string, ProjectRow>();
  for (const row of [...(searched?.rows ?? []), ...listed]) names.set(row.id, row);
  const known = id !== null && names.has(id);
  useEffect(() => {
    if (id === null || known || searched?.id === id) return;
    const abort = new AbortController();
    void (async () => {
      const rows: ProjectRow[] = [];
      let cursor: string | null = null;
      try {
        for (let n = 0; n < NAME_PAGES; n++) {
          const page = await readProjects(client, cursor, { signal: abort.signal });
          rows.push(...page.rows);
          cursor = page.nextCursor;
          if (cursor === null || page.rows.some((row) => row.id === id)) break;
        }
      } catch { return; } // failed or cut short by a borrow: it stays "reading" and runs again on the next client
      if (abort.signal.aborted) return;
      setSearched({ id, rows, state: rows.some((row) => row.id === id) ? "found" : cursor === null ? "missing" : "unknown" });
    })();
    return () => abort.abort();
  }, [id, known, client, refresh]);
  return { names, state: known ? "found" : id !== null && searched?.id === id ? searched.state : "reading" };
}

type Pages<T> = { state: "loading" } | { state: "failed"; problem: Problem; retry: () => void }
  | { state: "data"; rows: T[]; more: (() => void) | null; loadingMore: boolean; moreProblem: Problem | null; oldFormat: boolean };

/** The first page on mount and "load more" by cursor; a new `deps` value starts over. Only visible pages are read. */
function usePages<T extends { id: string }>(client: ZetaClient, load: (client: ZetaClient, cursor: string | null, signal: AbortSignal) => Promise<Page<T> & Partial<Pick<MemoryPage, "oldFormat">>>, deps: unknown[], enabled = true): Pages<T> {
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{ rows: T[]; cursor: string | null; oldFormat: boolean } | Problem | null>(null);
  const [more, setMore] = useState<"idle" | "loading" | Problem>("idle");
  const live = useRef<AbortController | null>(null);
  // `client` is not a dependency: a borrow of control swaps the socket, and the same rows stay valid. The swap closes
  // the old socket, so a read it cut short stays loading and runs again on the next client.
  const current = useRef(client);
  const resume = useRef<(() => void) | null>(null);
  useEffect(() => { current.current = client; const run = resume.current; resume.current = null; run?.(); }, [client]);
  const read = (cursor: string | null, abort: AbortController, done: (page: Awaited<ReturnType<typeof load>>) => void, failed: (problem: Problem) => void) => {
    const reader = current.current;
    load(reader, cursor, abort.signal).then((page) => { if (!abort.signal.aborted) done(page); }, (error) => {
      if (abort.signal.aborted) return;
      if (error instanceof ZetaError && error.kind === "closed") {
        const again = () => { if (!abort.signal.aborted) read(cursor, abort, done, failed); };
        if (current.current !== reader) again(); else resume.current = again;
        return;
      }
      const problem = problemOf(error);
      failed(problem === "observer" ? { message: "zeta refused this read", retry: false } : problem);
    });
  };
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    live.current = abort;
    setView(null);
    setMore("idle");
    read(null, abort, (page) => setView({ rows: page.rows, cursor: page.nextCursor, oldFormat: page.oldFormat === true }), setView);
    return () => abort.abort();
  }, [...deps, attempt, enabled]);
  if (!view) return { state: "loading" };
  if (!("rows" in view)) return { state: "failed", problem: view, retry: () => setAttempt((n) => n + 1) };
  const cursor = view.cursor;
  const loadMore = cursor === null ? null : () => {
    const abort = live.current;
    if (!abort || more === "loading") return;
    setMore("loading");
    read(cursor, abort, (page) => {
      // live pages can shift between requests: keep the first row seen for each key.
      setView((current) => current && "rows" in current ? { rows: [...current.rows, ...page.rows.filter((row) => !current.rows.some(({ id }) => id === row.id))], cursor: page.nextCursor, oldFormat: current.oldFormat || page.oldFormat === true } : current);
      setMore("idle");
    }, setMore);
  };
  return { state: "data", rows: view.rows, more: loadMore, loadingMore: more === "loading", moreProblem: typeof more === "object" ? more : null, oldFormat: view.oldFormat };
}

function Paged<T extends { id: string }>({ view, noun, empty, children }: { view: Pages<T>; noun: string; empty: string; children: (rows: T[]) => ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const firstNew = useRef<number | null>(null);
  const rows = view.state === "data" ? view.rows : [];
  // "load more" unmounts after the last page: focus moves to the first new row, never to the page.
  useEffect(() => {
    const row = firstNew.current === null ? undefined : rows[firstNew.current];
    if (!row) return;
    firstNew.current = null;
    list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.id)}"]`)?.closest<HTMLElement>("a, li")?.focus();
  }, [rows.length]);
  if (view.state === "loading") return <ModuleState kind="loading" title={`reading ${noun}…`} />;
  if (view.state === "failed") return <ModuleState kind="failed" title={`could not read ${noun}: ${view.problem.message}`} action={view.problem.retry ? { label: "retry", run: view.retry } : undefined} />;
  if (!view.rows.length) return <ModuleState kind="empty" title={`no ${noun}`} detail={empty} />;
  const more = view.more;
  return <div ref={list} className="projects-paged">
    {children(view.rows)}
    {more && <div className="projects-more">
      <button type="button" aria-disabled={view.loadingMore} onClick={() => { firstNew.current = rows.length; more(); }}>{view.loadingMore ? "loading more…" : "load more"}</button>
      {view.moreProblem && <span role="alert">could not load more: {view.moreProblem.message}</span>}
    </div>}
  </div>;
}

const kindLabel = (kind: MemoryKind) => kind === "legacy" ? "documents" : kind;

/** Shown only where a reveal button is: there is no control to take elsewhere. */
const ControlNote = ({ control, shown }: { control: Borrow; shown: boolean }) => control.observer && shown
  ? <p id={CONTROL_NOTE} className="projects-note">zeta lets only the tab in control read full text. taking control pauses sending and approvals in other tabs for this read.</p> : null;

function MemoryTab({ client, projectId, projectName, control, actions, refresh }: {
  client: ZetaClient; projectId: string; projectName: string; control: Borrow; actions?: MemoryActions; refresh: number;
}) {
  const view = usePages(client, (reader, cursor, signal) => readMemory(reader, projectId, cursor, { signal }), [projectId, refresh]);
  const oldFormat = view.state === "data" && view.oldFormat;
  const [selection, setSelection] = useState<{ refresh: number; ids: Set<string> }>(() => ({ refresh, ids: new Set() }));
  const selected = selection.refresh === refresh ? selection.ids : new Set<string>();
  const canWrite = !!actions && !oldFormat && memoryWriteAccess(client, !control.observer);
  const waiting = control.borrowing || !!actions?.working;
  const feedback = actions?.feedback?.projectId === projectId ? actions.feedback : null;
  const active = view.state === "data" ? view.rows.filter((row) => selected.has(row.id)) : [];
  const start = (event: MouseEvent<HTMLButtonElement>, action: MemoryAction, rows: MemoryRow[], receipt?: MemoryReceipt) => {
    if (!waiting && canWrite) void actions.start(event.currentTarget, projectId, projectName, action, rows, receipt);
  };
  // format 1 summaries are the files' first lines, usually a markdown heading: show the heading text.
  const summary = (text: string) => (oldFormat ? text.replace(/^#+\s*/, "") : text) || "(empty)";
  return <section className="projects-tab" aria-label="memory" tabIndex={-1} data-memory-tab>
    {feedback && <aside className="projects-notice" tabIndex={-1} data-memory-feedback>
      <div role={feedback.error ? "alert" : "status"}>{feedback.message}</div>
      <div className="projects-actions">
        {feedback.receipt && canWrite && <button type="button" data-write-surface="project.memory.undo" aria-disabled={waiting}
          aria-describedby={control.observer ? "projects-write-note" : undefined}
          onClick={(event) => start(event, "undo", [], feedback.receipt)}>undo this memory change</button>}
        <button type="button" onClick={(event) => { actions?.dismiss(); event.currentTarget.closest<HTMLElement>("[data-memory-tab]")?.focus(); }}>dismiss</button>
      </div>
    </aside>}
    {actions?.working && <p className="projects-note" role="status">preparing or finishing memory review…</p>}
    {canWrite && control.observer && ((view.state === "data" && view.rows.length > 0) || feedback?.receipt) &&
      <p id="projects-write-note" className="projects-note">zeta lets only the tab in control read full text. reviewing a change takes control to read the memory revision. it will not interrupt a chat tab in control.</p>}
    {canWrite && view.state === "data" && view.rows.some((row) => isMemoryId(row.id)) && <div className="projects-selection">
      <span role="status">{active.length} selected{active.length === MAX_RESOLVE ? " · limit reached" : " · select up to 64 to resolve"}</span>
      <button type="button" data-write-surface="project.memory.resolve" aria-disabled={!active.length || waiting}
        aria-describedby={control.observer ? "projects-write-note" : undefined}
        onClick={(event) => { if (active.length) start(event, "resolve", active); }}>review resolve</button>
    </div>}
    <ControlNote control={control} shown={view.state === "data" && !oldFormat && view.rows.some((row) => hasKindText(row.kind))} />
    {view.state === "data" && view.rows.length > 0 && !oldFormat && <p className="projects-note">summaries only · full text loads when you open it, is not cached, and never goes in the address</p>}
    {oldFormat && <aside className="projects-notice" role="status">
      <strong>this project uses the old memory format</strong>
      <p>achilles shows its summaries only. read or edit it with <code>zeta project memory</code>.</p>
    </aside>}
    <Paged view={view} noun="memory" empty="zeta has no memory entries for this project yet.">
      {(rows) => memoryKinds.map((kind) => {
        const group = rows.filter((row) => row.kind === kind);
        return group.length > 0 && <section key={kind} className="projects-group" aria-labelledby={`memory-${kind}`}>
          <h2 id={`memory-${kind}`}>{kindLabel(kind)} <small>{group.length}</small></h2>
          <ul>
            {group.map((row) => <li key={row.id} data-row={row.id} tabIndex={-1}>
              {canWrite && isMemoryId(row.id) ? <div className="projects-memory-row">
                <label className="projects-select-entry">
                  <input type="checkbox" checked={selected.has(row.id)} disabled={waiting || (!selected.has(row.id) && selected.size >= MAX_RESOLVE)}
                    onChange={(event) => {
                      const ids = new Set(selected);
                      if (event.currentTarget.checked) ids.add(row.id); else ids.delete(row.id);
                      setSelection({ refresh, ids });
                    }} />
                  <span>{summary(row.summary)}</span>
                </label>
                {row.automatic && <div className="projects-entry-action"><small>{row.accepted ? "accepted" : "automatic"}</small>
                  {canAcceptMemory(row) && <button type="button" data-write-surface="project.memory.accept" aria-disabled={waiting}
                    aria-describedby={control.observer ? "projects-write-note" : undefined}
                    onClick={(event) => start(event, "accept", [row])}>review accept</button>}
                </div>}
              </div> : <><span>{summary(row.summary)}</span>{row.automatic && <small>automatic</small>}</>}
            </li>)}
          </ul>
          {!oldFormat && hasKindText(kind) && <Reveal id={`${projectId}/${kind}`} noun={`${kind} text`} client={client} control={control}
            load={(reader, signal) => readKindText(reader, projectId, kind, { signal })} />}
        </section>;
      })}
    </Paged>
  </section>;
}

function InboxTab({ client, projectId, control, names }: { client: ZetaClient; projectId: string; control: Borrow; names: ReadonlyMap<string, ProjectRow> }) {
  const view = usePages(client, (reader, cursor, signal) => readInbox(reader, projectId, cursor, { signal }), [projectId]);
  return <section className="projects-tab" aria-label="inbox">
    <ControlNote control={control} shown={view.state === "data" && view.rows.some((row) => row.hasBody)} />
    {view.state === "data" && view.rows.length > 0 && <p className="projects-note">newest first · titles and senders only · a message loads when you open it, is not cached, and never goes in the address</p>}
    <Paged view={view} noun="inbox messages" empty="no messages were sent to this project.">
      {(rows: InboxRow[]) => <ul className="projects-inbox">
        {rows.map((row) => {
          const title = row.summary || "(no title)";
          const sender = names.get(row.sender)?.name ?? row.sender;
          return <li key={row.id} data-row={row.id} tabIndex={-1} data-status={row.status}>
            <small>{row.kind.replace("_", " ")} · {row.status} · <span data-trusted={row.trusted || undefined}>{row.trusted ? "trusted assignment" : "information"}</span></small>
            <h3>{title}</h3>
            <small className="projects-from" title={sender}>from {sender} · {new Date(row.createdNs / 1e6).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</small>
            {row.hasBody && <Reveal id={`${projectId}/${row.id}`} noun="message" context={title} client={client} control={control}
              load={(reader, signal) => readMessage(reader, projectId, row.id, { signal })} />}
          </li>;
        })}
      </ul>}
    </Paged>
  </section>;
}

type Shown = null | { state: "loading" } | { state: "data"; body: Body } | { state: "failed"; problem: Problem } | { state: "refused"; reason: string };
// a body this long gets a second "hide" at its end.
const longBody = (text: string) => text.length > 2000 || text.split("\n").length > 30;

/**
 * One explicit read per click. As an observer, the click borrows control for this one read and gives it back. The
 * text lives only in this instance's state: hiding it or leaving drops it.
 */
function Reveal({ id, noun, context, client, control, load }: { id: string; noun: string; context?: string; client: ZetaClient; control: Borrow; load: (client: ZetaClient, signal: AbortSignal) => Promise<Body> }) {
  // a drop remounts this view: say why the text closed instead of resetting silently.
  const [shown, setShown] = useState<Shown>(() => control.dropped.delete(id) ? { state: "failed", problem: dropped } : null);
  const pending = useRef<AbortController | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const hidden = useRef(false);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (shown && shown.state !== "loading") region.current?.focus();
    else if (!shown && hidden.current) button.current?.focus(); // "hide" unmounts itself: focus the button that shows it again
    hidden.current = false;
  }, [shown]);
  // another reveal's borrow is live: one borrow at a time, so this one waits.
  const waiting = control.borrowing && shown?.state !== "loading";

  async function show() {
    if (shown?.state === "loading" || waiting) return;
    const abort = new AbortController();
    pending.current = abort;
    setShown({ state: "loading" });
    let next: Shown;
    try {
      if (control.observer) {
        const borrowed = await control.withControl((reader) => load(reader, abort.signal));
        next = "refused" in borrowed ? { state: "refused", reason: borrowed.refused } : { state: "data", body: borrowed.value };
      } else next = { state: "data", body: await load(client, abort.signal) };
    } catch (error) {
      if (error instanceof ZetaError && error.kind === "closed") control.dropped.add(id);
      const problem = problemOf(error);
      next = { state: "failed", problem: problem === "observer" ? { message: "this tab is not in control", retry: true } : problem };
    }
    if (!abort.signal.aborted) { control.dropped.delete(id); setShown(next); }
  }

  const label = shown?.state === "loading" ? `reading ${noun}…` : waiting ? "reading…" : control.observer ? `take control and show ${noun}` : `show ${noun}`;
  const hide = <button type="button" aria-label={context ? `hide ${noun}: ${context}` : undefined} onClick={() => { hidden.current = true; setShown(null); }}>hide {noun}</button>;
  return <div className="projects-reveal">
    {shown?.state === "data" ? hide
      : (shown?.state !== "failed" || shown.problem.retry) &&
        <button ref={button} type="button" aria-disabled={shown?.state === "loading" || waiting} aria-label={context && !waiting ? `${label}: ${context}` : undefined}
          aria-describedby={control.observer ? CONTROL_NOTE : undefined} onClick={() => void show()}>{label}</button>}
    {shown?.state === "failed" && <div ref={region} tabIndex={-1} className="projects-region">
      <p role="alert" className="projects-error">could not load the {noun}: {shown.problem.message}</p>
    </div>}
    {shown?.state === "refused" && <div ref={region} tabIndex={-1} className="projects-region">
      <p role="alert" className="projects-error">{shown.reason}</p>
    </div>}
    {shown?.state === "data" && <div ref={region} tabIndex={-1} role="region" aria-label={context ? `${noun}: ${context}` : noun} className="projects-region">
      <p className="projects-note">plain text · never sent to a model</p>
      <pre className="projects-body" tabIndex={0}>{shown.body.text}</pre>
      {shown.body.truncated && <p className="projects-flag">cut short · the rest stays in zeta</p>}
      {longBody(shown.body.text) && hide}
    </div>}
  </div>;
}
