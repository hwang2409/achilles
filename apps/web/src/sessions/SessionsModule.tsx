import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createRunStore } from "@fulcrum/core";
import { RunProvider, Timeline } from "@fulcrum/react";
import { fromZetaHistory, type ZetaClient } from "@fulcrum/zeta";
import { EnumListbox } from "../page/EnumListbox";
import { timeLabel, type Chat } from "../surface/AgentNavAdapter";
import { ModuleState, ShellDockSlot } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import { createSessionsReader, readError, ReadLimit, type Collection, type SessionRow, type SessionsReader, type Transcript } from "./reads";
import "./sessions.css";

const stamp = (time: number) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }).toLowerCase();
const short = (id: string) => id.length > 10 ? id.slice(0, 8) + "…" : id;
const href = (id?: string, transcript = false) => surfaceHref(`/sessions${id ? `/${encodeURIComponent(id)}` : ""}${transcript ? "/transcript" : ""}`);
function selection() {
  const [, , id, sub, ...extra] = location.pathname.split("/");
  try { return { id: id ? decodeURIComponent(id) : undefined, transcript: sub === "transcript", invalid: !!extra.length || (!!sub && sub !== "transcript") }; }
  catch { return { id: undefined, transcript: false, invalid: true }; }
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

function StateTag({ state }: { state: SessionRow["status"] }) {
  return <span className="sessions-state" data-status={state}>{state === "approval" ? "needs you" : state}</span>;
}

export function SessionsModule({ client, connecting, retry, newChat, chats }: {
  client: ZetaClient | null; connecting: boolean; retry: () => void; newChat: () => void; chats: readonly Chat[];
}) {
  const reader = useMemo(() => client ? createSessionsReader(client) : undefined, [client]);
  const { data, error, refreshing, refresh } = useRead(reader?.catalog, 30000);
  const [{ id, transcript, invalid }, setSelection] = useState(selection);
  const [query, setQuery] = useState("");
  const [projectFilter, setProject] = useState("any");
  const [statusFilter, setStatus] = useState("any");
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
  }, [id, transcript]);

  const rows = data?.items ?? [];
  const row = rows.find((one) => one.id === id);
  const projectName = (value: SessionRow["project"]) => value === null ? "no project" : value;
  const projects = [...new Set(rows.map((one) => projectName(one.project)).filter((p): p is string => p !== undefined))].sort();
  const states = [...new Set(rows.filter((one) => one.state).map((one) => one.status === "approval" ? "needs you" : one.status))].sort();
  const filter = query.trim().toLowerCase();
  const shown = rows.filter((one) => (!filter || one.title.toLowerCase().includes(filter) || one.preview?.toLowerCase().includes(filter) || one.id.toLowerCase() === filter) &&
    (projectFilter === "any" || projectName(one.project) === projectFilter) &&
    (statusFilter === "any" || (one.status === "approval" ? "needs you" : one.status) === statusFilter));
  const owned = new Set(chats.map((chat) => chat.session_id));
  const detailHref = href(id);
  const catalogHref = href();
  const continuationLabel = data?.complete ? "" : " loaded";
  return <section className="module-frame sessions-frame">
    <header className="sessions-head">
      <h1>sessions</h1>
      {data && <span>all zeta sessions on this computer · {rows.length}{continuationLabel}</span>}
      <button type="button" className="sessions-new" onClick={newChat} disabled={!client}>+ new chat</button>
    </header>
    <ShellDockSlot />
    {!data ? <div className="module-body">
      {!client ? connecting ? <ModuleState kind="loading" title="connecting to zeta" /> : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: retry }} />
        : error && !refreshing ? <ModuleState kind="failed" title="could not load sessions" detail={readError(error)} action={{ label: "retry now", run: refresh }} />
        : <ModuleState kind="loading" title="loading sessions" />}
    </div> : <>
      {!client && <p className="sessions-notice" role="status">zeta is offline · showing data from {stamp(data.reportedAt)} <button type="button" onClick={retry}>retry now</button></p>}
      <div className="sessions-split" data-detail={!!id || invalid}>
        <section className="sessions-catalog" aria-label="session catalog">
          <div className="sessions-filters">
            <input ref={search} type="search" aria-label="search sessions by title, first message or id" placeholder="⌕ title, first message or id" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div>
              {!!projects.length && <EnumListbox label="project" value={projectFilter} options={["any", ...projects]} onChange={setProject} />}
              {!!states.length && <EnumListbox label="state" value={statusFilter} options={["any", ...states]} onChange={setStatus} />}
              <button type="button" disabled={!client || refreshing} onClick={refresh}>refresh now</button>
              <span>{shown.length} of {rows.length}{continuationLabel}</span>
            </div>
          </div>
          {client && (refreshing || !!error) && <p className="sessions-notice" role="status">{refreshing ? "refreshing…" : `showing data from ${stamp(data.reportedAt)} · refresh failed · ${readError(error)}`}</p>}
          {data.warnings.map((warning) => <p key={warning} className="sessions-notice" role="status">{data.staleState !== undefined ? `showing state from ${stamp(data.staleState)} · refresh failed · ` : ""}{warning}</p>)}
          {data.omitted > 0 && <p className="sessions-notice" role="status">{data.omitted} malformed {data.omitted === 1 ? "row" : "rows"} omitted</p>}
          {!shown.length ? <ModuleState kind="empty" title={rows.length ? "no matching sessions" : data.complete ? "no sessions yet" : "no sessions in this view"}
            detail={rows.length ? "search for a title, first message or full id, or clear the filters." : data.complete ? "sessions appear here after zeta saves them." : "the catalog is incomplete."}
            action={rows.length ? { label: "clear filters", run: () => { setQuery(""); setProject("any"); setStatus("any"); search.current?.focus(); } } : undefined} /> : <>
            <div className="sessions-row sessions-labels" aria-hidden="true"><span>session</span><span>from</span><span>state</span><span>last</span></div>
            <ul className="sessions-rows">{shown.map((one) => <li key={one.id}>
              <a className="sessions-row" ref={(node) => { if (node) rowRefs.current.set(one.id, node); else rowRefs.current.delete(one.id); }}
                href={href(one.id)} aria-current={one.id === id ? "page" : undefined} onClick={(event) => follow(event, href(one.id))}>
                <span><strong title={one.title}>{one.title}</strong><small>{[one.project, short(one.id)].filter(Boolean).join(" · ")}</small></span>
                <span>{owned.has(one.id) ? "achilles" : ""}</span><StateTag state={one.status} />
                <span>{one.updated && <time dateTime={one.updated}>{timeLabel(one.updated)}</time>}</span>
              </a>
            </li>)}</ul>
          </>}
        </section>
        <section className="sessions-detail" ref={detail} tabIndex={-1} aria-label={transcript ? "session transcript" : "session detail"}>
          {(id || invalid) && <a className="sessions-back" href={transcript ? detailHref : catalogHref} onClick={(event) => follow(event, transcript ? detailHref : catalogHref)}>
            {transcript ? "← session detail" : "← sessions"}
          </a>}
          {invalid ? <ModuleState kind="failed" title="invalid session link" /> : row ? <SessionDetail key={row.id} row={row} reader={reader} transcript={transcript}
            owned={owned.has(row.id)} follow={follow} /> : id ? <ModuleState kind="empty" title="session not in this catalog" detail={data.complete ? "it may have been removed." : "the catalog is incomplete."} />
            : <ModuleState kind="empty" title="select a session" detail="read session details and transcripts without changing the session open in zeta." />}
        </section>
      </div>
    </>}
  </section>;
}

