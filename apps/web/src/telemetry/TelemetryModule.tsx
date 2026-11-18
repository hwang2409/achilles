import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { formatAgo, formatHour } from "./format";
import { Overview, OverviewSkeleton } from "./Overview";
import { usePoll } from "./poll";
import { Sessions, type SessionsQuery } from "./Sessions";
import { telemetryClient, telemetryNegotiated, telemetryProblem, type TelemetryProblem, type Window } from "./telemetry-client";
import type { Page, TelemetryOverview, TelemetrySession, TelemetryStatus } from "./telemetry-types";
import "./telemetry.css";

type Tab = "overview" | "sessions";
const TABS: { tab: Tab; href: string }[] = [
  { tab: "overview", href: "/telemetry" },
  { tab: "sessions", href: "/telemetry/sessions" },
];
const tabOf = (path: string): Tab => (path === "/telemetry/sessions" || path.startsWith("/telemetry/sessions/") ? "sessions" : "overview");
/** The session id of `/telemetry/sessions/:id`, else null. */
const sessionOf = (path: string) => { const match = /^\/telemetry\/sessions\/([^/]+)$/.exec(path); return match ? decodeURIComponent(match[1]) : null; };

export type Range = "24h" | "7d";
const RANGES: Record<Range, { label: string; ms: number; bucket: "hour" | "day" }> = {
  "24h": { label: "last 24 hours", ms: 24 * 3600_000, bucket: "hour" },
  "7d": { label: "last 7 days", ms: 7 * 24 * 3600_000, bucket: "day" },
};
const windowOf = (range: Range, nowMs = Date.now()): Window => ({ start_ns: (nowMs - RANGES[range].ms) * 1e6, end_ns: nowMs * 1e6 });

type Loaded =
  | { tab: "overview"; status: TelemetryStatus; overview: TelemetryOverview }
  | { tab: "sessions"; status: TelemetryStatus; total: number; page: Page<TelemetrySession>; window: Window };

const firstPage: SessionsQuery = { cursors: [null], errorsOnly: false, profile: null, model: null };

