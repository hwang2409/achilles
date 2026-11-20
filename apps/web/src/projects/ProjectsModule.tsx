import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import { hasKindText, memoryKinds, projectReads, readInbox, readKindText, readMemory, readMessage, readProjects, STATE_FEATURE, Unreadable,
  type Body, type InboxRow, type MemoryKind, type MemoryPage, type Page, type ProjectRow } from "./reads";
import "./projects.css";

type Tab = "memory" | "inbox";
type Problem = { message: string; retry: boolean };
const tabs: Tab[] = ["memory", "inbox"];

// /projects, /projects/<id>, /projects/<id>/memory, /projects/<id>/inbox. Ids are zeta project ids, never bodies.
function parse(path: string): { id: string; tab: Tab } | null {
  const [, , id, tab] = path.split("/");
  return id ? { id: decodeURIComponent(id), tab: tab === "inbox" ? "inbox" : "memory" } : null;
}
const hrefOf = (id?: string, tab?: Tab) => id ? `/projects/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}` : "/projects";

function problemOf(error: unknown): Problem | "observer" {
  if (error instanceof Unreadable) return { message: "zeta sent data this view cannot read", retry: true };
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32008) return "observer";
  if (code === -32602) return { message: "it no longer exists", retry: false };
  if (code === -32007) return { message: "it is too large to show", retry: false };
  if (code === -32000) return { message: "zeta found this project's stored state invalid. check it with `zeta project show`.", retry: false };
  if (code === -32005 || code === -32009 || code === -32004) return { message: "zeta is busy or the state changed while reading", retry: true };
  return { message: "zeta could not read it", retry: true };
}

export function ProjectsModule({ client, takeControl }: { client: ZetaClient; takeControl: () => Promise<string | null> }) {
  // read the address here, not from the router: a take-control remounts this module after pushState changed it.
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
  const projects = usePages((cursor, signal) => readProjects(client, cursor, { signal }), [client], projectReads(client));
  if (!projectReads(client)) return <ModuleFrame title="projects">
    <ModuleState kind="unsupported" title="projects need a newer zeta" detail={`achilles reads projects through ${STATE_FEATURE}. the zeta that achilles talks to did not offer it. chats, pages and the library still work.`}
      action={{ label: "check again", run: () => location.reload() }} />
  </ModuleFrame>;
  const route = parse(path);
  const link = (href: string, children: ReactNode, current?: boolean) =>
    <a href={surfaceHref(href)} aria-current={current ? "page" : undefined} onClick={(event) => go(event, href)}>{children}</a>;
  if (!route) return <ModuleFrame title="projects">
    <div className="projects">
      <Paged view={projects} noun="projects" empty="no projects yet. zeta creates one when a chat opens in a git folder.">
        {(rows) => <ul className="projects-list">
          {rows.map((row) => <li key={row.id}>{link(hrefOf(row.id), <>
            <strong>{row.name}</strong>
            <span>{row.path ?? "no folder"}</span>
            <small>{row.sessions} sessions · {row.memory} memory · {row.inbox.new} new in inbox</small>
          </>)}</li>)}
        </ul>}
      </Paged>
    </div>
  </ModuleFrame>;
  const rows = projects.state === "data" ? projects.rows : [];
  const project = rows.find(({ id }) => id === route.id);
  const name = project?.name ?? route.id;
  return <ModuleFrame title={`projects / ${name}`}>
    <div className="projects">
      <div className="projects-bar">
        {link(hrefOf(), "‹ all projects")}
        <nav aria-label="project views">
          {tabs.map((tab) => <span key={tab}>{link(hrefOf(route.id, tab), tab, tab === route.tab)}</span>)}
        </nav>
      </div>
      {project?.path && <p className="projects-note">{project.path}</p>}
      {route.tab === "memory"
        ? <MemoryTab key={route.id} client={client} projectId={route.id} takeControl={takeControl} />
        : <InboxTab key={route.id} client={client} projectId={route.id} takeControl={takeControl} senders={rows} />}
    </div>
  </ModuleFrame>;
}

type Pages<T> = { state: "loading" } | { state: "failed"; problem: Problem; retry: () => void }
  | { state: "data"; rows: T[]; more: (() => void) | null; loadingMore: boolean; moreProblem: Problem | null; oldFormat: boolean };

