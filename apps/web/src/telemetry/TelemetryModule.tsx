import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { formatAgo } from "./format";
import { Overview } from "./Overview";
import { usePoll } from "./poll";
import { Sessions, type SessionsQuery } from "./Sessions";
import { telemetryClient, telemetryNegotiated, telemetryProblem, type Window } from "./telemetry-client";
import type { Page, TelemetryOverview, TelemetrySession, TelemetryStatus } from "./telemetry-types";
import "./telemetry.css";

type Tab = "overview" | "sessions";
const TABS: { tab: Tab; href: string; label: string }[] = [
  { tab: "overview", href: "/telemetry", label: "Overview" },
  { tab: "sessions", href: "/telemetry/sessions", label: "Sessions" },
];
const tabOf = (path: string): Tab => (path === "/telemetry/sessions" || path.startsWith("/telemetry/sessions/") ? "sessions" : "overview");

export type Range = "24h" | "7d";
const RANGES: Record<Range, { label: string; ms: number; bucket: "hour" | "day" }> = {
  "24h": { label: "24 hours", ms: 24 * 3600_000, bucket: "hour" },
  "7d": { label: "7 days", ms: 7 * 24 * 3600_000, bucket: "day" },
};
const windowOf = (range: Range, nowMs = Date.now()): Window => ({ start_ns: (nowMs - RANGES[range].ms) * 1e6, end_ns: nowMs * 1e6 });

type Loaded =
  | { tab: "overview"; status: TelemetryStatus; overview: TelemetryOverview }
  | { tab: "sessions"; status: TelemetryStatus; page: Page<TelemetrySession>; window: Window };

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
    <nav className="tm-tabs" aria-label="Telemetry views">
      {TABS.map((item) => <a key={item.tab} href={item.href} aria-current={item.tab === tab ? "page" : undefined} onClick={(event) => go(event, item.href)}>{item.label}</a>)}
    </nav>
  );
  if (!client) return <Frame tabs={tabs}><Notice role="status" title="Connecting to zeta…" /></Frame>;
  if (!telemetryNegotiated(client)) return <Frame tabs={tabs}><NeedsNewerZeta /></Frame>;
  return <TelemetryPages client={client} tab={tab} tabs={tabs} />;
}

function TelemetryPages({ client, tab, tabs }: { client: ZetaClient; tab: Tab; tabs: ReactNode }) {
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
    const window = pagedWindow ?? windowOf(range);
    const [status, page] = await Promise.all([reads.status(), reads.sessions({ ...window, cursor: query.cursors.at(-1), errorsOnly: query.errorsOnly, profile: query.profile, model: query.model })]);
    return { tab, status, page, window };
  }, [client, tab, range, query, pagedWindow]);

  // Filter choices come from the sessions seen so far; zeta has no list of profiles or models yet.
  const seen = useRef({ profiles: new Set<string>(), models: new Set<string>() });
  if (poll.data?.tab === "sessions") for (const session of poll.data.page.items) {
    if (session.profile) seen.current.profiles.add(session.profile);
    if (session.model) seen.current.models.add(session.model);
  }

  const setFilters = (next: Partial<SessionsQuery>) => { setPagedWindow(null); setQuery({ ...query, ...next, cursors: [null] }); };
  const status = poll.data?.status;
  const problem = poll.error === undefined ? null : telemetryProblem(poll.error);
  const tools = (
    <div className="tm-tools">
      {status && <ReceiverMark status={status} />}
      {poll.refreshing && poll.data && <span className="tm-refreshing" role="status">refreshing…</span>}
      <button type="button" className="tm-button" onClick={poll.refresh} aria-label="Refresh telemetry"><span aria-hidden="true">↻</span><span className="tm-refresh-text"> Refresh</span></button>
      <label className="tm-range">
        <span className="tm-visually-hidden">Time range, last</span>
        <select value={range} onChange={(event) => { setRange(event.target.value as Range); setPagedWindow(null); setQuery({ ...query, cursors: [null] }); }}>
          {(Object.keys(RANGES) as Range[]).map((value) => <option key={value} value={value}>{RANGES[value].label}</option>)}
        </select>
      </label>
    </div>
  );

  let body: ReactNode;
  if (problem?.kind === "not_negotiated") body = <NeedsNewerZeta />;
  else if (problem?.kind === "off" || status?.enabled === false) body = <TelemetryOff />;
  else if (!poll.data || poll.data.tab !== tab) {
    body = problem ? <LoadFailed message={problem.message} retry={poll.refresh} /> : <Notice role="status" title="Loading telemetry…" />;
  } else {
    const stale = problem && <p className="tm-stale" role="alert">Refresh failed: {problem.message}. Showing the last result. <button type="button" className="tm-link" onClick={poll.refresh}>Retry</button></p>;
    const data = poll.data;
    body = <>
      {stale}
      {data.tab === "overview"
        ? <Overview overview={data.overview} rangeLabel={`last ${RANGES[range].label}`} bucket={RANGES[range].bucket} chart={chart} setChart={setChart} empty={<NoTelemetryYet rangeLabel={`last ${RANGES[range].label}`} />} />
        : <Sessions
            page={data.page}
            query={query}
            rangeLabel={`last ${RANGES[range].label}`}
            profiles={[...seen.current.profiles].sort()}
            models={[...seen.current.models].sort()}
            setFilters={setFilters}
            next={() => { setPagedWindow(data.window); setQuery({ ...query, cursors: [...query.cursors, data.page.next_cursor] }); }}
            previous={() => { const cursors = query.cursors.slice(0, -1); if (cursors.length === 1) setPagedWindow(null); setQuery({ ...query, cursors }); }}
            empty={<NoTelemetryYet rangeLabel={`last ${RANGES[range].label}`} />}
          />}
    </>;
  }
  return <Frame tabs={tabs} tools={tools}>{body}</Frame>;
}

