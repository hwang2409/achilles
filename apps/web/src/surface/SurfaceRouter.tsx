import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AgentSurface } from "../App";
import { useBuildActivity, type BuildActivity } from "../create/buildActivity";
import { AppShell, type AppShellProps } from "../AppShell";
import { PagesLanding } from "../page/PagesLanding";
import { LibraryModule } from "../library/LibraryModule";
import { TelemetryModule } from "../telemetry/TelemetryModule";
import { useMemoryActions } from "../projects/MemoryActions";
import { ProjectsModule } from "../projects/ProjectsModule";
import { createChildSendOwner } from "../agents/childSend";
import { AgentsModule } from "../agents/AgentsModule";
import { SessionsModule } from "../sessions/SessionsModule";
import { McpModule } from "../mcp/McpModule";
import { createMcpOwner } from "../mcp/mcpOwner";
import { createAccountLogin } from "../accounts/accountLogin";
import { AccountSwitchProvider } from "../accounts/AccountSwitchReview";
import { AccountsModule } from "../accounts/AccountsModule";
import { SettingsModule } from "../settings/SettingsModule";
import { HOME_SETTINGS_FEATURE } from "../settings/homeSettings";
import { createConnection, isObserverPresentation, supportsFeature, supportsRequest, type Connection } from "../zeta";
import { libraryMethods, type LibraryKind } from "../library/catalog";
import { createLibraryWriter, writeAccess, type LibraryWriter } from "../library/libraryWrites";
import type { CreateDraft, EditDraft } from "../library/LibraryEditor";
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
    // Write-capable places browse as observers and take control only when the user asks for it.
    const mode = !readOnly ? undefined : route.id === "skills" || route.id === "agent-profiles" || route.id === "projects" || route.id === "connections" || route.id === "settings" || route.id === "accounts" || route.id === "agents" ? "upgradable" : "locked";
    return { route, pathname, connection: createConnection({ origin: location.origin, readOnly: mode }), readOnly };
  });
  const connectionState = useSyncExternalStore(connection.subscribe, () => connection.state);
  const client = connection.client;
  const [accountLogin] = useState(() => createAccountLogin(connection));
  useEffect(() => () => { accountLogin.stop(); connection.stop(); }, [accountLogin, connection]);
  const phase = connectionState.phase;
  const connectionStatus = { connected: phase === "connected", label: connectionLabels[phase] ?? "zeta is disconnected" };
  const observer = isObserverPresentation(connectionState, connection.observerPresentation);
  const controller = connectionState.phase === "connected" && connectionState.authority === "controller";
  // The library's take-control reason and drafts live here: a socket replace unmounts the library module, not the router.
  const [libraryControl, setLibraryControl] = useState<string | null>(null);
  const [libraryDrafts] = useState(() => new Map<string, CreateDraft>());
  const [libraryEdits] = useState(() => new Map<LibraryKind, EditDraft>());
  // reveals a dropped socket cut short: the drop unmounts the projects module, and the reveal says why on remount.
  const [projectsDropped] = useState(() => new Set<string>());
  const memoryActions = useMemoryActions({
    live: () => connection.state.phase === "connected" && connection.state.authority === "controller" ? connection.client : null,
    take: connection.takeControl,
    release: connection.releaseControl,
  });
  // the one library writer: a save and its outcome outlive the remount; it settles reads on the current client.
  const [libraryWriter] = useState(() => createLibraryWriter(undefined, () => connection.client));
  const [childSend] = useState(() => createChildSendOwner(connection));
  const [mcpOwner] = useState(() => createMcpOwner({
    live: () => connection.client,
    acquire: async () => await connection.takeControl() === null && connection.state.phase === "connected"
      && connection.state.authority === "controller" ? connection.client : null,
    release: connection.releaseControl,
  }));
  const [liveClient] = useState(() => () => connection.client);
  const takeLibraryControl = async () => {
    setLibraryControl(null);
    const reason = await connection.takeControl();
    setLibraryControl(reason);
    return reason;
  };
  const observerBanner = observer && route?.id !== "accounts" && <ObserverBanner connection={connection} readOnly={readOnly} />;
  const renderShell: RenderShell = (props) => <BuildShell {...props} client={client} />;
  if (!readOnly) {
    return <AccountSwitchProvider connection={connection}><AgentSurface accountLogin={accountLogin} connection={connection} client={client} connectionState={connectionState} observerBanner={observerBanner} renderShell={renderShell}
      current={route ?? chatsRoute} homeAlias={chatsRoute.path} connectionStatus={connectionStatus} /></AccountSwitchProvider>;
  }
  if (!route) return null;
  const connecting = phase === "connected" || (phase === "connecting" && connectionState.attempt === 0);
  let content: ReactNode;
  if (route.id === "telemetry" || route.id === "skills" || route.id === "agent-profiles" || route.id === "projects") {
    content = client ? (route.id === "telemetry" ? <TelemetryModule client={client} pathname={pathname}
      openTelemetrySettings={supportsFeature(client, HOME_SETTINGS_FEATURE) ? () => location.assign(surfaceHref("/settings") + "#telemetry") : undefined} />
      : route.id === "projects" ? <ProjectsModule client={client} actions={memoryActions} control={{ observer: !controller, withControl: (read) => connection.withControl(read), dropped: projectsDropped }} />
      : <LibraryModule key={route.id} client={client} kind={route.id} reads={libraryReads(client, route.id)}
        write={libraryWrite(client, route.id, controller, takeLibraryControl, controller ? null : libraryControl, libraryDrafts, libraryEdits, libraryWriter, () => void connection.releaseControl())} />) : <ModuleFrame title={route.label}>
      {connecting ? <ModuleState kind="loading" title="connecting to zeta…" />
        : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: () => connection.retryNow() }} />}
    </ModuleFrame>;
  } else if (route.id === "agents") {
    content = <AgentsModule send={childSend} client={client} connecting={connecting} retry={() => connection.retryNow()} />;
  } else if (route.id === "connections") {
    content = <McpModule client={client} owner={mcpOwner} pathname={pathname} connecting={connecting} retryConnection={() => connection.retryNow()} />;
  } else if (route.id === "settings") {
    content = <SettingsModule client={client} connecting={connecting} withControl={(read) => connection.withControl(read)} live={liveClient} />;
  } else if (route.id === "accounts") {
    content = <AccountSwitchProvider connection={connection}><AccountsModule login={accountLogin} client={client} connecting={connecting} connection={connection} /></AccountSwitchProvider>;
  } else if (route.id !== "pages") {
    content = <ModuleFrame title={route.label}><ModuleState kind="unsupported" title="not available in this build" /></ModuleFrame>;
  }
  return <CatalogShell renderShell={renderShell} route={route} connectionStatus={connectionStatus} banner={route.id === "telemetry" ? observerBanner : null}
    sessions={route.id === "sessions" ? { client, connecting, retry: () => connection.retryNow() } : undefined}>{content}{route.id === "projects" && memoryActions.dialog}</CatalogShell>;
}

