import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createRunStore } from "@fulcrum/core";
import { RunProvider, Timeline } from "@fulcrum/react";
import { fromZetaHistory, type ZetaClient } from "@fulcrum/zeta";
import { EnumListbox } from "../page/EnumListbox";
import { chatHref, timeLabel, type Chat } from "../surface/AgentNavAdapter";
import { ModuleState, ShellDockSlot } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import { createSessionsReader, readError, ReadLimit, type AttentionItem, type Collection, type SessionRow, type SessionsReader, type Transcript } from "./reads";
import { sessionOwned } from "../chat/continuation";
import { WRITE_SURFACE } from "../writeSurfaces";
import "./sessions.css";

type ContinueSession = (id: string, signal: AbortSignal) => Promise<string | null>;

const stamp = (time: number) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const short = (id: string) => id.length > 10 ? id.slice(0, 8) + "…" : id;
type View = "detail" | "transcript" | "attention";
const views: readonly string[] = ["transcript", "attention"];
const href = (id?: string, view: View = "detail") => surfaceHref(`/sessions${id ? `/${encodeURIComponent(id)}` : ""}${view === "detail" ? "" : `/${view}`}`);
function selection() {
  const [, , id, sub, ...extra] = location.pathname.split("/");
  const view: View = sub && views.includes(sub) ? sub as View : "detail";
  try { return { id: id ? decodeURIComponent(id) : undefined, view, invalid: !!extra.length || (!!sub && !views.includes(sub)) }; }
  catch { return { id: undefined, view: "detail" as View, invalid: true }; }
}

function useRead<T>(load: ((signal: AbortSignal) => Promise<T>) | undefined, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [refreshing, setRefreshing] = useState(!!load);
  const [version, refresh] = useState(0);
  useEffect(() => {
    if (!load) { setRefreshing(false); return; }
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      setRefreshing(true);
      try {
        const result = await load(signal);
        if (!signal.aborted) { setData(result); setError(undefined); }
      } catch (e) {
        if (!signal.aborted) setError(e);
      } finally {
        if (!signal.aborted) {
          setRefreshing(false);
          if (interval) timer = setTimeout(() => { if (!document.hidden) void run(); else scheduleVisible(); }, interval);
        }
      }
    };
    const scheduleVisible = () => document.addEventListener("visibilitychange", onVisible);
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onVisible);
      void run();
    };
    void run();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [load, interval, version]);
  return { data, error, refreshing, refresh: () => refresh((n) => n + 1) };
}

// never-sent achilles chats, hidden here as in the sidebar; a failed read hides nothing
async function loadUnsent(signal: AbortSignal) {
  try {
    const response = await fetch("/api/chats/unsent", { cache: "no-store", signal });
    const ids: unknown = response.ok ? (await response.json()).session_ids : undefined;
    return new Set(Array.isArray(ids) ? ids.filter((one): one is string => typeof one === "string") : []);
  } catch { return new Set<string>(); }
}

// zeta reports "unknown" for a session an idle or busy tui or serve process holds; it cannot see that turn
function StateTag({ state, held }: { state: SessionRow["status"]; held: boolean }) {
  if (state === "unknown" && held) return <span className="sessions-state" data-status="elsewhere" title="held by another zeta process (tui or serve)">open elsewhere</span>;
  return <span className="sessions-state" data-status={state}>{state === "approval" ? "needs you" : state}</span>;
}

