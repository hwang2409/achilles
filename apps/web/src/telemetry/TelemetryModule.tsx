import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { AggregateSkeleton, AggregateView } from "./AggregateViews";
import { formatAgo, formatHour } from "./format";
import { EnumListbox } from "../page/EnumListbox";
import { Overview, OverviewSkeleton } from "./Overview";
import { browserEnv, RANGES, useTelemetryReads, type Loaded, type Range, type Tab } from "./reads";
import { DetailLoading, DetailNotice, SESSION_LIST, SessionBackLink, SessionDetail } from "./SessionDetail";
import { Sessions } from "./Sessions";
import { ShellDockSlot } from "../surface/ModuleState";
import { supportsFeature, TELEMETRY_FEATURE } from "../zeta/connection";
import { telemetryProblem, type TelemetryProblem } from "./telemetry-client";
import type { TelemetryStatus } from "./telemetry-types";

const TABS: { tab: Tab; href: string }[] = [
  { tab: "overview", href: "/telemetry" },
  { tab: "sessions", href: "/telemetry/sessions" },
  { tab: "models", href: "/telemetry/models" },
  { tab: "tools", href: "/telemetry/tools" },
  { tab: "errors", href: "/telemetry/errors" },
];
const tabOf = (path: string): Tab => (path.startsWith("/telemetry/sessions/") ? "sessions" : TABS.find((item) => item.href === path)?.tab ?? "overview");
/** The session id of `/telemetry/sessions/:id`, else null. */
const sessionOf = (path: string) => /^\/telemetry\/sessions\/([^/]+)$/.exec(path)?.[1] ?? null;

/** The telemetry pages: one read-only view of zeta's telemetry over the page's live connection. */
export function TelemetryModule({ client, pathname, openTelemetrySettings }: {
  client: ZetaClient;
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
    <nav className="flex flex-wrap gap-1 [&_a]:inline-flex [&_a]:min-h-10 [&_a]:items-center [&_a]:px-3 [&_a]:text-muted-foreground [&_a]:hover:bg-accent [&_a[aria-current]]:bg-accent [&_a[aria-current]]:text-accent-foreground" aria-label="telemetry views">
      {TABS.map((item) => <a key={item.tab} href={item.href} aria-current={item.tab === tab ? "page" : undefined} onClick={(event) => go(event, item.href)}>{item.tab[0].toUpperCase() + item.tab.slice(1)}</a>)}
    </nav>
  );
  if (!supportsFeature(client, TELEMETRY_FEATURE)) {
    const stateFeature = "state_read_v1";
    return (
      <><ShellDockSlot /><div data-telemetry-unavailable className="min-h-0 w-full flex-1 overflow-auto px-4 pt-4 sm:p-8">
        <Card className="mx-auto grid max-w-[560px] gap-4 border-0 bg-background p-0 wrap-anywhere sm:border sm:bg-card sm:p-6 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:font-semibold [&_dl]:grid [&_dl]:grid-cols-1 sm:[&_dl]:grid-cols-[auto_1fr] [&_dl]:gap-2 [&_dt]:text-muted-foreground [&_ol]:list-decimal [&_ol]:ps-5 [&_ol]:leading-relaxed max-sm:[&_ol]:pb-4">
          <p className="text-sm text-muted-foreground" role="status">telemetry · needs a newer zeta</p>
          <h1>this zeta can't show telemetry yet</h1>
          <p className="text-sm text-muted-foreground">achilles reads telemetry from zeta through <code>telemetry_read_v1</code>. the zeta that achilles talks to did not offer it. chats, pages and agents still work.</p>
          <dl>
            <dt>zeta serve</dt><dd>connected{client.protocolVersion && ` · protocol ${client.protocolVersion}`}</dd>
            <dt><code>{TELEMETRY_FEATURE}</code></dt><dd className="text-muted-foreground"><span aria-hidden="true">■ </span>not offered</dd>
            <dt><code>{stateFeature}</code></dt>
            {supportsFeature(client, stateFeature) ? <dd>offered</dd> : <dd className="text-muted-foreground"><span aria-hidden="true">■ </span>not offered · projects also off</dd>}
          </dl>
          <h2>to fix it</h2>
          <ol>
            <li>update zeta to a version that offers <code>telemetry_read_v1</code></li>
            <li>restart <code>zeta serve</code> · achilles connects again by itself</li>
          </ol>
          <div data-telemetry-unavailable-actions className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-2 border-t bg-background px-4 py-2 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
            <Button variant="outline" className="min-h-11" type="button" onClick={() => location.reload()}>check again</Button>
            <Button asChild variant="outline" className="min-h-11"><a href="/">back to chats</a></Button>
          </div>
        </Card>
      </div></>
    );
  }
  const detail = sessionOf(path);
  if (detail && !/^[a-f0-9]{32}$/.test(detail)) return <Frame tabs={tabs} detail><DetailNotice back={(event) => go(event, SESSION_LIST)} title="session not found">this link does not have a valid session id.</DetailNotice></Frame>;
  return <TelemetryPages client={client} tab={tab} tabs={tabs} go={go} sessionId={detail} openTelemetrySettings={openTelemetrySettings} />;
}

