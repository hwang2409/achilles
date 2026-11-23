import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { connectionsRoute, surfaceHref } from "../surface/routes";
import { canReadMcp, mcpScopes, type McpReads, type McpRow, type McpScope } from "./mcpReads";
import { ConnectionDetail, ConnectionList, FailedRead, type Failure } from "./McpViews";
import "./mcp.css";

const LIST = connectionsRoute.path;
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
            <ConnectionList snapshot={snapshot} scope={scope} selectScope={(view) => { setScope(view); if (detailOpen) navigate(LIST); }}
              activeScope={activeScope} row={row} detailOpen={detailOpen} offline={offline} shadows={shadows} go={go} failure={failure} />
            <ConnectionDetail row={row} detailOpen={detailOpen} offline={offline} heading={detailHeading} shadows={shadows}
              detailList={detailList} project={detail?.scope === "project"} go={go} failure={failure} />
          </div>
        </>}
    </div>
  </ModuleFrame>;
}