export function SessionsModule({ client, connecting, retry, newChat, chats, continueSession, advertised }: {
  client: ZetaClient | null; connecting: boolean; retry: () => void; newChat: () => void; chats: readonly Chat[]; continueSession: ContinueSession;
  /** which request methods zeta advertised; tests inject it, the app uses the negotiated hello */
  advertised?: (method: string) => boolean;
}) {
  const reader = useMemo(() => client ? createSessionsReader(client, advertised) : undefined, [client, advertised]);
  const { data, error, refreshing, refresh } = useRead(reader?.catalog, 30000);
  const unsent = useRead(loadUnsent, 30000).data;
  const [{ id, view, invalid }, setSelection] = useState(selection);
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());
  const search = useRef<HTMLInputElement>(null);
  const detail = useRef<HTMLElement>(null);
  const restore = useRef<string | undefined>(undefined);
  const focus = useRef(false);
  useEffect(() => {
    const onPop = () => { focus.current = true; setSelection(selection()); };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const follow = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    if (event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.defaultPrevented) return;
    event.preventDefault();
    if (url === location.pathname + location.search) return;
    history.pushState(null, "", url);
    focus.current = true;
    setSelection(selection());
  };
  useLayoutEffect(() => {
    if (focus.current) {
      focus.current = false;
      if (id) detail.current?.querySelector<HTMLAnchorElement>(".sessions-back")?.focus();
      else (restore.current && rowRefs.current.get(restore.current) || search.current)?.focus();
    }
    if (id) restore.current = id;
  }, [id, view]);

  const rows = data?.items ?? [];
  const row = rows.find((one) => one.id === id);
  const owned = new Set(chats.map((chat) => chat.session_id));
  return <section className="module-frame sessions-frame">
    <header className="sessions-head ui-page-header">
      <h1>Sessions</h1>
      <button type="button" className="sessions-new ui-button" onClick={newChat} disabled={!client}>New chat</button>
    </header>
    <ShellDockSlot />
    {!data ? <div className="module-body">
      {!client ? connecting ? <ModuleState kind="loading" title="connecting to zeta" /> : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: retry }} />
        : error && !refreshing ? <ModuleState kind="failed" title="could not load sessions" detail={readError(error)} action={{ label: "retry now", run: refresh }} />
        : <ModuleState kind="loading" title="loading sessions" />}
    </div> : <>
      {!client && <p className="sessions-notice" role="status">zeta is offline · showing data from {stamp(data.reportedAt)} <button type="button" onClick={retry}>retry now</button></p>}
      <div className="sessions-split" data-detail={!!id || invalid}>
        <SessionCatalog result={{ data, error, refreshing, refresh }} online={!!client} id={id} owned={owned} unsent={unsent} search={search} rowRefs={rowRefs} follow={follow} />
        <DetailPane id={id} row={row} view={view} invalid={invalid} complete={data.complete} reader={reader}
          chat={row && chats.find((chat) => chat.session_id === row.id)} detail={detail} follow={follow} continueSession={continueSession} />
      </div>
    </>}
  </section>;
}

