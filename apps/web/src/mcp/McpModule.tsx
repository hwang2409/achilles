import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type RefObject } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { Confirmation, reviewText, type Result, type ReviewText } from "../surface/Confirmation";
import { WRITE_SURFACE } from "../writeSurfaces";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { connectionsRoute, surfaceHref } from "../surface/routes";
import { canReadMcp, mcpScopes, type McpRow, type McpScope } from "./mcpReads";
import { ConnectionDetail, ConnectionList, FailedRead, type Failure } from "./McpViews";
import { McpAdd } from "./McpAdd";
import { McpAuth, McpPendingElsewhere } from "./McpAuthActions";
import { McpActions } from "./McpActions";
import { needsMcpTestTrust, type McpOwner, type McpTestOutcome, type McpTestResult } from "./mcpOwner";
import "./mcp.css";

const LIST = connectionsRoute.path;
const detailOf = (path: string) => {
  const match = path.startsWith(`${LIST}/`) ? /^(user|project)\/([^/]+)$/.exec(path.slice(LIST.length + 1)) : null;
  if (!match) return null;
  try { return { scope: match[1] as McpRow["scope"], name: decodeURIComponent(match[2]) }; }
  catch { return null; }
};

export function McpModule({ client, owner, pathname, connecting, retryConnection }: {
  client: ZetaClient | null; owner: McpOwner; pathname: string; connecting: boolean; retryConnection: () => void;
}) {
  const { reads } = owner;
  const snapshot = useSyncExternalStore(reads.subscribe, reads.snapshot);
  const [path, setPath] = useState(pathname);
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState<McpScope>(() => detailOf(pathname)?.scope ?? "effective");
  const [retry, setRetry] = useState(0);
  const [reading, setReading] = useState(false);
  const focus = useRef(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const activeScope = useRef<HTMLButtonElement>(null);
  const connected = client !== null;
  const supported = client !== null && canReadMcp(client);
  useLayoutEffect(() => {
    const update = () => owner.auth.observe(client, !document.hidden, Boolean(client));
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [owner, client]);
  useLayoutEffect(() => () => owner.auth.observe(null, false, false), [owner]);
  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    setReading(true);
    void reads.refresh(client, abort.signal).finally(() => {
      if (!abort.signal.aborted) setReading(false);
    });
    return () => abort.abort();
    // a take control swaps the client: read again with the new authority, so an observer-era failure does not stay
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

  const rowRead = detailOpen ? detailList : list;
  const revision = rowRead && "revision" in rowRead ? rowRead.revision : undefined;
  const reviewScope = row && snapshot?.[row.scope];
  const reviewRow = reviewScope && "rows" in reviewScope ? reviewScope.rows.find(({ name }) => name === row?.name) : null;
  const reviewRevision = reviewScope && "revision" in reviewScope ? reviewScope.revision : null;
  const offline = !connected;
  const retained = offline && snapshot && mcpScopes.some((view) => "rows" in snapshot[view]);
  const shadows = (item: McpRow) => {
    if (item.scope === "user") return snapshot && "rows" in snapshot.effective
      && snapshot.effective.rows.some((effective) => effective.scope === "project" && effective.name === item.name) ? "shadowed by project" : null;
    return snapshot && "rows" in snapshot.user && snapshot.user.rows.some((user) => user.name === item.name) ? "shadows user" : null;
  };
  const retryRead = () => setRetry((count) => count + 1);
  const failure = (failure: Failure, project: boolean) => <FailedRead key={`${scope}:${failure.reason}`} failure={failure}
    project={project} retry={retryRead} reading={reading} offline={offline} />;

  const openAdd = () => setAdding(true);
  return <ModuleFrame title="Connections" actions={snapshot && !adding && <button type="button" className="ui-button" data-write-surface={WRITE_SURFACE.mcpAdd} disabled={!supported} onClick={openAdd}>Add connection</button>}>
    <div className="mcp-place">
      {client && !supported ? <ModuleState kind="unsupported" title="needs a newer zeta" detail="update zeta to manage MCP connections here" />
        : offline && !retained ? connecting ? <ModuleState kind="loading" title="connecting to zeta…" />
          : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: retryConnection }} />
        : !snapshot ? <ModuleState kind="loading" title="Reading MCP configuration…" />
        : <>
          {retained && <p className="mcp-offline" role="status">connection lost · showing the last read from disk · retrying automatically</p>}
          {adding && <section className="mcp-add" aria-label="Add a connection"><McpAdd close={() => setAdding(false)} owner={owner} snapshot={snapshot} defaultScope={scope === "project" ? "project" : "user"} online={supported}
            reviewTrust={(name) => { setScope("project"); navigate(`${LIST}/project/${encodeURIComponent(name)}`); }} /></section>}
          <McpPendingElsewhere owner={owner} row={detailOpen ? row : undefined} online={supported} />
          <div className="mcp-grid" data-detail={detailOpen} data-has-selection={!!row || detailOpen} data-retained={Boolean(retained)}>
            <ConnectionList snapshot={snapshot} scope={scope} selectScope={(view) => { setScope(view); if (detailOpen) navigate(LIST); }}
              addConnection={supported && !adding ? openAdd : undefined} activeScope={activeScope} row={row} detailOpen={detailOpen} offline={offline} shadows={shadows} go={go} failure={failure} />
            {(row || detailOpen) && <ConnectionDetail row={row} detailOpen={detailOpen} offline={offline} heading={detailHeading} shadows={shadows}
              detailList={detailList} project={detail?.scope === "project"} go={go} failure={failure}>
              {reviewRow?.config.transport && reviewRevision && <McpTest key={JSON.stringify([reviewRow.scope, reviewRow.name])} owner={owner} row={reviewRow} revision={reviewRevision} online={supported} heading={detailHeading} />}
              {reviewRow?.config.oauth && reviewRevision && <McpAuth key={JSON.stringify(["auth", reviewRow.scope, reviewRow.name])} owner={owner} row={reviewRow} revision={reviewRevision} online={supported} heading={detailHeading} />}
              <McpActions key={`${path}:${scope}`} owner={owner} heading={detailHeading} row={row ?? null} revision={revision} online={supported} />
            </ConnectionDetail>}
          </div>
        </>}
    </div>
  </ModuleFrame>;
}