function TelemetryPages({ client, tab, tabs, go, sessionId, openTelemetrySettings }: { client: ZetaClient; tab: Tab; tabs: ReactNode; sessionId: string | null; go: (event: MouseEvent<HTMLAnchorElement>, href: string) => void; openTelemetrySettings?: () => void }) {
  const [chart, setChart] = useState<"calls" | "tokens">("calls");
  const [trace, setTrace] = useState<{ sessionId: string; id: string }>();
  useEffect(() => setTrace(undefined), [sessionId]);
  const traceId = trace?.sessionId === sessionId ? trace.id : null;
  const detail = useMemo(() => sessionId ? { sessionId, traceId } : undefined, [sessionId, traceId]);
  const reads = useTelemetryReads(client, tab, browserEnv, detail);
  const { data, shown, range } = reads;
  const seen = useSeenFilters(data);
  const status = data?.status;
  const problem = reads.error === undefined ? null : telemetryProblem(reads.error);
  if (problem?.kind === "off" || status?.enabled === false) return <TelemetryOff openSettings={openTelemetrySettings} />;

  if (sessionId) {
    const back = (event: MouseEvent<HTMLAnchorElement>) => go(event, SESSION_LIST);
    const reply = shown?.data.tab === "detail" ? shown.data : undefined;
    const missingTrace = problem?.code === "trace_not_found";
    return <Frame detail tools={<Tools status={reply?.status} refreshing={reads.phase === "refreshing"} refresh={reads.refresh} />} tabs={tabs}>
      {missingTrace ? <Alert variant="destructive" className="mb-4 flex flex-wrap items-center justify-between gap-3 p-4 [&_h2]:font-semibold [&_p]:text-sm"><div><h2>trace not found</h2><p>the selected trace may have expired.{reply && " showing the last available data."}</p></div><Button variant="outline" type="button" onClick={traceId ? () => setTrace(undefined) : reads.refresh}>{traceId ? "show latest trace" : "retry now"}</Button></Alert>
        : problem && <FailedBanner problem={problem} updatedAt={reply ? reads.updatedAt : undefined} retrying={reads.retrying} retry={reads.refresh} />}
      {reply ? <div className={shown?.stale ? "opacity-70" : undefined} aria-busy={shown?.stale && !problem || undefined}><SessionDetail key={sessionId} data={reply} sessionId={sessionId} back={back} chooseTrace={(id) => setTrace({ sessionId, id })} /></div>
        : problem ? <div className="p-4"><SessionBackLink back={back} /></div> : <DetailLoading back={back} />}
    </Frame>;
  }
  const banner = problem && <FailedBanner problem={problem} updatedAt={shown ? reads.updatedAt : undefined} retrying={reads.retrying} retry={reads.refresh} />;
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
  if (shown.data.tab === "detail") return null;
  const empty = <NoTelemetryYet rangeLabel={shown.label} widen={reads.range === "24h" ? () => reads.chooseRange("7d") : undefined} />;
  const view = shown.data.tab === "overview"
    ? <Overview overview={shown.data.overview} bucket={shown.bucket} chart={chart} setChart={setChart} empty={empty} />
    : shown.data.tab === "sessions" ? <Sessions page={shown.data.page} total={shown.data.total} open={go} query={reads.query} shown={shown.data.ask.query} rangeLabel={shown.label} profiles={seen.profiles} models={seen.models} setFilters={reads.setFilters} next={reads.next} previous={reads.previous} empty={empty} />
    : <AggregateView key={shown.data.tab} data={shown.data} reads={reads} bucket={shown.bucket} label={shown.label} open={go} empty={empty} />;
  return <div className={shown.stale ? "opacity-70" : undefined} aria-busy={shown.stale && busy ? true : undefined}>{view}</div>;
}

function Loading({ tab, range, quiet }: { tab: Tab; range: Range; quiet: boolean }) {
  return <>{!quiet && <p className="mb-4 border-b pb-3 text-muted-foreground" role="status"><span aria-hidden="true" >□ </span>loading the {RANGES[range].label}…</p>}{tab === "overview" ? <OverviewSkeleton /> : tab !== "sessions" && <AggregateSkeleton tab={tab} /> }</>;
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

function Tools({ status, refreshing, range, chooseRange, refresh }: { status?: TelemetryStatus; refreshing: boolean; range?: Range; chooseRange?: (range: Range) => void; refresh: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status && <ReceiverMark status={status} />}
      {refreshing && <span className="text-sm text-muted-foreground" role="status">refreshing…</span>}
      {range && chooseRange && <div className="min-w-0">
        <EnumListbox label="time range" value={RANGES[range].label} options={RANGE_LABELS} onChange={(label) => chooseRange(RANGE_KEYS.find((key) => RANGES[key].label === label)!)} />
      </div>}
      <Button variant="outline" type="button" className="shrink-0" onClick={refresh}><span aria-hidden="true">↻</span>refresh</Button>
    </div>
  );
}

