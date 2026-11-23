import { useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { ModuleState } from "../surface/ModuleState";
import { connectionsRoute, surfaceHref } from "../surface/routes";
import { mcpScopes, type McpReads, type McpRow, type McpScope } from "./mcpReads";

const LIST = connectionsRoute.path;
const labels = {
  configured: "configured", disabled: "off", "pending trust": "needs trust",
  "skipped-missing-env": "missing configured environment", malformed: "invalid definition",
};
const statusOf = (row: McpRow) => row.status === "configured" && !row.trusted ? "pending trust" : row.status;
const transportOf = (row: McpRow) => row.config.transport === "stdio" ? "local command"
  : row.config.transport === "streamable-http" ? "remote HTTP" : "not available";
const detailPath = (row: McpRow) => `${LIST}/${row.scope}/${encodeURIComponent(row.name)}`;

type Snapshot = NonNullable<ReturnType<McpReads["snapshot"]>>;
type ViewProps = {
  row: McpRow | null | undefined;
  detailOpen: boolean;
  offline: boolean;
  shadows: (row: McpRow) => string | null;
  go: (event: MouseEvent<HTMLAnchorElement>, path: string) => void;
  failure: (failure: Failure, project: boolean) => ReactNode;
};

export function ConnectionList({ snapshot, scope, selectScope, activeScope, row, detailOpen, offline, shadows, go, failure }: ViewProps & {
  snapshot: Snapshot; scope: McpScope; selectScope: (scope: McpScope) => void; activeScope: Ref<HTMLButtonElement>;
}) {
  const list = snapshot[scope];
  const rows = "rows" in list ? list.rows : [];
  return <section className="mcp-list" aria-label="configured connections">
    <div className="mcp-list-head">
      <nav className="mcp-scopes" aria-label="connection scope">
        {mcpScopes.map((view) => {
          const entry = snapshot[view];
          return <button key={view} type="button" ref={scope === view ? activeScope : undefined}
            aria-pressed={scope === view} disabled={offline} onClick={() => selectScope(view)}>
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
  </section>;
}

export function ConnectionDetail({ row, detailOpen, offline, heading, shadows, detailList, project, go, failure, children }: ViewProps & {
  heading: Ref<HTMLHeadingElement>; detailList: Snapshot[McpScope] | null | undefined; project: boolean; children: ReactNode;
}) {
  return <section className="mcp-detail" aria-label="connection detail">
    {!offline && detailOpen && <a className="mcp-back" href={surfaceHref(LIST)} onClick={(event) => go(event, LIST)}>‹ back to connections</a>}
    {row ? <ConnectionFields row={row} shadows={shadows(row)} heading={heading} />
      : detailOpen ? <>
        <h2 ref={heading} tabIndex={-1}>connection detail</h2>
        {detailList && "failure" in detailList ? failure(detailList.failure, project)
          : <ModuleState kind="empty" title="connection not found" detail="choose a connection from the list" />}
      </> : null}
    {children}
  </section>;
}

function Status({ row }: { row: McpRow }) {
  const status = statusOf(row);
  return <span className="mcp-status" data-status={status}>{labels[status]}</span>;
}

function ConnectionFields({ row, shadows, heading }: { row: McpRow; shadows: string | null; heading: Ref<HTMLHeadingElement> }) {
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
        <dt>auth</dt><dd>oauth configured · sign-in state not checked</dd>
        <dt>client id</dt><dd>not reported</dd>
        <dt>client secret</dt><dd>{config.oauth.secretProvided ? "provided · redacted" : "not provided"}</dd>
      </>}
    </dl>
    <div className="mcp-rule"><h3>tools · {row.toolCount}</h3><span>reported by zeta · no live check</span></div>
  </>;
}

export type Failure = Extract<NonNullable<ReturnType<McpReads["snapshot"]>>[McpScope], { failure: unknown }>["failure"];
export function FailedRead({ failure, project, retry, reading, offline }: { failure: Failure; project: boolean; retry: () => void; reading: boolean; offline: boolean }) {
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