/** The first page on mount and "load more" by cursor; a new `deps` value starts over. Only visible pages are read. */
function usePages<T extends { id: string }>(load: (cursor: string | null, signal: AbortSignal) => Promise<Page<T> & Partial<Pick<MemoryPage, "oldFormat">>>, deps: unknown[], enabled = true): Pages<T> {
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{ rows: T[]; cursor: string | null; oldFormat: boolean } | Problem | null>(null);
  const [more, setMore] = useState<"idle" | "loading" | Problem>("idle");
  const live = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    live.current = abort;
    setView(null);
    setMore("idle");
    load(null, abort.signal).then((page) => !abort.signal.aborted && setView({ rows: page.rows, cursor: page.nextCursor, oldFormat: page.oldFormat === true }),
      (error) => { if (!abort.signal.aborted) { const problem = problemOf(error); setView(problem === "observer" ? { message: "zeta refused this read", retry: false } : problem); } });
    return () => abort.abort();
  }, [...deps, attempt, enabled]);
  if (!view) return { state: "loading" };
  if (!("rows" in view)) return { state: "failed", problem: view, retry: () => setAttempt((n) => n + 1) };
  const cursor = view.cursor;
  const loadMore = cursor === null ? null : () => {
    const abort = live.current;
    if (!abort || more === "loading") return;
    setMore("loading");
    load(cursor, abort.signal).then((page) => {
      if (abort.signal.aborted) return;
      // live pages can shift between requests: keep the first row seen for each key.
      setView((current) => current && "rows" in current ? { rows: [...current.rows, ...page.rows.filter((row) => !current.rows.some(({ id }) => id === row.id))], cursor: page.nextCursor, oldFormat: current.oldFormat || page.oldFormat === true } : current);
      setMore("idle");
    }, (error) => { if (!abort.signal.aborted) { const problem = problemOf(error); setMore(problem === "observer" ? { message: "zeta refused this read", retry: false } : problem); } });
  };
  return { state: "data", rows: view.rows, more: loadMore, loadingMore: more === "loading", moreProblem: typeof more === "object" ? more : null, oldFormat: view.oldFormat };
}

function Paged<T>({ view, noun, empty, children }: { view: Pages<T>; noun: string; empty: string; children: (rows: T[]) => ReactNode }) {
  if (view.state === "loading") return <ModuleState kind="loading" title={`reading ${noun}…`} />;
  if (view.state === "failed") return <ModuleState kind="failed" title={`could not read ${noun}: ${view.problem.message}`} action={view.problem.retry ? { label: "retry", run: view.retry } : undefined} />;
  if (!view.rows.length) return <ModuleState kind="empty" title={`no ${noun}`} detail={empty} />;
  return <>
    {children(view.rows)}
    {view.more && <div className="projects-more">
      <button type="button" aria-disabled={view.loadingMore} onClick={view.more}>{view.loadingMore ? "loading more…" : "load more"}</button>
      {view.moreProblem && <span role="alert">could not load more: {view.moreProblem.message}</span>}
    </div>}
  </>;
}

const kindLabel = (kind: MemoryKind) => kind === "legacy" ? "documents" : kind;

function MemoryTab({ client, projectId, takeControl }: { client: ZetaClient; projectId: string; takeControl: () => Promise<string | null> }) {
  const view = usePages((cursor, signal) => readMemory(client, projectId, cursor, { signal }), [client, projectId]);
  const oldFormat = view.state === "data" && view.oldFormat;
  return <section className="projects-tab" aria-label="memory">
    {!oldFormat && <p className="projects-note">summaries only · full text loads when you open it, is not cached, and never goes in the address</p>}
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
            {group.map((row) => <li key={row.id}><span>{row.summary || "(empty)"}</span>{row.automatic && <small>automatic</small>}</li>)}
          </ul>
          {!oldFormat && hasKindText(kind) && <Reveal noun={`${kind} text`} label={kind} takeControl={takeControl}
            load={(signal) => readKindText(client, projectId, kind, { signal })} />}
        </section>;
      })}
    </Paged>
  </section>;
}