function SessionDetail({ row, reader, transcript, owned, follow }: {
  row: SessionRow; reader?: SessionsReader; transcript: boolean; owned: boolean; follow: (event: MouseEvent<HTMLAnchorElement>, url: string) => void;
}) {
  const [copied, setCopied] = useState("");
  const access = useMemo(() => reader && !transcript ? (signal: AbortSignal) => reader.transcriptMode(row, signal) : undefined, [reader, row.id, row.project, transcript]);
  const mode = useRead(access, 30000);
  const agents = useCollection(reader, row, "agents", !transcript);
  const tasks = useCollection(reader, row, "background_tasks", !transcript);
  const snapshot = [agents.data, tasks.data].filter((data) => !!data).sort((a, b) => b.reportedAt - a.reportedAt)[0]?.state ?? row.state;
  const state = snapshot?.status ?? "unknown";
  const transcriptHref = href(row.id, true);
  const fields = (values: (readonly [string, ReactNode])[]) => values.filter(([, value]) => value !== undefined);
  return <>
    <div className="sessions-title"><h2>{row.title}</h2><p><StateTag state={state} />{owned && " · achilles"}{row.project && <> · project {row.project}</>}</p></div>
    {transcript ? <SessionTranscript row={row} reader={reader} /> : <>
      <dl className="sessions-fields">{fields([
        ["session id", <><code title={row.id}>{short(row.id)}</code> <button className="sessions-copy" type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(row.id); setCopied("copied"); } catch { setCopied("could not copy"); }
        }}>copy</button><span role="status">{copied}</span></>],
        ["project", row.project === null ? "no project" : row.project], ["parent session", row.parent || undefined],
        ["model", [row.model, row.provider].filter(Boolean).join(" · ") || undefined], ["profile", snapshot?.profile], ["working directory", row.cwd],
        ["started · last", [row.created, row.updated].filter((v): v is string => !!v).map((v) => timeLabel(v)).join(" · ") || undefined],
        ["child agents", snapshot?.children], ["background tasks", snapshot?.tasks], ["attention", snapshot?.attention], ["first message", row.preview],
      ]).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {reader && mode.data && !mode.error ? <a className="sessions-transcript-action" href={transcriptHref} onClick={(event) => follow(event, transcriptHref)}>read transcript</a>
        : <><button type="button" className="sessions-transcript-action" disabled>read transcript</button>
          <p className="sessions-help" role="status">{!reader ? "connect to zeta to read the transcript" : mode.error ? readError(mode.error) : "checking transcript access…"}</p></>}
      <div className="sessions-collections"><CollectionView label="child agents" result={agents} /><CollectionView label="background tasks" result={tasks} /></div>
    </>}
  </>;
}