type Follow = (event: MouseEvent<HTMLAnchorElement>, url: string) => void;
type CatalogResult = ReturnType<typeof useRead<Awaited<ReturnType<SessionsReader["catalog"]>>>>;
function SessionCatalog({ result, online, id, owned, unsent, search, rowRefs, follow }: {
  result: CatalogResult & { data: NonNullable<CatalogResult["data"]> }; online: boolean; id?: string; owned: Set<string>; unsent?: Set<string>;
  search: RefObject<HTMLInputElement | null>; rowRefs: RefObject<Map<string, HTMLAnchorElement>>; follow: Follow;
}) {
  const { data, error, refreshing, refresh } = result;
  const rows = data.items.filter((one) => one.id === id || !!one.preview || !unsent?.has(one.id));
  const [query, setQuery] = useState("");
  const [projectFilter, setProject] = useState("any");
  const [statusFilter, setStatus] = useState("any");
  const projectName = (value: SessionRow["project"]) => value === null ? "no project" : value;
  const projects = [...new Set(rows.map((one) => projectName(one.project)).filter((p): p is string => p !== undefined))].sort();
  const states = [...new Set(rows.filter((one) => one.state).map((one) => one.status === "approval" ? "needs you" : one.status))].sort();
  const filter = query.trim().toLowerCase();
  const shown = rows.filter((one) => (!filter || one.title.toLowerCase().includes(filter) || one.preview?.toLowerCase().includes(filter) || one.id.toLowerCase() === filter) &&
    (projectFilter === "any" || projectName(one.project) === projectFilter) &&
    (statusFilter === "any" || (one.status === "approval" ? "needs you" : one.status) === statusFilter));
  return <section className="sessions-catalog" aria-label="session catalog">
    <div className="sessions-filters">
      <input ref={search} type="search" aria-label="search sessions by title, first message or id" placeholder="⌕ title, first message or id" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div>
        {!!projects.length && <EnumListbox label="project" value={projectFilter} options={["any", ...projects]} onChange={setProject} />}
        {!!states.length && <EnumListbox label="state" value={statusFilter} options={["any", ...states]} onChange={setStatus} />}
        <button type="button" disabled={!online || refreshing} onClick={refresh}>refresh now</button>
      </div>
    </div>
    {online && (refreshing || !!error) && <p className="sessions-notice" role="status">{refreshing ? "refreshing…" : `showing data from ${stamp(data.reportedAt)} · refresh failed · ${readError(error)}`}</p>}
    {data.warnings.map((warning) => <p key={warning} className="sessions-notice" role="status">{data.staleState !== undefined ? `showing state from ${stamp(data.staleState)} · refresh failed · ` : ""}{warning}</p>)}
    {data.omitted > 0 && <p className="sessions-notice" role="status">{data.omitted} malformed {data.omitted === 1 ? "row" : "rows"} omitted</p>}
    {!shown.length ? <ModuleState kind="empty" title={rows.length ? "no matching sessions" : data.complete ? "no sessions yet" : "no sessions in this view"}
      detail={rows.length ? "search for a title, first message or full id, or clear the filters." : data.complete ? "sessions appear here after zeta saves them." : "the catalog is incomplete."}
      action={rows.length ? { label: "clear filters", run: () => { setQuery(""); setProject("any"); setStatus("any"); search.current?.focus(); } } : undefined} /> : <>
      <div className="sessions-row sessions-labels" aria-hidden="true"><span>session</span><span>from</span><span>state</span><span>last</span></div>
      <ul className="sessions-rows">{shown.map((one) => <li key={one.id}>
        <a className="sessions-row" ref={(node) => { if (node) rowRefs.current.set(one.id, node); else rowRefs.current.delete(one.id); }}
          href={href(one.id)} aria-current={one.id === id ? "page" : undefined} onClick={(event) => follow(event, href(one.id))}>
          <span><strong title={one.title}>{one.title}</strong><small>{!!one.state?.attention && <><span className="sessions-row-attention">{one.state.attention} open<span className="sessions-visually-hidden">
            {one.state.attention === 1 ? " decision" : " decisions"}</span></span> · </>}{[one.project, short(one.id)].filter(Boolean).join(" · ")}</small></span>
          <span>{owned.has(one.id) ? "achilles" : ""}</span><StateTag state={one.status} held={one.inUse} />
          <span>{one.updated && <time dateTime={one.updated}>{timeLabel(one.updated)}</time>}</span>
        </a>
      </li>)}</ul>
    </>}
  </section>;
}

function DetailPane({ id, row, view, invalid, complete, reader, chat, detail, follow, continueSession }: {
  id?: string; row?: SessionRow; view: View; invalid: boolean; complete: boolean; reader?: SessionsReader;
  chat?: Chat; detail: RefObject<HTMLElement | null>; follow: Follow; continueSession: ContinueSession;
}) {
  const back = view === "detail" ? href() : href(id);
  return <section className="sessions-detail" ref={detail} tabIndex={-1} aria-label={view === "detail" ? "session detail" : `session ${view}`}>
    {(id || invalid) && <a className="sessions-back" href={back} onClick={(event) => follow(event, back)}>
      {view === "detail" ? "← sessions" : "← session detail"}
    </a>}
    {invalid ? <ModuleState kind="failed" title="invalid session link" /> : row ? <SessionDetail key={row.id} row={row} reader={reader} view={view}
      chat={chat} follow={follow} continueSession={continueSession} /> : id ? <ModuleState kind="empty" title="session not in this catalog" detail={complete ? "it may have been removed." : "the catalog is incomplete."} />
      : <ModuleState kind="empty" title="select a session" />}
  </section>;
}