function InboxTab({ client, projectId, takeControl, senders }: { client: ZetaClient; projectId: string; takeControl: () => Promise<string | null>; senders: ProjectRow[] }) {
  const view = usePages((cursor, signal) => readInbox(client, projectId, cursor, { signal }), [client, projectId]);
  const from = (sender: string) => senders.find(({ id }) => id === sender)?.name ?? sender;
  return <section className="projects-tab" aria-label="inbox">
    <p className="projects-note">newest first · titles and senders only · a message loads when you open it, is not cached, and never goes in the address</p>
    <Paged view={view} noun="inbox messages" empty="no messages were sent to this project.">
      {(rows: InboxRow[]) => <ul className="projects-inbox">
        {rows.map((row) => <li key={row.id} data-status={row.status}>
          <small>{row.kind.replace("_", " ")} · {row.status} · <span data-trusted={row.trusted || undefined}>{row.trusted ? "trusted assignment" : "information"}</span></small>
          <strong>{row.summary || "(no title)"}</strong>
          <small>from {from(row.sender)} · {new Date(row.createdNs / 1e6).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</small>
          {row.hasBody && <Reveal noun="message" label={row.summary} takeControl={takeControl}
            load={(signal) => readMessage(client, projectId, row.id, { signal })} />}
        </li>)}
      </ul>}
    </Paged>
  </section>;
}

type Shown = null | { state: "loading" } | { state: "data"; body: Body } | { state: "failed"; problem: Problem } | { state: "observer" };

/** One explicit read per click. The text lives only in this instance's state: hiding it or leaving drops it. */
function Reveal({ noun, label, load, takeControl }: { noun: string; label: string; load: (signal: AbortSignal) => Promise<Body>; takeControl: () => Promise<string | null> }) {
  const [shown, setShown] = useState<Shown>(null);
  const [taking, setTaking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const refusalId = useId();
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => { if (shown && shown.state !== "loading") region.current?.focus(); }, [shown]);

  async function show() {
    if (shown?.state === "loading") return;
    const abort = new AbortController();
    pending.current = abort;
    setShown({ state: "loading" });
    let next: Shown;
    try {
      next = { state: "data", body: await load(abort.signal) };
    } catch (error) {
      const problem = problemOf(error);
      next = problem === "observer" ? { state: "observer" } : { state: "failed", problem };
    }
    if (!abort.signal.aborted) setShown(next);
  }

  async function control() {
    setTaking(true);
    setRefusal(null);
    // on success the socket is replaced and this view reloads as the controller; open the text again there.
    const reason = await takeControl();
    setTaking(false);
    setRefusal(reason);
  }

  return <div className="projects-reveal">
    {shown?.state === "data" ? <button type="button" onClick={() => setShown(null)}>hide {noun}</button>
      : shown?.state !== "observer" && (!shown || shown.state === "loading" || shown.problem.retry) &&
        <button type="button" aria-disabled={shown?.state === "loading"} onClick={() => void show()}>
          {shown?.state === "loading" ? `reading ${noun}…` : shown ? "retry" : `show ${noun}`}
        </button>}
    {shown?.state === "failed" && <div ref={region} tabIndex={-1} className="projects-region">
      <p role="alert" className="projects-error">could not load the {noun}: {shown.problem.message}</p>
    </div>}
    {shown?.state === "observer" && <div ref={region} tabIndex={-1} className="projects-notice">
      <strong>the {noun} needs control of zeta</strong>
      <p>this tab is connected as an observer. observers see summaries and titles, not full text. take control to read it here.</p>
      <div className="projects-actions">
        <button type="button" aria-disabled={taking} aria-describedby={refusal ? refusalId : undefined} onClick={() => void control()}>{taking ? "taking control…" : "take control"}</button>
        <button type="button" onClick={() => setShown(null)}>close</button>
      </div>
      {refusal && <p id={refusalId} role="status">{refusal}</p>}
    </div>}
    {shown?.state === "data" && <div ref={region} tabIndex={-1} role="region" aria-label={`${label} ${noun}`} className="projects-region">
      <p className="projects-note">untrusted text · shown as plain text, never sent to a model</p>
      <pre className="projects-body">{shown.body.text}</pre>
      {shown.body.truncated && <p className="projects-flag">cut short · the rest stays in zeta</p>}
    </div>}
  </div>;
}
