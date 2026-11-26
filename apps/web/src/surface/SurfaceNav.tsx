import type { ReactNode, Ref } from "react";
import type { BuildActivity } from "../create/buildActivity";
import { chatHref } from "./AgentNavAdapter";
import { isMac, modKey } from "../keyboard";
import { approvalIntent, createRoute, surfaceHref, surfaceRoutes, type SurfaceRoute } from "./routes";

const groups = [...new Set(surfaceRoutes.flatMap((route) => route.group ?? []))];

type PlaceCount = { waiting?: number };

/** One rail icon style: the collapsed sidebar shows only these, so every rail item draws the same 16px stroke. */
export const NavIcon = ({ d }: { d: string }) => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d={d} /></svg>;

// the tooltip names the place only in the collapsed rail, where the label is hidden
function PlaceLink({ route, current, count, collapsed }: { route: SurfaceRoute; current: SurfaceRoute; count?: PlaceCount; collapsed: boolean }) {
  const waiting = count?.waiting || undefined;
  return <a className="place-link" href={surfaceHref(route.path)} aria-current={current === route ? "page" : undefined} aria-label={route.label} aria-description={waiting ? `${waiting} waiting approvals` : undefined} title={collapsed ? route.label : undefined}>
    <NavIcon d={route.icon} />
    <span>{route.label}</span>
    {waiting && <small aria-hidden="true" className="waiting-count">{waiting}</small>}
  </a>;
}

export function BuildStatus({ activity, current, className = "" }: { activity: BuildActivity; current: SurfaceRoute; className?: string }) {
  const { rows, building, needsYou } = activity;
  if (!building && !needsYou) return null;
  const attention = rows.filter((row) => row.state === "needs you" && !row.reason);
  const create = surfaceHref(createRoute.path);
  return <span className={`build-status ${className}`} aria-label="page build progress">
    {building > 0 && (current === createRoute ? <span className="build-building" aria-current="page">{building} building</span> : <a className="build-building" href={create}>{building} building</a>)}
    {needsYou > 0 && <a className="build-needs-you" href={attention.length === 1 ? chatHref(attention[0]!.chat) + approvalIntent : create}>{needsYou} needs you</a>}
  </span>;
}

export function SurfaceNav({ current, sidebar, narrow, drawer, collapsed, onClose, onCollapse, openPalette, action, search, counts, recent, connectionStatus, activity }: {
  activity?: BuildActivity;
  current: SurfaceRoute;
  sidebar: Ref<HTMLElement>;
  narrow: boolean;
  drawer: boolean;
  collapsed: boolean;
  onClose: () => void;
  onCollapse: () => void;
  openPalette: () => void;
  action?: ReactNode;
  search: ReactNode;
  counts: Partial<Record<string, PlaceCount>>;
  recent: ReactNode;
  connectionStatus: { label: string; connected: boolean };
}) {
  return <aside ref={sidebar} id="surface-sidebar" className="sidebar" aria-label={narrow ? "navigation menu" : "sidebar"} role={narrow && drawer ? "dialog" : undefined} aria-modal={narrow && drawer || undefined} aria-hidden={narrow && !drawer ? true : undefined} inert={narrow && !drawer || undefined}>
    <div className="brand-row">
      <span className="brand-mark" aria-hidden="true" /><strong>achilles</strong>
      <span className="surface-connection" title={connectionStatus.label} aria-label={connectionStatus.label} data-connected={connectionStatus.connected} role="img" />
      {narrow && <button className="drawer-close" aria-label="close navigation" onClick={onClose}>×</button>}
    </div>
    <div className="sidebar-scroll">
      <div className="surface-actions">
        {action}
        <div className="create-split">
          <PlaceLink route={createRoute} current={current} collapsed={collapsed} />
          {activity && <BuildStatus activity={activity} current={current} className="build-status-nav" />}
        </div>
      </div>
      <div className="surface-search">
        {search}
        <button className="palette-button" aria-label="command palette" title="command palette" aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"} onClick={openPalette}><span aria-hidden="true"><NavIcon d="M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8z M10 10l3.5 3.5" /></span><kbd>{modKey("K")}</kbd></button>
      </div>
      <div className="sidebar-destinations">
        <nav className="place-nav" aria-label="places">
          {groups.map((group) => <section aria-label={group} key={group}>
            {surfaceRoutes.filter((route) => route.group === group).map((route) => <PlaceLink key={route.id} route={route} current={current} count={counts[route.id]} collapsed={collapsed} />)}
          </section>)}
        </nav>
        {recent}
      </div>
    </div>
    {!narrow && <footer>
      <button className="collapse-button" aria-label={collapsed ? "expand sidebar" : "collapse sidebar"} title={collapsed ? "expand sidebar" : undefined} aria-keyshortcuts={isMac ? "Meta+B" : "Control+B"} aria-expanded={!collapsed} onClick={onCollapse}><span aria-hidden="true">{collapsed ? "»" : "«"}</span><span className="collapse-label">collapse</span></button>
    </footer>}
  </aside>;
}