function SessionDetail({ row, reader, view, chat, follow, continueSession }: {
  row: SessionRow; reader?: SessionsReader; view: View; chat?: Chat; follow: Follow; continueSession: ContinueSession;
}) {
  const owned = !!chat;
  const [copied, setCopied] = useState("");
  const detailView = view === "detail";
  const access = useMemo(() => reader && detailView ? (signal: AbortSignal) => reader.transcriptMode(row, signal) : undefined, [reader, row.id, row.project, detailView]);
  const mode = useRead(access, 30000);
  const agents = useCollection(reader, row, "agents", detailView);
  const tasks = useCollection(reader, row, "background_tasks", detailView);
  const snapshot = [agents.data, tasks.data].filter((data) => !!data).sort((a, b) => b.reportedAt - a.reportedAt)[0]?.state ?? row.state;
  const state = snapshot?.status ?? "unknown";
  const transcriptHref = href(row.id, "transcript");
  const attentionHref = href(row.id, "attention");
  const fields = (values: (readonly [string, ReactNode])[]) => values.filter(([, value]) => value !== undefined);
  return <>
    <div className="sessions-title"><h2>{row.title}</h2><p><StateTag state={state} held={row.inUse} />{owned && " · achilles"}{row.project && <> · project {row.project}</>}</p></div>
    <ContinueAction row={row} online={!!reader} run={continueSession} />
    {view === "transcript" ? <SessionTranscript row={row} reader={reader} /> : view === "attention" ? <SessionAttention row={row} reader={reader} /> : <>
      <dl className="sessions-fields">{fields([
        ["session id", <><code title={row.id}>{short(row.id)}</code> <button className="sessions-copy" type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(row.id); setCopied("copied"); } catch { setCopied("could not copy"); }
        }}>copy</button><span role="status">{copied}</span></>],
        ["project", row.project === null ? "no project" : row.project], ["parent session", row.parent || undefined],
        ["model", [row.model, row.provider].filter(Boolean).join(" · ") || undefined], ["profile", snapshot?.profile], ["working directory", row.cwd],
        ["started · last", [row.created, row.updated].filter((v): v is string => !!v).map((v) => timeLabel(v)).join(" · ") || undefined],
        ["child agents", snapshot?.children], ["background tasks", snapshot?.tasks], ["attention", snapshot && (reader?.attention && snapshot.attention > 0
          ? <a className="sessions-attention-link" href={attentionHref} onClick={(event) => follow(event, attentionHref)}>{snapshot.attention} open</a> : snapshot.attention)], ["first message", row.preview],
      ]).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {reader && mode.data && !mode.error ? <a className="sessions-transcript-action sessions-transcript-secondary" href={transcriptHref} onClick={(event) => follow(event, transcriptHref)}>read transcript</a>
        : <><button type="button" className="sessions-transcript-action" disabled>read transcript</button>
          <p className="sessions-help" role="status">{!reader ? "connect to zeta to read the transcript" : mode.error ? readError(mode.error) : "checking transcript access…"}</p></>}
      <div className="sessions-collections"><CollectionView label="child agents" result={agents} /><CollectionView label="background tasks" result={tasks}
        // zeta lists and cancels a task only for the tab that holds its chat (run_work), never from this page
        footer={chat && tasks.data?.items.some((item) => item.status === "running") && <a href={chatHref(chat)}>open the chat to cancel</a>} /></div>
    </>}
  </>;
}

