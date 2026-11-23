import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type Ref } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { connectionsRoute, surfaceHref } from "../surface/routes";
import { canReadMcp, mcpScopes, type McpReads, type McpRow, type McpScope } from "./mcpReads";
import "./mcp.css";

const LIST = connectionsRoute.path;
const labels = {
  configured: "configured", disabled: "off", "pending trust": "needs trust",
  "skipped-missing-env": "missing configured environment", malformed: "invalid definition",
};
const statusOf = (row: McpRow) => row.status === "configured" && !row.trusted ? "pending trust" : row.status;
const transportOf = (row: McpRow) => row.config.transport === "stdio" ? "local command"
  : row.config.transport === "streamable-http" ? "remote HTTP" : "not available";
const detailPath = (row: McpRow) => `${LIST}/${row.scope}/${encodeURIComponent(row.name)}`;
const detailOf = (path: string) => {
  const match = path.startsWith(`${LIST}/`) ? /^(user|project)\/([^/]+)$/.exec(path.slice(LIST.length + 1)) : null;
  if (!match) return null;
  try { return { scope: match[1] as McpRow["scope"], name: decodeURIComponent(match[2]) }; }
  catch { return null; }
};

export function McpModule({ client, reads, pathname, connecting, retryConnection }: {
  client: ZetaClient | null; reads: McpReads; pathname: string; connecting: boolean; retryConnection: () => void;
}) {
  const snapshot = useSyncExternalStore(reads.subscribe, reads.snapshot);
  const [path, setPath] = useState(pathname);
  const [scope, setScope] = useState<McpScope>(() => detailOf(pathname)?.scope ?? "effective");
  const [retry, setRetry] = useState(0);
  const [reading, setReading] = useState(false);
  const focus = useRef(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const activeScope = useRef<HTMLButtonElement>(null);
  const supported = client !== null && canReadMcp(client);
  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    setReading(true);
    void reads.refresh(client, abort.signal).finally(() => {
      if (!abort.signal.aborted) setReading(false);
    });
    return () => abort.abort();
  }, [client, reads, retry]);
  useEffect(() => {
    const back = () => { focus.current = true; setPath(location.pathname); };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const navigate = (next: string) => {
    if (next === path) return;
    history.pushState(null, "", surfaceHref(next));
    focus.current = true;
    setPath(next);
  };
  const go = (event: MouseEvent<HTMLAnchorElement>, next: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(next);
  };
  const detail = detailOf(path);
  const detailOpen = path !== LIST && path !== `${LIST}/`;
  const list = snapshot?.[scope];
  const rows = list && "rows" in list ? list.rows : [];
  const detailList = detail && snapshot?.[detail.scope];
  const row = !detailOpen ? rows[0] : detail && detailList && "rows" in detailList
    ? detailList.rows.find((candidate) => candidate.name === detail.name) : null;
  useEffect(() => {
    if (!focus.current) return;
    const target = detailOpen ? detailHeading.current : activeScope.current;
    if (target) { target.focus(); focus.current = false; }
  }, [detailOpen, path, row]);

  const offline = client === null;
  const retained = offline && snapshot && mcpScopes.some((view) => "rows" in snapshot[view]);
  const shadows = (item: McpRow) => {
    if (item.scope === "user") return snapshot && "rows" in snapshot.effective
      && snapshot.effective.rows.some((effective) => effective.scope === "project" && effective.name === item.name) ? "shadowed by project" : null;
    return snapshot && "rows" in snapshot.user && snapshot.user.rows.some((user) => user.name === item.name) ? "shadows user" : null;
  };
  const retryRead = () => setRetry((count) => count + 1);
  const failure = (failure: Failure, project: boolean) => <FailedRead key={`${scope}:${failure.reason}`} failure={failure}
    project={project} retry={retryRead} reading={reading} offline={offline} />;

  return <ModuleFrame title="mcp connections">
    <div className="mcp-place">
      <p className="mcp-context">configuration for new sessions · user + zeta’s current project</p>
      {client && !supported ? <ModuleState kind="unsupported" title="needs a newer zeta" detail="update zeta to manage mcp connections here" />
        : offline && !retained ? connecting ? <ModuleState kind="loading" title="connecting to zeta…" />
          : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: retryConnection }} />
        : !snapshot ? <ModuleState kind="loading" title="reading mcp configuration…" />
        : <>
          {retained && <p className="mcp-offline" role="status">connection lost · showing the last read from disk · retrying automatically</p>}
          <div className="mcp-grid" data-detail={detailOpen} data-retained={Boolean(retained)}>
            <section className="mcp-list" aria-label="configured connections">
              <div className="mcp-list-head">
                <nav className="mcp-scopes" aria-label="connection scope">
                  {mcpScopes.map((view) => {
                    const entry = snapshot[view];
                    return <button key={view} type="button" ref={scope === view ? activeScope : undefined}
                      aria-pressed={scope === view} disabled={offline} onClick={() => { setScope(view); if (detailOpen) navigate(LIST); }}>
                      {view} {"rows" in entry ? <span>{entry.rows.length}</span> : <span aria-label="unavailable">—</span>}
                    </button>;
                  })}
                </nav>
                {list && "at" in list && <time dateTime={new Date(list.at).toISOString()}>read from disk at {new Date(list.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase()}</time>}
              </div>
              {list && "failure" in list ? failure(list.failure, scope === "project")
                : rows.length === 0 ? <ModuleState kind="empty" title="no mcp connections for this scope" />
                : <ul className="mcp-rows">{rows.map((item) => {
                  const current = row?.name === item.name && row.scope === item.scope;
                  const contents = <><span className="mcp-row-title"><strong>{item.name}</strong><small>{item.scope} · {transportOf(item)}{shadows(item) && ` · ${shadows(item)}`}</small></span>
                    <Status row={item} /></>;
                  const next = detailPath(item);
                  return <li key={next} data-current={current}>
                    {offline ? <span className="mcp-row">{contents}</span> : <a className="mcp-row" href={surfaceHref(next)} aria-current={current && detailOpen ? "page" : undefined} onClick={(event) => go(event, next)}>{contents}</a>}
                  </li>;
                })}</ul>}
            </section>
            <section className="mcp-detail" aria-label="connection detail">
              {!offline && detailOpen && <a className="mcp-back" href={surfaceHref(LIST)} onClick={(event) => go(event, LIST)}>‹ back to connections</a>}
              {row ? <ConnectionDetail row={row} shadows={shadows(row)} heading={detailHeading} />
                : detailOpen ? <>
                  <h2 ref={detailHeading} tabIndex={-1}>connection detail</h2>
                  {detailList && "failure" in detailList ? failure(detailList.failure, detail?.scope === "project")
                    : <ModuleState kind="empty" title="connection not found" detail="choose a connection from the list" />}
                </> : null}
            </section>
          </div>
        </>}
    </div>
  </ModuleFrame>;
}