function Frame({ tabs, tools, children }: { tabs: ReactNode; tools?: ReactNode; children: ReactNode }) {
  return (
    <div className="telemetry-module" data-fulcrum-theme="gruvbox-dark">
      <header className="tm-bar">
        <a className="tm-brand" href="/telemetry" aria-label="zeta telemetry">zeta <span>telemetry</span></a>
        {tabs}
        {tools}
      </header>
      <main className="tm-main">{children}</main>
      <p className="tm-privacy">Telemetry is metadata only: no prompts, outputs, tool arguments, or results.</p>
    </div>
  );
}

const RECEIVER: Record<TelemetryStatus["receiver"], { mark: string; text: string; tone: string }> = {
  ready: { mark: "●", text: "Receiving", tone: "ok" },
  starting: { mark: "○", text: "Receiver starting", tone: "warn" },
  stopped: { mark: "■", text: "Receiver stopped", tone: "muted" },
  error: { mark: "▲", text: "Receiver error", tone: "danger" },
};

function ReceiverMark({ status }: { status: TelemetryStatus }) {
  const receiver = RECEIVER[status.receiver];
  const failing = status.receiver === "ready" && status.last_export === "error";
  const tone = failing ? "danger" : receiver.tone;
  return (
    <span className={`tm-receiver tm-${tone}`}>
      <span aria-hidden="true" className="tm-mark">{failing ? "▲" : receiver.mark}</span>
      <span className="tm-receiver-text">{failing ? "Export failing" : receiver.text}</span>
      {status.last_export_ns !== null && <span className="tm-dim" title="Last export">{formatAgo(status.last_export_ns)}</span>}
    </span>
  );
}

function Notice({ title, children, role }: { title: string; children?: ReactNode; role?: "status" | "alert" }) {
  return <section className="tm-notice" role={role}><h1>{title}</h1>{children}</section>;
}

const SETTING = '[otel]\nendpoint = "http://127.0.0.1:4323/v1/traces"';

function TelemetryOff() {
  return (
    <Notice title="Telemetry is off">
      <p>Zeta is not recording telemetry. To turn it on, add this to <code>settings.toml</code> in your zeta home, then restart zeta:</p>
      <pre>{SETTING}</pre>
      <p className="tm-dim">Zeta starts its built-in receiver on this computer. It keeps 14 days of detail, 90 days of hourly totals, and at most 1 GiB.</p>
    </Notice>
  );
}

function NoTelemetryYet({ rangeLabel }: { rangeLabel: string }) {
  return (
    <Notice title="No telemetry yet">
      <p>Telemetry is on, but zeta recorded nothing in the {rangeLabel}. Run one zeta turn; it shows here within a few seconds.</p>
      <p className="tm-dim">If nothing appears, check that <code>settings.toml</code> in your zeta home has:</p>
      <pre>{SETTING}</pre>
    </Notice>
  );
}

function NeedsNewerZeta() {
  return (
    <Notice title="Telemetry needs a newer zeta">
      <p>This zeta does not offer telemetry reads (<code>telemetry_read_v1</code>). Update zeta, restart <code>zeta serve</code>, then reload this page.</p>
    </Notice>
  );
}

function LoadFailed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Notice title="Telemetry could not be loaded" role="alert">
      <p>{message}</p>
      <button type="button" className="tm-button" onClick={retry}>Retry</button>
    </Notice>
  );
}