function ContinueAction({ row, online, run }: { row: SessionRow; online: boolean; run: ContinueSession }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => () => attempt.current?.abort(), []);
  const reason = pending ? "opening this session in chat…" : row.parent != null
    ? "child sessions cannot continue as top-level chats. open the parent session instead."
    : row.inUse && !row.resident ? sessionOwned : !online ? "connect to zeta to continue this session in chat." : null;
  const start = async () => {
    if (reason || attempt.current) return;
    const current = new AbortController();
    attempt.current = current;
    setPending(true);
    setError(null);
    const failure = await run(row.id, current.signal);
    if (current.signal.aborted || !failure) return;
    attempt.current = null;
    setPending(false);
    setError(failure);
    button.current?.focus();
  };
  return <div className="sessions-continue">
    <button ref={button} type="button" className="sessions-transcript-action" data-write-surface={WRITE_SURFACE.sessionsContinue}
      disabled={!!reason && !pending} aria-disabled={pending || undefined} aria-describedby={reason || error ? "sessions-continue-status" : undefined}
      onClick={() => void start()}>{pending ? "continuing…" : "continue in chat"}</button>
    <p className="sessions-help" id="sessions-continue-status" role="status">{reason ?? error}</p>
  </div>;
}

function useCollection(reader: SessionsReader | undefined, row: SessionRow, kind: Collection, visible: boolean) {
  const load = useMemo(() => reader && visible ? (signal: AbortSignal) => reader.collection(row.id, kind, signal) : undefined, [reader, row.id, kind, visible]);
  return useRead(load, row.status === "running" || row.status === "approval" ? 5000 : 30000);
}

function CollectionView({ label, result, footer }: { label: string; result: ReturnType<typeof useCollection>; footer?: ReactNode }) {
  const { data, refreshing, error, refresh } = result;
  return <details className="sessions-collection">
    <summary>{label}{data && ` · ${data.items.length}${data.complete ? "" : " loaded"}`}</summary>
    {refreshing && <p role="status">{data ? "refreshing…" : "loading…"}</p>}
    {!!error && <p role="status">{data && `showing data from ${stamp(data.reportedAt)} · refresh failed · `}{readError(error)} {!(error instanceof ReadLimit) && <button type="button" onClick={refresh}>retry now</button>}</p>}
    {data?.omitted ? <p>{data.omitted} malformed {data.omitted === 1 ? "row" : "rows"} omitted</p> : null}
    {data?.items.length ? <ul>{data.items.map((item) => <li key={item.id}><code title={item.id}>{short(item.id)}</code> {item.label} · {item.status}</li>)}</ul> : data?.complete && <p>none reported</p>}
    {footer && <p>{footer}</p>}
  </details>;
}