/** The telemetry pages: one read-only view of zeta's telemetry over the page's live connection. */
export function TelemetryModule({ client, pathname }: { client: ZetaClient | null; pathname: string }) {
  const [path, setPath] = useState(pathname);
  useEffect(() => setPath(pathname), [pathname]);
  useEffect(() => {
    const back = () => setPath(location.pathname);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const tab = tabOf(path);
  const go = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (href !== location.pathname) history.pushState(null, "", href);
    setPath(href);
  };
  const tabs = (
    <nav className="tm-tabs" aria-label="telemetry views">
      {TABS.map((item) => <a key={item.tab} href={item.href} aria-current={item.tab === tab ? "page" : undefined} onClick={(event) => go(event, item.href)}>{item.tab}</a>)}
    </nav>
  );
  if (!client) return <Frame><Notice role="status" title="connecting to zeta…" /></Frame>;
  if (!telemetryNegotiated(client)) return <NeedsNewerZeta protocol={client.protocolVersion} />;
  const detail = sessionOf(path);
  if (detail) return <Frame tabs={tabs}><SessionComing id={detail} back={(event) => go(event, "/telemetry/sessions")} /></Frame>;
  return <TelemetryPages client={client} tab={tab} tabs={tabs} go={go} />;
}

function TelemetryPages({ client, tab, tabs, go }: { client: ZetaClient; tab: Tab; tabs: ReactNode; go: (event: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
  const [range, setRange] = useState<Range>("24h");
  const [chart, setChart] = useState<"calls" | "tokens">("calls");
  const [query, setQuery] = useState(firstPage);
  // A cursor is tied to the window of its first page, so later pages keep that window; the first page moves with now.
  const [pagedWindow, setPagedWindow] = useState<Window | null>(null);
  const reads = telemetryClient(client);
  const poll = usePoll<Loaded>(async () => {
    if (tab === "overview") {
      const overview = await reads.overview(windowOf(range), RANGES[range].bucket);
      return { tab, status: overview.status, overview };
    }
    // The count comes from overview totals for the same window, so overview and sessions show one number.
    const window = pagedWindow ?? windowOf(range);
    const [overview, page] = await Promise.all([reads.overview(window, RANGES[range].bucket), reads.sessions({ ...window, cursor: query.cursors.at(-1), errorsOnly: query.errorsOnly, profile: query.profile, model: query.model })]);
    return { tab, status: overview.status, total: overview.totals.sessions, page, window };
  }, [client, tab, range, query, pagedWindow]);

  // Filter choices come from the sessions seen so far; zeta has no list of profiles or models yet.
  const seen = useRef({ profiles: new Set<string>(), models: new Set<string>() });
  if (poll.data?.tab === "sessions") for (const session of poll.data.page.items) {
    if (session.profile) seen.current.profiles.add(session.profile);
    if (session.model) seen.current.models.add(session.model);
  }

  const chooseRange = (next: Range) => { setRange(next); setPagedWindow(null); setQuery({ ...query, cursors: [null] }); };
  const setFilters = (next: Partial<SessionsQuery>) => { setPagedWindow(null); setQuery({ ...query, ...next, cursors: [null] }); };
  const status = poll.data?.status;
  const problem = poll.error === undefined ? null : telemetryProblem(poll.error);
  const rangeLabel = RANGES[range].label;
  if (problem?.kind === "not_negotiated") return <NeedsNewerZeta protocol={client.protocolVersion} />;
  if (problem?.kind === "off" || status?.enabled === false) return <TelemetryOff />;

  const tools = (
    <div className="tm-tools">
      {status && <ReceiverMark status={status} />}
      {poll.refreshing && poll.data && <span className="tm-refreshing" role="status">refreshing…</span>}
      <label className="tm-range">
        <span className="tm-visually-hidden">time range</span>
        <select value={range} onChange={(event) => chooseRange(event.target.value as Range)}>
          {(Object.keys(RANGES) as Range[]).map((value) => <option key={value} value={value}>{RANGES[value].label}</option>)}
        </select>
      </label>
      <button type="button" className="tm-button tm-refresh" onClick={poll.refresh}><span aria-hidden="true">↻</span>refresh</button>
    </div>
  );

  const data = poll.data?.tab === tab ? poll.data : undefined;
  const banner = problem && <FailedBanner problem={problem} updatedAt={data ? poll.updatedAt : undefined} retry={poll.refresh} />;
  let body: ReactNode;
  if (!data) body = <>{banner}{!problem && <p className="tm-loading" role="status"><span aria-hidden="true" className="tm-mark">□ </span>loading the {rangeLabel}…</p>}{tab === "overview" ? <OverviewSkeleton /> : null}</>;
  else {
    const empty = <NoTelemetryYet rangeLabel={rangeLabel} widen={range === "24h" ? () => chooseRange("7d") : undefined} />;
    body = <>
      {banner}
      <div className={problem ? "tm-stale" : undefined}>
        {data.tab === "overview"
          ? <Overview overview={data.overview} bucket={RANGES[range].bucket} chart={chart} setChart={setChart} empty={empty} />
          : <Sessions
              page={data.page}
              total={data.total}
              open={go}
              query={query}
              rangeLabel={rangeLabel}
              profiles={[...seen.current.profiles].sort()}
              models={[...seen.current.models].sort()}
              setFilters={setFilters}
              next={() => { setPagedWindow(data.window); setQuery({ ...query, cursors: [...query.cursors, data.page.next_cursor] }); }}
              previous={() => { const cursors = query.cursors.slice(0, -1); if (cursors.length === 1) setPagedWindow(null); setQuery({ ...query, cursors }); }}
              empty={empty}
            />}
      </div>
    </>;
  }
  return <Frame tools={tools} tabs={tabs}>{body}</Frame>;
}

/** Only the interior: the achilles shell draws the sidebar, top bar, and route title around it. */
function Frame({ tools, tabs, children }: { tools?: ReactNode; tabs?: ReactNode; children: ReactNode }) {
  return (
    <div className="telemetry-module" data-fulcrum-theme="gruvbox-dark">
      {tabs && <div className="tm-tabs-row">{tabs}{tools}</div>}
      <main className="tm-main">{children}</main>
    </div>
  );
}

const RECEIVER: Record<TelemetryStatus["receiver"], { text: string; tone: string }> = {
  ready: { text: "receiving", tone: "ok" },
  starting: { text: "receiver starting", tone: "warn" },
  stopped: { text: "receiver stopped", tone: "muted" },
  error: { text: "receiver error", tone: "danger" },
};

function ReceiverMark({ status }: { status: TelemetryStatus }) {
  const failing = status.receiver === "ready" && status.last_export === "error";
  const { text, tone } = failing ? { text: "export failing", tone: "danger" } : RECEIVER[status.receiver];
  return (
    <span className="tm-receiver">
      <span aria-hidden="true" className={`tm-mark tm-${tone}`}>{tone === "danger" ? "▲" : "■"}</span>
      <span className="tm-receiver-text">{text}</span>
      {status.last_export_ns !== null && <span className="tm-dim" title="last export"><span className="tm-receiver-text"> · </span>{formatAgo(status.last_export_ns)}</span>}
    </span>
  );
}

const FAILURE_TITLES: Record<string, string> = {
  receiver_unavailable: "telemetry receiver stopped",
  state_unavailable: "zeta is busy",
  stale_state_snapshot: "telemetry changed while reading",
  corrupt_state: "stored telemetry is invalid",
  result_too_large: "too much telemetry for one read",
};

/** One failure rule: keep the last good numbers, dim them, and say how old they are. */
function FailedBanner({ problem, updatedAt, retry }: { problem: TelemetryProblem; updatedAt?: number; retry: () => void }) {
  const title = (problem.code && FAILURE_TITLES[problem.code]) ?? "telemetry could not be read";
  return (
    <section className="tm-banner" role="alert">
      <div>
        <h2>{title}</h2>
        <p>
          {updatedAt !== undefined ? <>showing data from {formatHour(updatedAt * 1e6)} · {formatAgo(updatedAt * 1e6).replace(" ago", " old")} · </> : <>{problem.message} · </>}
          retrying every 5 s
        </p>
      </div>
      <button type="button" className="tm-button tm-danger-button" onClick={retry}>retry now</button>
    </section>
  );
}

function Notice({ title, children, role }: { title: string; children?: ReactNode; role?: "status" | "alert" }) {
  return <section className="tm-notice" role={role}><h1>{title}</h1>{children}</section>;
}

const SETTING = '[otel]\nendpoint = "http://127.0.0.1:4323/v1/traces"';

function TelemetryOff() {
  return (
    <Frame>
      <section className="tm-intro">
        <p className="tm-eyebrow">telemetry</p>
        <h1>see each step your agents take</h1>
        <p className="tm-lead">turn it on and zeta records the timing of every turn, model call and tool call, with token counts. you get an agent tree and a waterfall for each session, plus totals per model and tool.</p>
        <div className="tm-records">
          <div><h2 className="tm-ok">records</h2><ul><li>durations and status</li><li>model, provider, tokens</li><li>tool names and sizes</li><li>error types</li></ul></div>
          <div><h2 className="tm-danger">never records</h2><ul><li>prompts or replies</li><li>reasoning</li><li>tool arguments or results</li><li>error messages, env values</li></ul></div>
        </div>
        <div className="tm-turn-on">
          <h2>turn it on in settings</h2>
          <p className="tm-dim">built-in receiver on 127.0.0.1:4323 · keeps 14 days raw, 90 days hourly, at most 1 GiB</p>
          <p>add this to <code>settings.toml</code> in your zeta home, then restart zeta:</p>
          <pre>{SETTING}</pre>
        </div>
        <p className="tm-dim tm-after">this page only reads telemetry. the <code>otel</code> setting lives in zeta settings; after you turn it on, running sessions send telemetry on their next turn.</p>
      </section>
    </Frame>
  );
}

/** `/telemetry/sessions/:id` until the session detail view lands. */
function SessionComing({ id, back }: { id: string; back: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <section className="tm-empty">
      <p className="tm-eyebrow">session</p>
      <h1 className="tm-id-heading" title={id}>{id}</h1>
      <p>the session view, with its agent tree and trace waterfall, comes in the next update.</p>
      <div className="tm-actions"><a className="tm-button" href="/telemetry/sessions" onClick={back}>‹ back to sessions</a></div>
    </section>
  );
}

function NoTelemetryYet({ rangeLabel, widen }: { rangeLabel: string; widen?: () => void }) {
  return (
    <section className="tm-empty">
      <h1>no telemetry in the {rangeLabel}</h1>
      <p>sessions send spans when a turn ends. start a chat or wait for a running agent to finish its turn; it shows here within a few seconds.</p>
      <div className="tm-actions">
        <a className="tm-button tm-primary" href="/">+ new chat</a>
        {widen && <button type="button" className="tm-button" onClick={widen}>last 7 days</button>}
      </div>
    </section>
  );
}

function NeedsNewerZeta({ protocol }: { protocol: string }) {
  return (
    <Frame>
      <section className="tm-intro">
        <p className="tm-eyebrow">telemetry · needs a newer zeta</p>
        <h1>this zeta can't show telemetry yet</h1>
        <p className="tm-lead">achilles reads telemetry from zeta through <code>telemetry_read_v1</code>. the zeta that achilles talks to did not offer it. chats, pages and agents still work.</p>
        <dl className="tm-facts">
          <dt>zeta serve</dt><dd>connected{protocol && ` · protocol ${protocol}`}</dd>
          <dt><code>telemetry_read_v1</code></dt><dd className="tm-warn"><span aria-hidden="true">■ </span>not offered</dd>
        </dl>
        <h2>to fix it</h2>
        <ol>
          <li>update zeta to a version that offers <code>telemetry_read_v1</code></li>
          <li>restart <code>zeta serve</code> · achilles connects again by itself</li>
        </ol>
        <div className="tm-actions">
          <button type="button" className="tm-button tm-primary" onClick={() => location.reload()}>check again</button>
          <a className="tm-button" href="/">back to chats</a>
        </div>
      </section>
    </Frame>
  );
}