const testAction = reviewText("test connection");
const testTrust = reviewText("trust this project stdio connection before testing it.");
const testUnknown = reviewText("result unknown. close this review to start a new test. the request was not retried.");
type TestReceipt = McpTestResult | { status: "unknown" };

function McpTest({ owner, row, revision, online, heading }: {
  owner: McpOwner; row: McpRow; revision: string; online: boolean; heading: RefObject<HTMLHeadingElement | null>;
}) {
  const opener = useRef<HTMLButtonElement>(null);
  const flight = useRef<string | null>(null);
  const [review, setReview] = useState<{ id: number; target: McpRow & { revision: string } } | null>(null);
  const [last, setLast] = useState<TestReceipt | null>(null);
  const target = { ...row, revision };
  const needsTrust = needsMcpTestTrust(target);
  const reviewed = review?.target;

  useLayoutEffect(() => () => { if (flight.current) owner.close(flight.current); }, [owner]);
  useEffect(() => { if (!online) setLast((prior) => prior?.status === "unknown" ? prior : null); }, [online]);

  async function execute(): Promise<Result<{ status: "committed"; receipt: ReviewText }>> {
    if (!reviewed) return { status: "failed", reason: "not-applied", message: testUnknown, final: true };
    const form = owner.open();
    flight.current = form;
    let result: McpTestOutcome | undefined;
    const detach = owner.attachTest(form, (outcome) => { result = outcome; });
    try { await owner.test(form, reviewed); }
    finally { detach(); owner.close(form); flight.current = null; }
    if (result?.status === "tested") {
      setLast(result.result);
      return { status: "committed", receipt: reviewText("test finished") };
    }
    if (result?.status === "unknown") setLast({ status: "unknown" });
    return { status: "failed", reason: "not-applied", message: testFailure(result?.status), final: true };
  }

  return <section className="mcp-test" aria-label="connection test">
    {needsTrust ? <p>{testTrust}</p> : <button ref={opener} type="button" className="ui-button" disabled={!online} data-write-surface={WRITE_SURFACE.mcpTest}
      onClick={() => setReview((prior) => ({ id: (prior?.id ?? 0) + 1, target }))}>{testAction}</button>}
    <div role="status">{last && <p data-test-result={last.status}>{testReceipt(last)}</p>}</div>
    {review && reviewed && <Confirmation key={review.id} level={2} external={{ opener: () => opener.current?.disabled === false ? opener.current : heading.current }}
      title={reviewText("review connection test")} action={testAction} keep={reviewText("keep without testing")}
      scope={reviewText(reviewed.scope)} proof={{ kind: "scope" }}
      fields={[{ label: reviewText("connection"), value: reviewed.name as ReviewText }]}
      current={reviewText("configuration on disk")} after={reviewText("configuration unchanged")}
      effect={reviewed.config.transport === "stdio"
        ? reviewText("zeta starts the configured local child process, initializes it and asks it to list tools. configured credentials may be sent. zeta calls no tools and enforces a time limit, then closes the transport and reaps the child.")
        : reviewText("zeta makes network requests to the configured HTTP endpoint, initializes it and asks it to list tools. configured credentials may be sent. zeta calls no tools and closes the transport after the test, including on timeout.")}
      undo={reviewText("the process or network activity cannot be undone. the test uses the current definition on disk.")}
      execute={execute} checkResult={async () => ({ status: "failed", reason: "not-applied", message: testUnknown, final: true })} />}
  </section>;
}

function testReceipt(result: TestReceipt) {
  if (result.status === "ok") return `${result.toolCount} ${result.toolCount === 1 ? "tool" : "tools"} (last test in this tab)`;
  if (result.status === "failed") return "failed (last test in this tab)";
  if (result.status === "untrusted") return `not trusted (last test in this tab) · ${testTrust}`;
  if (result.status === "skipped-policy") return "skipped by zeta policy (last test in this tab)";
  return "result unknown (last test in this tab)";
}

function testFailure(status: string | undefined) {
  switch (status) {
    case "refused": return reviewText("test not sent. too many tabs control zeta, or another app does. close one, then try again.");
    case "unsupported": return reviewText("test not sent. update zeta to test connections here.");
    case "busy": case "conflict": return reviewText("test not run. zeta or another connection action is busy; open a new review to try again.");
    case "stale": return reviewText("test not sent. the configuration changed. close this review and review the current definition before testing.");
    case "unavailable": return reviewText("zeta could not verify the current definition. read the configuration again before testing.");
    case "invalid": return reviewText("zeta could not test the current definition. read the configuration again before testing.");
    default: return testUnknown;
  }
}
