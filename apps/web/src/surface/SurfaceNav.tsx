import type { ReactNode, Ref } from "react";
import { isMac, modKey } from "../keyboard";
import { createRoute, surfaceHref, surfaceRoutes, type SurfaceRoute } from "./routes";

const groups = [...new Set(surfaceRoutes.flatMap((route) => route.group ?? []))];

function PlaceLink({ route, current, detail }: { route: SurfaceRoute; current: SurfaceRoute; detail?: string }) {
  return <a className="place-link" href={surfaceHref(route.path)} aria-current={current === route ? "page" : undefined} aria-label={detail ? `${route.label} (${detail})` : route.label} title={route.label}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d={route.icon} /></svg>
    <span>{route.label}</span>{detail && <small>{detail}</small>}
  </a>;
}

export function SurfaceNav({ current, sidebar, narrow, drawer, collapsed, onClose, onCollapse, openPalette, createEnabled, action, search, catalog, recent, settings, connectionStatus }: {
  current: SurfaceRoute;
  sidebar: Ref<HTMLElement>;
  narrow: boolean;
  drawer: boolean;
  collapsed: boolean;
  onClose: () => void;
  onCollapse: () => void;
  openPalette: () => void;
  createEnabled?: boolean;
  action?: ReactNode;
  search: ReactNode;
  catalog: ReactNode;
  recent: ReactNode;
  settings?: ReactNode;
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
        <PlaceLink route={createRoute} current={current} detail={createEnabled ? "on · this page" : undefined} />
      </div>
      <div className="surface-search">
        {search}
        <button className="palette-button" aria-label="command palette" aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"} onClick={openPalette}><span aria-hidden="true">⌕</span><kbd>{modKey("K")}</kbd></button>
      </div>
      <nav className="place-nav" aria-label="places">
        {groups.map((group) => <section aria-label={group} key={group}>
          <h2>{group}</h2>
          {surfaceRoutes.filter((route) => route.group === group).map((route) => <PlaceLink key={route.id} route={route} current={current} />)}
        </section>)}
      </nav>
      {catalog}
      {recent}
    </div>
    <footer>
      {!narrow && <button className="collapse-button" aria-label={collapsed ? "expand sidebar" : "collapse sidebar"} aria-keyshortcuts={isMac ? "Meta+B" : "Control+B"} aria-expanded={!collapsed} onClick={onCollapse}><span aria-hidden="true">{collapsed ? "»" : "«"}</span><span className="collapse-label">collapse</span><kbd>{modKey("B")}</kbd></button>}
      {settings}
    </footer>
  </aside>;
}
