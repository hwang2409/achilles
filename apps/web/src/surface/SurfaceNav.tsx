import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import { PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { BuildActivity } from "../create/buildActivity";
import { chatHref } from "./AgentNavAdapter";
import type { CreateModeOwner } from "../create/createMode";
import { isMac, modKey } from "../keyboard";
import { approvalIntent, createRoute, surfaceHref, surfaceRoutes, type SurfaceRoute } from "./routes";

const groups = [...new Set(surfaceRoutes.flatMap((route) => route.group ?? []))];

type PlaceCount = { total?: string; waiting?: number };

function PlaceLink({ route, current, count }: { route: SurfaceRoute; current: SurfaceRoute; count?: PlaceCount }) {
  const total = count?.total;
  const waiting = count?.waiting || undefined;
  return <a className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-sm hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent group-data-[collapsible=icon]:justify-center group-data-[mobile=true]:min-h-11" href={surfaceHref(route.path)} aria-current={current === route ? "page" : undefined} aria-label={route.label} aria-description={waiting ? `${waiting} waiting approvals` : undefined} title={route.label}>
    {route !== createRoute && <svg className="hidden shrink-0 group-data-[collapsible=icon]:block" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d={route.icon} /></svg>}
    <span className={route === createRoute ? "first-letter:uppercase" : "first-letter:uppercase group-data-[collapsible=icon]:hidden"}>{route.label}</span>
    {(total || waiting) && <small className="ml-auto text-muted-foreground group-data-[collapsible=icon]:hidden" aria-hidden="true">{waiting && <span data-waiting-count className="text-warning">{waiting}</span>}{waiting && total && " · "}{total}</small>}
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

export function SurfaceNav({ current, sidebar, narrow, restoreDrawerFocus, collapsed, onClose, onCollapse, openPalette, createMode, action, search, counts, recent, connectionStatus, activity }: {
  activity?: BuildActivity;
  current: SurfaceRoute;
  sidebar: Ref<HTMLElement>;
  narrow: boolean;
  restoreDrawerFocus: () => void;
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
  return <Sidebar collapsible="icon" onCloseAutoFocus={(event) => { event.preventDefault(); restoreDrawerFocus(); }}>
    <aside ref={sidebar} id="surface-sidebar" data-shell-nav className="sidebar group flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-mobile={narrow} aria-label={narrow ? "navigation menu" : "sidebar"}>
      <SidebarHeader className="h-11 shrink-0 flex-row items-center gap-2 border-b px-4 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
        <span className="grid size-5 shrink-0 place-items-center bg-primary after:size-2 after:bg-primary-foreground" aria-hidden="true" /><strong className="group-data-[collapsible=icon]:hidden">achilles</strong>
        <span className="ml-auto text-xs text-muted-foreground group-data-[collapsible=icon]:hidden" title={connectionStatus.label} aria-label={connectionStatus.label} data-connected={connectionStatus.connected}>Zeta</span>
        {narrow && <Button variant="ghost" size="icon-lg" className="min-h-11 min-w-11" aria-label="close navigation" onClick={onClose}><X /></Button>}
      </SidebarHeader>
      <SidebarContent className="gap-1 pt-2" >
        <div className="mx-2 grid shrink-0 gap-1">
        {action}
        <div className="create-split flex flex-wrap items-center gap-1 group-data-[collapsible=icon]:justify-center" data-mode={createMode?.enabled ? "on" : undefined}>
          <PlaceLink route={createRoute} current={current} />
          {activity && <BuildStatus activity={activity} current={current} className="build-status-nav" />}
          {createMode && <Button size="xs" variant="outline" type="button" aria-label="toggle create mode for this page" aria-pressed={createMode.enabled}
            aria-busy={createMode.pending || undefined} disabled={!createMode.available || createMode.pending}
            title={createMode.error ?? "create mode for this page"} onClick={() => void createMode.toggle()}>
            {createMode.pending ? "saving…" : createMode.enabled ? "on" : "off"}<span aria-hidden="true"> {createMode.error ? "!" : "· this page"}</span>
          </Button>}
        </div>
      </div>
      <div className="mx-2 flex shrink-0 items-center gap-1 group-data-[collapsible=icon]:justify-center">
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">{search}</div>
        <Button variant="ghost" size="sm" aria-label="command palette" aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"} onClick={openPalette}><Search aria-hidden="true" /><kbd className="group-data-[collapsible=icon]:hidden">{modKey("K")}</kbd></Button>
      </div>
      <nav className="mx-2 shrink-0" aria-label="places">
        {groups.map((group) => <section aria-label={group} key={group} className="mb-2">
          <h2 className="px-2 py-1 text-xs font-semibold text-muted-foreground first-letter:uppercase group-data-[collapsible=icon]:sr-only">{group}</h2>
          {surfaceRoutes.filter((route) => route.group === group).map((route) => <PlaceLink key={route.id} route={route} current={current} count={counts[route.id]} />)}
        </section>)}
      </nav>
      {!collapsed || narrow ? recent : null}
    </SidebarContent>
    {!narrow && <SidebarFooter className="border-t p-1">
      <Button variant="ghost" className="justify-start group-data-[collapsible=icon]:justify-center" aria-label={collapsed ? "expand sidebar" : "collapse sidebar"} aria-keyshortcuts={isMac ? "Meta+B" : "Control+B"} aria-expanded={!collapsed} onClick={onCollapse}>
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}<span className="group-data-[collapsible=icon]:hidden">Collapse</span><kbd className="ml-auto group-data-[collapsible=icon]:hidden">{modKey("B")}</kbd>
      </Button>
    </SidebarFooter>}
    </aside>
  </Sidebar>;
}