/** Only the interior: the achilles shell draws the sidebar, top bar, and route title around it. */
function Frame({ tools, tabs, children, detail }: { tools?: ReactNode; tabs?: ReactNode; children: ReactNode; detail?: boolean }) {
  return (
    <div className="flex min-h-0 w-full flex-col overflow-auto">
      {tabs && <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">{tabs}{tools}</div>}
      <ShellDockSlot />
      <main className={detail ? "min-w-0 flex-1" : "min-w-0 flex-1 p-4 md:p-8"}>{children}</main>
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
    <span className="inline-flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      <span aria-hidden="true" data-tone={tone} className="data-[tone=danger]:text-destructive">{tone === "danger" ? "▲" : "■"}</span>
      <span>{text}</span>
      {status.last_export_ns !== null && <span className="text-muted-foreground" title="last export"><span> · </span>{formatAgo(status.last_export_ns)}</span>}
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
function FailedBanner({ problem, updatedAt, retrying, retry }: { problem: TelemetryProblem; updatedAt?: number; retrying: boolean; retry: () => void }) {
  const title = (problem.code && FAILURE_TITLES[problem.code]) ?? "telemetry could not be read";
  return (
    <Alert variant="destructive" className="mb-4 flex flex-wrap items-center justify-between gap-3 p-4 [&_h2]:font-semibold [&_p]:text-sm">
      <div>
        <h2>{title}</h2>
        <p>
          {updatedAt !== undefined ? <>showing data from {formatHour(updatedAt * 1e6)} · {formatAgo(updatedAt * 1e6).replace(" ago", " old")}</> : problem.message}
          {retrying && " · retrying every 5 s"}
        </p>
      </div>
      <Button variant="outline" type="button" className="text-destructive" onClick={retry}>retry now</Button>
    </Alert>
  );
}

const SETTING = '[otel]\nendpoint = "http://127.0.0.1:4323/v1/traces"';

/** T7. Without `openSettings` (no settings view has the telemetry row yet) the action is the settings.toml hint. */
function TelemetryOff({ openSettings }: { openSettings?: () => void }) {
  return (
    <Frame>
      <section className="grid max-w-3xl gap-4">
        <h1 className="text-xl font-semibold">Telemetry</h1>
        <p className="max-w-[64ch] text-pretty text-muted-foreground">Turn it on and Zeta records the timing of every turn, model call and tool call, with token counts. you get an agent tree and a waterfall for each session, plus totals per model and tool.</p>
        <div className="grid grid-cols-2 gap-3 border-y py-4 [&_ul]:list-disc [&_ul]:ps-4 [&_ul]:text-sm [&_h2]:mb-2 [&_h2]:font-semibold">
          <div><h2 className="text-foreground">Records</h2><ul><li>durations and status</li><li>model, provider, tokens</li><li>tool names and sizes</li><li>error types</li></ul></div>
          <div><h2 className="text-destructive">Never records</h2><ul><li>prompts or replies</li><li>reasoning</li><li>tool arguments or results</li><li>error messages, env values</li></ul></div>
        </div>
        <Card className="flex-row flex-wrap items-center justify-between gap-4 p-4 [&_h2]:font-semibold [&_pre]:overflow-auto [&_pre]:text-sm">
          <div>
            <h2>turn it on in settings</h2>
            <p className="text-muted-foreground">built-in receiver on 127.0.0.1:4323 · keeps 14 days raw, 90 days hourly, at most 1 GiB</p>
          </div>
          {openSettings
            ? <Button type="button" onClick={openSettings}>Open settings</Button>
            : <>
                <p>add this to <code>settings.toml</code> in your zeta home, then restart running sessions:</p>
                <pre>{SETTING}</pre>
              </>}
        </Card>
        {openSettings && <p className="text-sm text-muted-foreground">after you turn it on, new sessions send telemetry; zeta tells you which running sessions need a restart.</p>}
      </section>
    </Frame>
  );
}

/** `/telemetry/sessions/:id` until the session detail view lands. */
function NoTelemetryYet({ rangeLabel, widen }: { rangeLabel: string; widen?: () => void }) {
  return (
    <section className="grid max-w-[62ch] gap-3 py-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:font-semibold [&_p]:text-muted-foreground">
      <h1>no telemetry in the {rangeLabel}</h1>
      <p>sessions send spans when a turn ends. start a chat or wait for a running agent to finish its turn; it shows here within a few seconds.</p>
      <div className="flex flex-wrap gap-2">
        <Button asChild><a href="/">+ new chat</a></Button>
        {widen && <Button variant="outline" type="button" onClick={widen}>last 7 days</Button>}
      </div>
    </section>
  );
}