function useCollection(reader: SessionsReader | undefined, row: SessionRow, kind: Collection, visible: boolean) {
  const load = useMemo(() => reader && visible ? (signal: AbortSignal) => reader.collection(row.id, kind, signal) : undefined, [reader, row.id, kind, visible]);
  return useRead(load, row.status === "running" || row.status === "approval" ? 5000 : 30000);
}

function CollectionView({ label, result }: { label: string; result: ReturnType<typeof useCollection> }) {
  const { data, refreshing, error, refresh } = result;
  return <details className="sessions-collection">
    <summary>{label}{data && ` · ${data.items.length}${data.complete ? "" : " loaded"}`}</summary>
    {refreshing && <p role="status">{data ? "refreshing…" : "loading…"}</p>}
    {!!error && <p role="status">{data && `showing data from ${stamp(data.reportedAt)} · refresh failed · `}{readError(error)} {!(error instanceof ReadLimit) && <button type="button" onClick={refresh}>retry now</button>}</p>}
    {data?.omitted ? <p>{data.omitted} malformed {data.omitted === 1 ? "row" : "rows"} omitted</p> : null}
    {data?.items.length ? <ul>{data.items.map((item) => <li key={item.id}><code title={item.id}>{short(item.id)}</code> {item.label} · {item.status}</li>)}</ul> : data?.complete && <p>none reported</p>}
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
      {data.restarted && <p className="sessions-notice" role="status">transcript changed · started from a new snapshot</p>}
      {!!data.next && <button className="sessions-more" type="button" disabled={!reader || refreshing} onClick={() => previous === data ? refresh() : setPrevious(data)}>{data.next.kind === "forward" ? "load more messages" : "load older messages"}</button>}
      {data.rows.length ? <div className="transcript sessions-timeline"><RunProvider store={store}><Timeline /></RunProvider></div> : <ModuleState kind="empty" title="no messages" />}
    </>}
  </div>;
}