// library_read_v1 path when hello granted it; each exact method is checked, so a catalog can work without its read.
function libraryReads(client: ZetaClient, kind: LibraryKind) {
  const methods = libraryMethods(kind);
  const granted = supportsFeature(client, "library_read_v1");
  return { catalog: granted && supportsRequest(client, methods.catalog), read: granted && supportsRequest(client, methods.read) };
}

function libraryWrite(client: ZetaClient, kind: LibraryKind, controller: boolean, takeControl: () => Promise<string | null>, feedback: string | null, drafts: Map<string, CreateDraft>, edits: Map<LibraryKind, EditDraft>, writer: LibraryWriter, releaseControl: () => void) {
  const access = writeAccess(client, kind, controller);
  return access === "none" ? null : { controller, allowed: access === "allowed", takeControl, feedback, drafts, edits, writer, releaseControl };
}

type BuildShellProps = Omit<AppShellProps, "activity" | "children"> & { children: (activity: BuildActivity) => ReactNode };
export type RenderShell = (props: BuildShellProps) => ReactNode;

function BuildShell({ client, children, ...props }: BuildShellProps & { client: ZetaClient | null }) {
  const { recentChats, pageCatalog, reloadPages } = props.nav;
  const activity = useBuildActivity({ client, chats: recentChats, pages: pageCatalog.error ? null : pageCatalog.items, reloadPages });
  return <AppShell {...props} activity={activity}>{children(activity)}</AppShell>;
}

function CatalogShell({ renderShell, route, connectionStatus, banner, children, sessions }: { renderShell: RenderShell; route: SurfaceRoute; connectionStatus: { label: string; connected: boolean }; banner?: ReactNode; children: ReactNode; sessions?: Pick<React.ComponentProps<typeof SessionsModule>, "client" | "connecting" | "retry"> }) {
  const nav = useAgentNavAdapter({ sessionId: null, waiting: 0, canWrite: false, refreshKey: 0, pageRefreshKey: 0 });
  const newChat = () => location.assign(surfaceHref(chatsRoute.path) + newChatIntent);
  return renderShell({ current: route, nav, banner, connectionStatus,
    newChat: { available: connectionStatus.connected, run: newChat },
    children: () => route.id === "pages" ? <PagesLanding catalog={nav.pageCatalog} reload={nav.reloadPages} more={nav.morePages} />
      : sessions ? <SessionsModule {...sessions} newChat={newChat} chats={nav.recentChats} /> : children,
  });
}

function ObserverBanner({ connection, readOnly }: { connection: Connection; readOnly: boolean }) {
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  // aria-disabled, not disabled: a disabled button drops focus to <body> during the attempt.
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
    {!readOnly && <div className="observer-action"><button type="button" aria-describedby={feedback ? "take-control-feedback" : undefined} onClick={() => { if (!working) void takeControl(); }} aria-disabled={working}>{working ? "taking control…" : "take control"}</button></div>}
    {/* its own full-width row under the text and the button, so a long refusal does not squeeze the text */}
    {!readOnly && <span id="take-control-feedback" role="status">{feedback}</span>}
  </aside>;
}
