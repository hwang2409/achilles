import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { AggregateSkeleton, AggregateView } from "./AggregateViews";
import { formatAgo, formatHour } from "./format";
import { EnumListbox } from "../page/EnumListbox";
import { Overview, OverviewSkeleton } from "./Overview";
import { RANGES, useTelemetryReads, type Loaded, type Range, type Tab } from "./reads";
import { Sessions } from "./Sessions";
import { STATE_FEATURE, TELEMETRY_FEATURE, telemetryNegotiated, telemetryProblem, type TelemetryProblem } from "./telemetry-client";
import type { TelemetryStatus } from "./telemetry-types";
import "./telemetry.css";

const TABS: { tab: Tab; href: string }[] = [
  { tab: "overview", href: "/telemetry" },
  { tab: "sessions", href: "/telemetry/sessions" },
  { tab: "models", href: "/telemetry/models" },
  { tab: "tools", href: "/telemetry/tools" },
  { tab: "errors", href: "/telemetry/errors" },
];
const tabOf = (path: string): Tab => (path.startsWith("/telemetry/sessions/") ? "sessions" : TABS.find((item) => item.href === path)?.tab ?? "overview");
/** The session id of `/telemetry/sessions/:id`, else null. */
const sessionOf = (path: string) => { const match = /^\/telemetry\/sessions\/([^/]+)$/.exec(path); return match ? decodeURIComponent(match[1]) : null; };

/** The telemetry pages: one read-only view of zeta's telemetry over the page's live connection. */
export function TelemetryModule({ client, pathname, openTelemetrySettings }: {
  client: ZetaClient | null;
  pathname: string;
  /** Opens the settings view with the telemetry row. Until the shell passes it, the off page shows the settings.toml hint. */
  openTelemetrySettings?: () => void;
}) {
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
  if (!telemetryNegotiated(client)) return <NeedsNewerZeta client={client} />;
  const detail = sessionOf(path);
  if (detail) return <Frame tabs={tabs}><SessionComing id={detail} back={(event) => go(event, "/telemetry/sessions")} /></Frame>;
  return <TelemetryPages client={client} tab={tab} tabs={tabs} go={go} openTelemetrySettings={openTelemetrySettings} />;
}

function TelemetryPages({ client, tab, tabs, go, openTelemetrySettings }: { client: ZetaClient; tab: Tab; tabs: ReactNode; go: (event: MouseEvent<HTMLAnchorElement>, href: string) => void; openTelemetrySettings?: () => void }) {
  const [chart, setChart] = useState<"calls" | "tokens">("calls");
  const reads = useTelemetryReads(client, tab);
  const { data, shown, range } = reads;
  const seen = useSeenFilters(data);
  const status = data?.status;
  const problem = reads.error === undefined ? null : telemetryProblem(reads.error);
  if (problem?.kind === "off" || status?.enabled === false) return <TelemetryOff openSettings={openTelemetrySettings} />;

  const banner = problem && <FailedBanner problem={problem} updatedAt={shown ? reads.updatedAt : undefined} retry={reads.refresh} />;
  return (
    <Frame tools={<Tools status={status} refreshing={reads.phase === "refreshing"} range={range} chooseRange={reads.chooseRange} refresh={reads.refresh} />} tabs={tabs}>
      {banner}
      {shown
        ? <ShownView reads={reads} shown={shown} busy={!problem} chart={chart} setChart={setChart} seen={seen} go={go} />
        : <Loading tab={tab} range={range} quiet={!!problem} />}
    </Frame>
  );
}

type Reads = ReturnType<typeof useTelemetryReads>;

