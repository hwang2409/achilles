import type { ReactNode, Ref } from "react";
import type { BuildActivity } from "../create/buildActivity";
import { chatHref } from "./AgentNavAdapter";
import type { CreateModeOwner } from "../create/createMode";
import { isMac, modKey } from "../keyboard";
import { createRoute, surfaceHref, surfaceRoutes, type SurfaceRoute } from "./routes";

const groups = [...new Set(surfaceRoutes.flatMap((route) => route.group ?? []))];

type PlaceCount = { total?: string; waiting?: number };

function PlaceLink({ route, current, count }: { route: SurfaceRoute; current: SurfaceRoute; count?: PlaceCount }) {
  const total = count?.total;
  const waiting = count?.waiting || undefined;
  return <a className="place-link" href={surfaceHref(route.path)} aria-current={current === route ? "page" : undefined} aria-label={route.label} aria-description={waiting ? `${waiting} waiting approvals` : undefined} title={route.label}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d={route.icon} /></svg>
    <span>{route.label}</span>
    {(total || waiting) && <small aria-hidden="true">{waiting && <span className="waiting-count">{waiting}</span>}{waiting && total && " · "}{total}</small>}
  </a>;
}

export function BuildStatus({ activity, className = "" }: { activity: BuildActivity; className?: string }) {
  const { rows, building, needsYou } = activity;
  const attention = rows.filter((row) => row.state === "needs you");
  const running = rows.filter((row) => row.state === "building");
  const stale = [...attention, ...running].some((row) => row.stale);
  return (building > 0 || needsYou > 0) ? <div className={`build-status ${className}`} aria-label="page build progress">
    {building > 0 && <a href={running.length === 1 && running[0]!.stale ? chatHref(running[0]!.chat) : surfaceHref(createRoute.path)}>{building} building</a>}
    {needsYou > 0 && <a className="build-needs-you" href={attention.length === 1 ? chatHref(attention[0]!.chat) : surfaceHref(createRoute.path)}>{needsYou} needs you</a>}
    {stale && <small>stale</small>}
  </div> : null;
}

export function SurfaceNav({ current, sidebar, narrow, drawer, collapsed, onClose, onCollapse, openPalette, createMode, action, search, counts, recent, connectionStatus, activity }: {
  activity?: BuildActivity;
  current: SurfaceRoute;
  sidebar: Ref<HTMLElement>;
  narrow: boolean;
  drawer: boolean;
  collapsed: boolean;
  onClose: () => void;
  onCollapse: () => void;
  openPalette: () => void;
  createMode?: CreateModeOwner;
  action?: ReactNode;
  search: ReactNode;
  counts: Partial<Record<string, PlaceCount>>;
  recent: ReactNode;
  connectionStatus: { label: string; connected: boolean };
}) {
  return <aside ref={sidebar} id="surface-sidebar" className="sidebar" aria-label={narrow ? "navigation menu" : "sidebar"} role={narrow && drawer ? "dialog" : undefined} aria-modal={narrow && drawer || undefined} aria-hidden={narrow && !drawer ? true : undefined} inert={narrow && !drawer || undefined}>
    <div className="brand-row">
      <span className="brand-mark" aria-hidden="true" /><strong>achilles</strong>
      <span className="surface-connection" title={connectionStatus.label} aria-label={connectionStatus.label} data-connected={connectionStatus.connected}><i aria-hidden="true" />zeta</span>
      {narrow && <button className="drawer-close" aria-label="close navigation" onClick={onClose}>×</button>}
    </div>
    <div className="sidebar-scroll">
      <div className="surface-actions">
        {action}
        <div className="create-split" data-mode={createMode?.enabled ? "on" : undefined}>
          <PlaceLink route={createRoute} current={current} />
          {createMode && <button type="button" aria-label="toggle create mode for this page" aria-pressed={createMode.enabled}
            aria-busy={createMode.pending || undefined} disabled={!createMode.available || createMode.pending}
            title={createMode.error ?? "create mode for this page"} onClick={() => void createMode.toggle()}>
            {createMode.pending ? "saving…" : createMode.enabled ? "on" : "off"}<span aria-hidden="true"> {createMode.error ? "!" : "· this page"}</span>
          </button>}
        </div>
        {activity && <BuildStatus activity={activity} className="build-status-nav" />}
      </div>
      <div className="surface-search">
        {search}
        <button className="palette-button" aria-label="command palette" aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"} onClick={openPalette}><span aria-hidden="true">⌕</span><kbd>{modKey("K")}</kbd></button>
      </div>
      <nav className="place-nav" aria-label="places">
        {groups.map((group) => <section aria-label={group} key={group}>
          <h2>{group}</h2>
          {surfaceRoutes.filter((route) => route.group === group).map((route) => <PlaceLink key={route.id} route={route} current={current} count={counts[route.id]} />)}
        </section>)}
      </nav>
      {recent}
    </div>
    {!narrow && <footer>
      <button className="collapse-button" aria-label={collapsed ? "expand sidebar" : "collapse sidebar"} aria-keyshortcuts={isMac ? "Meta+B" : "Control+B"} aria-expanded={!collapsed} onClick={onCollapse}><span aria-hidden="true">{collapsed ? "»" : "«"}</span><span className="collapse-label">collapse</span><kbd>{modKey("B")}</kbd></button>
    </footer>}
  </aside>;
}
