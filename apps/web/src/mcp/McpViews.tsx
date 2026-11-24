import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export function ConnectionList({ snapshot, scope, selectScope, activeScope, row, detailOpen, offline, shadows, go, failure, addConnection }: ViewProps & {
  snapshot: Snapshot; scope: McpScope; selectScope: (scope: McpScope) => void; activeScope: Ref<HTMLButtonElement>; addConnection?: () => void;
}) {
  const list = snapshot[scope];
  const rows = "rows" in list ? list.rows : [];
  return <section className="min-w-0 overflow-auto min-[961px]:group-data-[has-selection=true]:border-e max-[960px]:group-data-[detail=true]:hidden" aria-label="configured connections">
    <div className="px-4 py-2">
      <nav className="flex flex-wrap gap-1" aria-label="connection scope">
        {mcpScopes.map((view) => {
          const entry = snapshot[view];
          return <Button variant="outline" key={view} type="button" ref={scope === view ? activeScope : undefined}
            className="aria-pressed:bg-accent aria-pressed:text-accent-foreground" aria-pressed={scope === view} disabled={offline} onClick={() => selectScope(view)}>
            {view[0].toUpperCase() + view.slice(1)} {"rows" in entry ? <span className="text-xs text-muted-foreground">{entry.rows.length}</span> : <span aria-label="unavailable">—</span>}
          </Button>;
        })}
      </nav>
    </div>
    {list && "failure" in list ? failure(list.failure, scope === "project")
      : rows.length === 0 ? <ModuleState kind="empty" title="No connections yet" detail="Add a connection to make its tools available in new sessions." action={addConnection && { label: "Add connection", run: addConnection }} />
      : <ul className="divide-y border-y">{rows.map((item) => {
        const current = row?.name === item.name && row.scope === item.scope;
        const contents = <><span className="grid min-w-0 [&_strong]:truncate [&_strong]:font-semibold [&_small]:truncate [&_small]:text-muted-foreground"><strong title={item.name}>{item.name}</strong><small>{item.scope} · {transportOf(item)}{shadows(item) && ` · ${shadows(item)}`}</small></span>
          <Status row={item} /></>;
        const next = detailPath(item);
        return <li key={next} className="group/row" data-current={current}>
          {offline ? <span className="grid min-h-11 grid-cols-[minmax(0,1fr)_fit-content(40%)] items-center gap-2 px-4 py-2 group-data-[current=true]/row:bg-accent [&:is(a):hover]:bg-accent">{contents}</span> : <a className="grid min-h-11 grid-cols-[minmax(0,1fr)_fit-content(40%)] items-center gap-2 px-4 py-2 group-data-[current=true]/row:bg-accent [&:is(a):hover]:bg-accent" href={surfaceHref(next)} aria-current={current && detailOpen ? "page" : undefined} onClick={(event) => go(event, next)}>{contents}</a>}
        </li>;
      })}</ul>}
  </section>;
}

export function ConnectionDetail({ row, detailOpen, offline, heading, shadows, detailList, project, go, failure, children }: ViewProps & {
  heading: Ref<HTMLHeadingElement>; detailList: Snapshot[McpScope] | null | undefined; project: boolean; children: ReactNode;
}) {
  return <section className="min-w-0 overflow-auto p-4 wrap-anywhere max-[960px]:group-data-[detail=false]:hidden lg:p-8 [&_h2]:text-xl [&_h2]:font-semibold [&_dl]:mb-4 [&_dl]:grid [&_dl]:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] [&_dt]:border-b [&_dt]:py-2 [&_dt]:pe-2 [&_dt]:text-muted-foreground [&_dd]:border-b [&_dd]:py-2" aria-label="connection detail">
    {!offline && detailOpen && <a className="mb-2 inline-flex min-h-11 items-center text-sm text-accent-foreground hover:underline min-[961px]:hidden" href={surfaceHref(LIST)} onClick={(event) => go(event, LIST)}>‹ back to connections</a>}
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3 [&>div:empty]:hidden">
      {row ? <div><h2 ref={heading} tabIndex={-1}>{row.name}</h2>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><Status row={row} /><span>{row.scope === "user" ? "User" : "Project"} scope{shadows(row) ? ` (${shadows(row)})` : ""}</span></p></div>
        : detailOpen ? <h2 ref={heading} tabIndex={-1}>connection detail</h2> : null}
      {children}
    </header>
    {row ? <ConnectionFields row={row} /> : detailOpen && (detailList && "failure" in detailList ? failure(detailList.failure, project)
      : <ModuleState kind="empty" title="connection not found" detail="choose a connection from the list" />)}
  </section>;
}

function Status({ row }: { row: McpRow }) {
  const status = statusOf(row);
  return <Badge variant="outline" className="justify-self-end whitespace-normal wrap-anywhere data-[status=malformed]:text-destructive" data-status={status}>{labels[status]}</Badge>;
}

function ConnectionFields({ row }: { row: McpRow }) {
  const config = row.config;
  return <>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm text-muted-foreground [&_h3]:font-semibold [&_h3]:text-foreground"><h3>Configuration</h3><span>Secrets are hidden</span></div>
    <dl>
      <dt>transport</dt><dd>{transportOf(row)}</dd>
      {config.transport === "stdio" && <>
        <dt>command</dt><dd>{config.commandProvided ? "local command provided (redacted)" : "not provided"}</dd>
        <dt>arguments</dt><dd>{config.args}</dd>
      </>}
      {config.transport === "streamable-http" && <>
        <dt>URL</dt><dd>{config.urlProvided ? "remote URL provided (redacted)" : "not provided"}</dd>
        <dt>headers</dt><dd>{config.headers} {config.headers === 1 ? "header" : "headers"} provided{config.headers > 0 && " (redacted)"}</dd>
      </>}
      <dt>environment</dt><dd>{config.env} environment {config.env === 1 ? "value" : "values"} provided{config.env > 0 && " (redacted)"}</dd>
      <dt>trust</dt><dd>{row.trusted ? "trusted" : "not trusted"}</dd>
      {config.oauth && <>
        <dt>client secret</dt><dd>{config.oauth.secretProvided ? "provided (redacted)" : "not provided"}</dd>
      </>}
    </dl>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm text-muted-foreground [&_h3]:font-semibold [&_h3]:text-foreground"><h3>Tools <small>{row.toolCount}</small></h3><span>Reported by Zeta, not checked live</span></div>
    {row.toolCount === 0 && <ModuleState kind="empty" title="No tools reported" detail="Zeta has not reported any tools for this connection." />}
  </>;
}

export type Failure = Extract<NonNullable<ReturnType<McpReads["snapshot"]>>[McpScope], { failure: unknown }>["failure"];
export function FailedRead({ failure, project, retry, reading, offline }: { failure: Failure; project: boolean; retry: () => void; reading: boolean; offline: boolean }) {
  const [copied, setCopied] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(failure)); setCopied("details copied"); }
    catch { setCopied("could not copy details"); }
  };
  return <div className="grid gap-2">
    <ModuleState kind="failed" title="zeta could not read mcp configuration" detail={project ? "zeta’s current project is unavailable or its configuration could not be read."
      : failure.reason === "operation_busy" ? "zeta is busy. try again." : "retry to read the current configuration from disk."} />
    {!offline && <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
      <Button variant="outline" type="button" onClick={retry} disabled={reading}>{reading ? "reading…" : "retry"}</Button>
      <Button variant="outline" type="button" onClick={() => void copy()}>copy details</Button>
      <span role="status">{copied}</span>
    </div>}
  </div>;
}