function Status({ row }: { row: McpRow }) {
  const status = statusOf(row);
  return <span className="mcp-status" data-status={status}>{labels[status]}</span>;
}

function ConnectionDetail({ row, shadows, heading }: { row: McpRow; shadows: string | null; heading: Ref<HTMLHeadingElement> }) {
  const config = row.config;
  return <>
    <h2 ref={heading} tabIndex={-1}>{row.name}</h2>
    <p className="mcp-detail-meta"><Status row={row} /><span>{row.scope} scope · {row.enabled ? "enabled" : "disabled"} in config{shadows && ` · ${shadows}`}</span></p>
    <div className="mcp-rule"><h3>config</h3><span>secrets are never shown here</span></div>
    <dl>
      <dt>transport</dt><dd>{transportOf(row)}</dd>
      {config.transport === "stdio" && <>
        <dt>command</dt><dd>{config.commandProvided ? "local command provided · redacted" : "not provided"}</dd>
        <dt>arguments</dt><dd>{config.args}</dd>
      </>}
      {config.transport === "streamable-http" && <>
        <dt>URL</dt><dd>{config.urlProvided ? "remote URL provided · redacted" : "not provided"}</dd>
        <dt>headers</dt><dd>{config.headers} {config.headers === 1 ? "header" : "headers"} provided{config.headers > 0 && " · redacted"}</dd>
      </>}
      <dt>environment</dt><dd>{config.env} environment {config.env === 1 ? "value" : "values"} provided{config.env > 0 && " · redacted"}</dd>
      <dt>trust</dt><dd>{row.trusted ? "trusted" : "not trusted"}</dd>
      {config.oauth && <>
        <dt>auth</dt><dd>OAuth configured{row.auth === "unauthorized" && " · authorization was not confirmed"}</dd>
        <dt>client id</dt><dd>not reported</dd>
        <dt>client secret</dt><dd>{config.oauth.secretProvided ? "provided · redacted" : "not provided"}</dd>
      </>}
    </dl>
    <div className="mcp-rule"><h3>tools · {row.toolCount}</h3><span>reported by zeta · no live check</span></div>
  </>;
}

type Failure = Extract<NonNullable<ReturnType<McpReads["snapshot"]>>[McpScope], { failure: unknown }>["failure"];
function FailedRead({ failure, project, retry, reading, offline }: { failure: Failure; project: boolean; retry: () => void; reading: boolean; offline: boolean }) {
  const [copied, setCopied] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(failure)); setCopied("details copied"); }
    catch { setCopied("could not copy details"); }
  };
  return <div className="mcp-failure">
    <ModuleState kind="failed" title="zeta could not read mcp configuration" detail={project ? "zeta’s current project is unavailable or its configuration could not be read."
      : failure.reason === "operation_busy" ? "zeta is busy. try again." : "retry to read the current configuration from disk."} />
    {!offline && <div className="mcp-failure-actions">
      <button type="button" className="primary" onClick={retry} disabled={reading}>{reading ? "reading…" : "retry"}</button>
      <button type="button" onClick={() => void copy()}>copy details</button>
      <span role="status">{copied}</span>
    </div>}
  </div>;
}
