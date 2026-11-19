import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AgentSurface } from "../App";
import { AppShell } from "../AppShell";
import { TelemetryModule } from "../telemetry/TelemetryModule";
import { createConnection, isObserverPresentation, type Connection } from "../zeta";
import { useAgentNavAdapter } from "./AgentNavAdapter";
import { ModuleFrame, ModuleState } from "./ModuleState";
import { chatsRoute, matchSurfaceRoute, type SurfaceRoute } from "./routes";

const connectionLabels: Partial<Record<Connection["state"]["phase"], string>> = { connected: "zeta connected", connecting: "connecting to zeta", not_running: "zeta is not running" };

export function SurfaceRouter() {
  const [{ route, pathname, connection, readOnly }] = useState(() => {
    const pathname = location.pathname;
    const route = matchSurfaceRoute(pathname);
    const readOnly = route !== undefined && (route.capability !== "agent" || route.id !== "chats");
    return { route, pathname, connection: createConnection({ origin: location.origin, readOnly }), readOnly };
  });
  const connectionState = useSyncExternalStore(connection.subscribe, () => connection.state);
  const client = connection.client;
  useEffect(() => () => connection.stop(), [connection]);
  const phase = connectionState.phase;
  const connectionStatus = { connected: phase === "connected", label: connectionLabels[phase] ?? "zeta is disconnected" };
  const observer = isObserverPresentation(connectionState, connection.observerPresentation);
  const observerBanner = observer && <ObserverBanner connection={connection} readOnly={readOnly} />;
  if (!route || route.id === "chats") {
    return <AgentSurface connection={connection} client={client} connectionState={connectionState} observerBanner={observerBanner}
      current={chatsRoute} homeAlias={route?.path} connectionStatus={connectionStatus} />;
  }
  const connecting = phase === "connected" || (phase === "connecting" && connectionState.attempt === 0);
  let content: ReactNode;
  if (route.id === "telemetry") {
    content = client ? <TelemetryModule client={client} pathname={pathname} /> : <ModuleFrame title={route.label}>
      {connecting ? <ModuleState kind="loading" title="connecting to zeta…" />
        : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: () => connection.retryNow() }} />}
    </ModuleFrame>;
  } else if (route.id !== "pages") {
    content = <ModuleFrame title={route.label}><ModuleState kind="unsupported" title="not available in this build" /></ModuleFrame>;
  }
  return <CatalogShell route={route} connectionStatus={connectionStatus} banner={route.id === "telemetry" ? observerBanner : null}>{content}</CatalogShell>;
}

function CatalogShell({ route, connectionStatus, banner, children }: { route: SurfaceRoute; connectionStatus: { label: string; connected: boolean }; banner?: ReactNode; children: ReactNode }) {
  const nav = useAgentNavAdapter({ sessionId: null, waiting: 0, canWrite: false, refreshKey: 0, pageRefreshKey: 0 });
  return <AppShell current={route} nav={nav} banner={banner} connectionStatus={connectionStatus}>
    {route.id === "pages" ? <ModuleFrame title={route.label}>{nav.pages()}</ModuleFrame> : children}
  </AppShell>;
}

function ObserverBanner({ connection, readOnly }: { connection: Connection; readOnly: boolean }) {
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const takeControl = async () => {
    setWorking(true); setFeedback(null);
    const reason = await connection.takeControl();
    setWorking(false);
    setFeedback(reason);
  };
  return <aside className="observer-banner" aria-label="observer mode">
    <div>
      <strong>{readOnly ? "this page is read-only" : "another tab controls zeta"}</strong>
      <span>{readOnly ? "open a chat to control zeta." : "this tab is live and read-only. you can browse chats and pages, but sending, approvals, and changes are disabled."}</span>
    </div>
    {!readOnly && <div className="observer-action"><button type="button" aria-describedby={feedback ? "take-control-feedback" : undefined} onClick={() => void takeControl()} disabled={working}>{working ? "taking control…" : "take control"}</button><span id="take-control-feedback" role="status">{feedback}</span></div>}
  </aside>;
}