/** Labels come from the ask the shown reply answers; while a newer ask loads, the old reply stays, dimmed. */
function ShownView({ reads, shown, busy, chart, setChart, seen, go }: { reads: Reads; shown: NonNullable<Reads["shown"]>; busy: boolean; chart: "calls" | "tokens"; setChart: (chart: "calls" | "tokens") => void; seen: ReturnType<typeof useSeenFilters>; go: (event: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
  const empty = <NoTelemetryYet rangeLabel={shown.label} widen={reads.range === "24h" ? () => reads.chooseRange("7d") : undefined} />;
  const view = shown.data.tab === "overview"
    ? <Overview overview={shown.data.overview} bucket={shown.bucket} chart={chart} setChart={setChart} empty={empty} />
    : shown.data.tab === "sessions" ? <Sessions page={shown.data.page} total={shown.data.total} open={go} query={reads.query} shown={shown.data.ask.query} rangeLabel={shown.label} profiles={seen.profiles} models={seen.models} setFilters={reads.setFilters} next={reads.next} previous={reads.previous} empty={empty} />
    : <AggregateView key={shown.data.tab} data={shown.data} reads={reads} bucket={shown.bucket} label={shown.label} open={go} empty={empty} />;
  return <div className={shown.stale ? "tm-stale" : undefined} aria-busy={shown.stale && busy ? true : undefined}>{view}</div>;
}

function Loading({ tab, range, quiet }: { tab: Tab; range: Range; quiet: boolean }) {
  return <>{!quiet && <p className="tm-loading" role="status"><span aria-hidden="true" className="tm-mark">□ </span>loading the {RANGES[range].label}…</p>}{tab === "overview" ? <OverviewSkeleton /> : tab !== "sessions" && <AggregateSkeleton tab={tab} /> }</>;
}

/** Filter choices come from the sessions seen so far; zeta has no list of profiles or models yet. */
function useSeenFilters(data: Loaded | undefined) {
  const seen = useRef({ profiles: new Set<string>(), models: new Set<string>() });
  if (data?.tab === "sessions") for (const session of data.page.items) {
    if (session.profile) seen.current.profiles.add(session.profile);
    if (session.model) seen.current.models.add(session.model);
  }
  return { profiles: [...seen.current.profiles].sort(), models: [...seen.current.models].sort() };
}

const RANGE_KEYS = Object.keys(RANGES) as Range[];
const RANGE_LABELS = RANGE_KEYS.map((key) => RANGES[key].label);

function Tools({ status, refreshing, range, chooseRange, refresh }: { status?: TelemetryStatus; refreshing: boolean; range: Range; chooseRange: (range: Range) => void; refresh: () => void }) {
  return (
    <div className="tm-tools">
      {status && <ReceiverMark status={status} />}
      {refreshing && <span className="tm-refreshing" role="status">refreshing…</span>}
      <div className="tm-range">
        <EnumListbox label="time range" value={RANGES[range].label} options={RANGE_LABELS} onChange={(label) => chooseRange(RANGE_KEYS.find((key) => RANGES[key].label === label)!)} />
      </div>
      <button type="button" className="tm-button tm-refresh" onClick={refresh}><span aria-hidden="true">↻</span>refresh</button>
    </div>
  );
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

/** T7. Without `openSettings` (no settings view has the telemetry row yet) the action is the settings.toml hint. */
function TelemetryOff({ openSettings }: { openSettings?: () => void }) {
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
        <div className={`tm-turn-on${openSettings ? " tm-turn-on-action" : ""}`}>
          <div>
            <h2>turn it on in settings</h2>
            <p className="tm-dim">built-in receiver on 127.0.0.1:4323 · keeps 14 days raw, 90 days hourly, at most 1 GiB</p>
          </div>
          {openSettings
            ? <button type="button" className="tm-button tm-primary" onClick={openSettings}>open settings <span aria-hidden="true">↗</span></button>
            : <>
                <p>add this to <code>settings.toml</code> in your zeta home, then restart running sessions:</p>
                <pre>{SETTING}</pre>
              </>}
        </div>
        {openSettings && <p className="tm-dim tm-after">after you save it, new sessions send telemetry; zeta tells you which running sessions need a restart.</p>}
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

function NeedsNewerZeta({ client }: { client: ZetaClient }) {
  const offered = (feature: string) => client.features.includes(feature);
  return (
    <Frame>
      <section className="tm-intro">
        <p className="tm-eyebrow">telemetry · needs a newer zeta</p>
        <h1>this zeta can't show telemetry yet</h1>
        <p className="tm-lead">achilles reads telemetry from zeta through <code>telemetry_read_v1</code>. the zeta that achilles talks to did not offer it. chats, pages and agents still work.</p>
        <dl className="tm-facts">
          <dt>zeta serve</dt><dd>connected{client.protocolVersion && ` · protocol ${client.protocolVersion}`}</dd>
          <dt><code>{TELEMETRY_FEATURE}</code></dt><dd className="tm-warn"><span aria-hidden="true">■ </span>not offered</dd>
          <dt><code>{STATE_FEATURE}</code></dt>
          {offered(STATE_FEATURE) ? <dd>offered</dd> : <dd className="tm-warn"><span aria-hidden="true">■ </span>not offered · projects also off</dd>}
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