function SessionTranscript({ row, reader }: { row: SessionRow; reader?: SessionsReader }) {
  const [previous, setPrevious] = useState<Transcript>();
  const load = useMemo(() => reader ? (signal: AbortSignal) => reader.transcript(row, previous, signal) : undefined, [reader, row.id, row.project, previous]);
  const { data, refreshing, error, refresh } = useRead(load);
  const store = useMemo(() => {
    const projection = createRunStore();
    if (data) for (const event of fromZetaHistory(data.rows)) projection.dispatch(event);
    return projection;
  }, [data]);
  useEffect(() => () => store.dispose(), [store]);
  return <div className="sessions-history">
    <div className="sessions-history-bar"><span>read-only transcript{data && ` · snapshot at ${stamp(data.reportedAt)}`}</span>
      {data && reader && <button type="button" disabled={refreshing} onClick={() => previous ? setPrevious(undefined) : refresh()}>refresh now</button>}</div>
    {!data && reader && !error && <ModuleState kind="loading" title="loading transcript" />}
    {!data && !reader && <ModuleState kind="offline" title="connect to zeta to read the transcript" />}
    {!data && !!error && <ModuleState kind={error instanceof ReadLimit ? "unsupported" : "failed"} title="transcript unavailable" detail={readError(error)} action={error instanceof ReadLimit ? undefined : { label: "retry now", run: refresh }} />}
    {data && <>
      {!refreshing && (!reader || !!error) && <p className="sessions-notice" role="status">showing data from {stamp(data.reportedAt)} · {reader ? `read failed · ${readError(error)}` : "zeta is offline"}</p>}
      {refreshing && <p className="sessions-notice" role="status">reading transcript…</p>}
      {data.omitted > 0 && <p className="sessions-notice" role="status">{data.omitted} malformed {data.omitted === 1 ? "row" : "rows"} omitted</p>}
      {data.restarted && <p className="sessions-notice" role="status">transcript changed · started from a new snapshot</p>}
      {!!data.next && <button className="sessions-more" type="button" disabled={!reader || refreshing} onClick={() => previous === data ? refresh() : setPrevious(data)}>{data.next.kind === "forward" ? "load more messages" : "load older messages"}</button>}
      {data.rows.length ? <div className="transcript sessions-timeline"><RunProvider store={store}><Timeline /></RunProvider></div> : <ModuleState kind="empty" title="no messages" />}
    </>}
  </div>;
}

/** Read-only: zeta serve has no method to reply to or dismiss an item, so the page points to `/decisions`. */
export function SessionAttention({ row, reader }: { row: SessionRow; reader?: SessionsReader }) {
  const read = reader?.attention;
  const load = useMemo(() => read ? (signal: AbortSignal) => read(row, signal) : undefined, [read, row.id, row.project]);
  const { data, refreshing, error, refresh } = useRead(load, 30000);
  return <div className="sessions-attention">
    <div className="sessions-history-bar"><span>read-only attention{data && ` · snapshot at ${stamp(data.reportedAt)}`}</span>
      {data && read && <button type="button" disabled={refreshing} onClick={refresh}>refresh now</button>}</div>
    {!reader ? <ModuleState kind="offline" title="connect to zeta to read attention" />
      : !read ? <ModuleState kind="unsupported" title="attention unavailable" detail="the attention list needs a newer zeta" />
      : !data ? error ? <ModuleState kind={error instanceof ReadLimit ? "unsupported" : "failed"} title="attention unavailable" detail={readError(error)}
          action={error instanceof ReadLimit ? undefined : { label: "retry now", run: refresh }} />
        : <ModuleState kind="loading" title="loading attention" />
      : <>
        {!refreshing && !!error && <p className="sessions-notice" role="status">showing data from {stamp(data.reportedAt)} · read failed · {readError(error)}</p>}
        {data.omitted > 0 && <p className="sessions-notice" role="status">{data.omitted} malformed {data.omitted === 1 ? "item" : "items"} omitted</p>}
        <AttentionGroup title="decisions" hint="open decisions and deferred items" items={data.decisions} empty="no open decisions" />
        <AttentionGroup title="notes" hint="answers and choices made for you" items={data.notes} empty="no notes" />
        <p className="sessions-help">reply to or dismiss these in zeta with /decisions.</p>
      </>}
  </div>;
}

function AttentionGroup({ title, hint, items, empty }: { title: string; hint: string; items: readonly AttentionItem[]; empty: string }) {
  return <section className="sessions-attention-group" aria-label={`${title} · ${items.length}`}>
    <h3>{title} <span>{items.length}</span></h3>
    <p className="sessions-help">{hint}</p>
    {items.length ? <ul>{items.map((item) => <li key={item.id}>
      <span className="sessions-attention-kind" data-kind={item.kind}>{item.kind}</span>
      <span className="sessions-attention-title">{item.title}</span>
      <time dateTime={item.created}>{timeLabel(item.created)}</time>
    </li>)}</ul> : <p className="sessions-attention-empty">{empty}</p>}
  </section>;
}
