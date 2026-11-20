import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AgentSurface } from "../App";
import { useBuildActivity, type BuildActivity } from "../create/buildActivity";
import { AppShell, type AppShellProps } from "../AppShell";
import { PagesLanding } from "../page/PagesLanding";
import { LibraryModule } from "../library/LibraryModule";
import { TelemetryModule } from "../telemetry/TelemetryModule";
import { createConnection, isObserverPresentation, supportsFeature, supportsRequest, type Connection } from "../zeta";
import { libraryMethods, type LibraryKind } from "../library/catalog";
import { writeAccess } from "../library/libraryWrites";
import type { ZetaClient } from "@fulcrum/zeta";
import { useAgentNavAdapter } from "./AgentNavAdapter";
import { ModuleFrame, ModuleState } from "./ModuleState";
import { chatsRoute, createRoute, matchSurfaceRoute, newChatIntent, surfaceHref, type SurfaceRoute } from "./routes";

const connectionLabels: Partial<Record<Connection["state"]["phase"], string>> = { connected: "zeta connected", connecting: "connecting to zeta", not_running: "zeta is not running" };

export function SurfaceRouter() {
  const [{ route, pathname, connection, readOnly }] = useState(() => {
    const pathname = location.pathname;
    const route = matchSurfaceRoute(pathname);
    const readOnly = route !== undefined && route !== chatsRoute && route !== createRoute;
    // library tabs browse as observers and take control only when the user starts a write.
    const mode = !readOnly ? undefined : route.id === "skills" || route.id === "agent-profiles" ? "upgradable" : "locked";
    return { route, pathname, connection: createConnection({ origin: location.origin, readOnly: mode }), readOnly };
  });
  const connectionState = useSyncExternalStore(connection.subscribe, () => connection.state);
  const client = connection.client;
  useEffect(() => () => connection.stop(), [connection]);
  const phase = connectionState.phase;
  const connectionStatus = { connected: phase === "connected", label: connectionLabels[phase] ?? "zeta is disconnected" };
  const observer = isObserverPresentation(connectionState, connection.observerPresentation);
  const controller = connectionState.phase === "connected" && connectionState.authority === "controller";
  // The library's take-control reason lives here: a socket replace unmounts the library module, not the router.
  const [libraryControl, setLibraryControl] = useState<string | null>(null);
  const takeLibraryControl = async () => {
    setLibraryControl(null);
    const reason = await connection.takeControl();
    setLibraryControl(reason);
    return reason;
  };
  const observerBanner = observer && <ObserverBanner connection={connection} readOnly={readOnly} />;
  const renderShell: RenderShell = (props) => <BuildShell {...props} client={client} />;
  if (!readOnly) {
    return <AgentSurface connection={connection} client={client} connectionState={connectionState} observerBanner={observerBanner} renderShell={renderShell}
      current={route ?? chatsRoute} homeAlias={chatsRoute.path} connectionStatus={connectionStatus} />;
  }
  if (!route) return null;
  const connecting = phase === "connected" || (phase === "connecting" && connectionState.attempt === 0);
  let content: ReactNode;
  if (route.id === "telemetry" || route.id === "skills" || route.id === "agent-profiles") {
    content = client ? (route.id === "telemetry" ? <TelemetryModule client={client} pathname={pathname} />
      : <LibraryModule key={route.id} client={client} kind={route.id} reads={libraryReads(client, route.id)}
        write={libraryWrite(client, route.id, controller, takeLibraryControl, libraryControl)} />) : <ModuleFrame title={route.label}>
      {connecting ? <ModuleState kind="loading" title="connecting to zeta…" />
        : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: () => connection.retryNow() }} />}
    </ModuleFrame>;
  } else if (route.id !== "pages" && route.id !== "settings") {
    content = <ModuleFrame title={route.label}><ModuleState kind="unsupported" title="not available in this build" /></ModuleFrame>;
  }
  return <CatalogShell renderShell={renderShell} route={route} connectionStatus={connectionStatus} banner={route.id === "telemetry" ? observerBanner : null}>{content}</CatalogShell>;
}

// library_read_v1 path when hello granted it; each exact method is checked, so a catalog can work without its read.
function libraryReads(client: ZetaClient, kind: LibraryKind) {
  const methods = libraryMethods(kind);
  const granted = supportsFeature(client, "library_read_v1");
  return { catalog: granted && supportsRequest(client, methods.catalog), read: granted && supportsRequest(client, methods.read) };
}

function libraryWrite(client: ZetaClient, kind: LibraryKind, controller: boolean, takeControl: () => Promise<string | null>, feedback: string | null) {
  const access = writeAccess(client, kind, controller);
  return access === "none" ? null : { controller, allowed: access === "allowed", takeControl, feedback };
}

type BuildShellProps = Omit<AppShellProps, "activity" | "children"> & { children: (activity: BuildActivity) => ReactNode };
export type RenderShell = (props: BuildShellProps) => ReactNode;

function BuildShell({ client, children, ...props }: BuildShellProps & { client: ZetaClient | null }) {
  const { recentChats, pageCatalog, reloadPages } = props.nav;
  const activity = useBuildActivity({ client, chats: recentChats, pages: pageCatalog.error ? null : pageCatalog.items, reloadPages });
  return <AppShell {...props} activity={activity}>{children(activity)}</AppShell>;
}

function CatalogShell({ renderShell, route, connectionStatus, banner, children }: { renderShell: RenderShell; route: SurfaceRoute; connectionStatus: { label: string; connected: boolean }; banner?: ReactNode; children: ReactNode }) {
  const nav = useAgentNavAdapter({ sessionId: null, waiting: 0, canWrite: false, refreshKey: 0, pageRefreshKey: 0 });
  return renderShell({ current: route, nav, banner, connectionStatus,
    newChat: { available: connectionStatus.connected, run: () => location.assign(surfaceHref(chatsRoute.path) + newChatIntent) },
    children: () => route.id === "pages" ? <PagesLanding catalog={nav.pageCatalog} reload={nav.reloadPages} more={nav.morePages} /> : children,
  });
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
