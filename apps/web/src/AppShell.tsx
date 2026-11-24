import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { Menu, Plus } from "lucide-react";
import { CommandPalette, ShortcutsSheet, type PaletteEntry } from "./CommandPalette";
import { SettingsDialog } from "./SettingsDialog";
import { updateSettings, useSettings } from "./settings";
import { firstFocusable, hasAppModifier, isEditableTarget, modKey, restorableFocus, useFocusAfterCommit } from "./keyboard";
import { PageChatCatalog, titleOf, type useAgentNavAdapter } from "./surface/AgentNavAdapter";
import { WRITE_SURFACE } from "./writeSurfaces";

import { ShellDock } from "./surface/ModuleState";
import type { BuildActivity } from "./create/buildActivity";
import { BuildStatus, SurfaceNav } from "./surface/SurfaceNav";
import type { CreateModeOwner } from "./create/createMode";
import { surfaceHref, type SurfaceRoute } from "./surface/routes";

/** Opens the browser display settings dialog; the settings place provides it. */
export const DisplaySettings = createContext<() => void>(() => {});

type WorkspaceActions = {
  canWrite: boolean;
  serverForcesAsk?: boolean;
  createMode?: CreateModeOwner;
};

export type AppShellProps = {
  activity: BuildActivity;
  current: SurfaceRoute;
  nav: ReturnType<typeof useAgentNavAdapter>;
  workspace?: WorkspaceActions;
  newChat: { available: boolean; pending?: boolean; run: () => void };
  connectionStatus: { label: string; connected: boolean };
  hasComposer?: boolean;
  banner?: ReactNode;
  header?: ReactNode;
  children: ReactNode;
};

export function AppShell({ activity, current, nav, workspace, newChat, connectionStatus, hasComposer, banner, header, children }: AppShellProps) {
  const { canWrite = false, serverForcesAsk = false, createMode } = workspace ?? {};
  const settingsPlace = current.id === "settings";
  const displaySettings = Boolean(workspace) || settingsPlace;
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const liveRegion = useRef<HTMLSpanElement>(null);
  const [spoken, setSpoken] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const settings = useSettings();
  const narrow = useIsMobile();
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const settingsOpener = useRef<Element>(null);
  const paletteOpener = useRef<Element | null>(null);
  const shortcutsOpener = useRef<Element | null>(null);
  const requestFocus = useFocusAfterCommit();
  const { loading, query, clearSearch, catalog, pageEntries } = nav;
  const startNewChat = useCallback(() => {
    if (!newChat.available) return;
    setDrawer(false);
    newChat.run();
  }, [newChat]);
  const collapse = () => setCollapsed((value) => !value);
  const dismissDrawer = () => setDrawer(false);
  const closeDrawer = () => setDrawer(false);
  const openSettings = (opener: Element | null) => {
    setSettingsOpen((open) => {
      if (!open) settingsOpener.current = opener;
      return true;
    });
  };
  const focusBack = (opener: { current: Element | null }) => requestFocus(() => {
    const target = restorableFocus(
      opener.current,
      drawer ? firstFocusable(sidebar.current) : null,
      document.querySelector(".main-pane textarea[aria-label='message']"),
      menuButton.current,
    );
    opener.current = null;
    return target;
  });
  const closeSettings = () => {
    if (!settingsOpen) return;
    setSettingsOpen(false);
  };
  const activeElement = () => document.activeElement instanceof Element ? document.activeElement : null;
  const openPalette = () => { if (!paletteOpen) paletteOpener.current = activeElement(); setPaletteOpen(true); };
  const closePalette = () => setPaletteOpen(false);
  const openShortcuts = (opener: Element | null) => { if (!shortcutsOpen) shortcutsOpener.current = opener; setShortcutsOpen(true); };
  const closeShortcuts = () => setShortcutsOpen(false);

  useEffect(() => { if (!narrow) setDrawer(false); }, [narrow]);
  useEffect(() => {
    if (!query || drawer || settingsOpen || shortcutsOpen || paletteOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || (event.target instanceof Element && event.target.closest("[data-inline-rename], [role='dialog'], [role='alertdialog'], [role='menu'], .page-chat-head[data-popup]"))) return;
      event.preventDefault();
      clearSearch();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [drawer, query, settingsOpen, shortcutsOpen, paletteOpen, clearSearch]);
  useEffect(() => {
    // capture on window runs before the composer (CodeMirror vim too) sees app shortcuts.
    const key = (event: KeyboardEvent) => {
      if (!hasAppModifier(event) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && key === "k") {
        event.preventDefault();
        event.stopPropagation();
        if (paletteOpen) closePalette(); else openPalette();
      } else if (key === "b") {
        event.preventDefault();
        event.stopPropagation();
        if (!narrow) collapse();
      } else if (displaySettings && event.key === ",") {
        event.preventDefault();
        event.stopPropagation();
        const opener = paletteOpen ? paletteOpener.current : (document.activeElement instanceof Element ? document.activeElement : null);
        if (paletteOpen) closePalette();
        openSettings(opener);
      } else if (event.shiftKey && key === "o") {
        event.preventDefault();
        event.stopPropagation();
        startNewChat();
      } else if (createMode && event.key === ".") {
        event.preventDefault();
        event.stopPropagation();
        if (!loading) void createMode.toggle();
      }
    };
    addEventListener("keydown", key, true); return () => removeEventListener("keydown", key, true);
  }, [workspace, displaySettings, canWrite, loading, narrow, startNewChat, createMode, paletteOpen, drawer]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.composedPath().some(node => node instanceof Element && node.matches("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]"))) return;
      if (event.key === "/") {
        event.preventDefault();
        const search = restorableFocus(sidebar.current?.querySelector(".chat-search input") ?? null);
        if (search) search.focus(); else openPalette();
      }
      if (workspace && event.key === "?") { event.preventDefault(); openShortcuts(activeElement()); }
    };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, [workspace, shortcutsOpen, paletteOpen]);

  const commands: PaletteEntry[] = [
    ...!newChat.available || newChat.pending ? [] : [{ id: "new-chat", label: "new chat", shortcut: modKey("⇧O"), run: startNewChat }],
    ...loading || !createMode?.available || createMode.pending ? [] : [{ id: "create-mode", label: "toggle create mode", shortcut: modKey("."), detail: createMode.enabled ? "on · this page" : "off · this page", run: () => void createMode.toggle() }],
    ...displaySettings ? [{ id: "display-settings", label: "display settings", shortcut: modKey(","), opensOverlay: true, run: () => openSettings(paletteOpener.current) }] : [],
    ...workspace ? [
      { id: "vim", label: "toggle vim mode", detail: settings.vim ? "on" : "off", run: () => updateSettings({ vim: !settings.vim }) },
      { id: "shortcuts", label: "keyboard shortcuts", shortcut: "?", opensOverlay: true, run: () => openShortcuts(paletteOpener.current) },
    ] : [],
  ];
  const receipt = activity.latestReceipt;
  const receiptHref = receipt ? surfaceHref(receipt.route) : "";
  // Go to this receipt's page before the acknowledgement re-renders the link with the next receipt.
  const openReceipt = () => { location.assign(receiptHref); activity.dismissReceipt(); };
  const showNavActivity = narrow ? drawer : !collapsed;
  const pending = activity.announcement;
  useEffect(() => {
    if (!pending) return;
    // The text is set, and the completion marked announced, only while a screen reader can reach the region.
    const speak = () => {
      if (settingsOpen || shortcutsOpen || paletteOpen || (narrow && drawer) || !liveRegion.current || liveRegion.current.closest("[inert], [aria-hidden='true']") || document.querySelector("dialog[open]:modal")) return;
      setSpoken(pending);
      activity.markAnnounced();
    };
    speak();
    document.addEventListener("close", speak, true);
    return () => document.removeEventListener("close", speak, true);
  }, [pending, narrow, drawer, settingsOpen, shortcutsOpen, paletteOpen]);
  // One in-flow slot under the route's bar: the chat header here, or the module/create/telemetry bar via ShellDock.
  const status = !showNavActivity && <BuildStatus activity={activity} current={current} className="px-3" />;
  const dock = (status || receipt) ? <div className="shrink-0 border-b bg-card">
    {status}
    {receipt && <aside className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-sm" aria-label="build receipt">
      <span><strong title={titleOf(receipt.chat)}>{titleOf(receipt.chat)}</strong> finished{" ·\u00a0"}{receipt.route} is ready</span>
      <Button asChild variant="outline" className="min-h-[44px]"><a href={receiptHref} onClick={(event) => {
        // a new-tab or new-window click is the browser's: no acknowledgement
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openReceipt();
      }} onKeyDown={(event) => { if (event.key === " ") { event.preventDefault(); openReceipt(); } }}>open page</a></Button>
      <Button variant="ghost" className="min-h-[44px]" type="button" onClick={() => { activity.dismissReceipt(); document.querySelector<HTMLElement>(".main-pane")?.focus(); }}>dismiss</Button>
    </aside>}
  </div> : null;
  return <SidebarProvider data-shell data-sidebar-collapsed={collapsed} className="h-dvh min-h-0 overflow-hidden bg-background" open={!collapsed} onOpenChange={(open) => setCollapsed(!open)} mobile={narrow} openMobile={drawer} onOpenMobileChange={setDrawer}>
    <a className="fixed top-2 left-2 z-60 -translate-y-[150%] bg-primary px-3 py-2 text-primary-foreground focus:translate-y-0" href="#message-composer" inert={narrow && drawer ? true : undefined} onClick={(event) => { event.preventDefault(); const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="message"]'); if (composer) composer.focus(); else document.querySelector<HTMLElement>(".main-pane")?.focus(); }}>{hasComposer ? "skip to message" : "skip to main content"}</a>
    <SurfaceNav current={current} sidebar={sidebar} narrow={narrow} collapsed={collapsed} restoreDrawerFocus={() => requestFocus(() => restorableFocus(menuButton.current))} onClose={closeDrawer} onCollapse={collapse} openPalette={openPalette} connectionStatus={connectionStatus} createMode={createMode} activity={showNavActivity ? activity : undefined}
      action={<Button variant="ghost" className="new-chat w-full justify-start group-data-[collapsible=icon]:justify-center" aria-label="new chat" data-write-surface={WRITE_SURFACE.shellNewChat} disabled={!newChat.available} aria-disabled={newChat.pending || undefined} aria-busy={newChat.pending || undefined} title={newChat.pending ? "starting chat…" : !newChat.available ? "this tab is read-only; take control to create a chat" : "new chat"} onClick={startNewChat}><Plus aria-hidden="true" /><b className="font-medium group-data-[collapsible=icon]:hidden">{newChat.pending ? "Starting…" : "New chat"}</b><kbd className="ml-auto group-data-[collapsible=icon]:hidden">{modKey("⇧O")}</kbd></Button>}
      search={nav.searchControl(dismissDrawer)} counts={{ ...nav.counts, chats: nav.counts.chats && { ...nav.counts.chats, waiting: (nav.counts.chats.waiting ?? 0) + activity.needsYou } }} recent={nav.recent(dismissDrawer, activity.rows, activity.onScreen)} />
    <main data-main-pane className="main-pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" tabIndex={-1} aria-hidden={narrow && drawer ? "true" : undefined} inert={narrow && drawer ? true : undefined}>
      {banner}
      <div className={narrow ? "relative shrink-0" : "contents"}>
        {narrow && <Button ref={menuButton} variant="ghost" size="icon-lg" className="menu-button absolute top-0.5 left-2 z-2 min-h-[44px] min-w-[44px]" aria-label="open menu" aria-controls="surface-sidebar" aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu aria-hidden="true" /></Button>}
        {header}
      </div>
      {workspace && dock}
      <ShellDock.Provider value={workspace ? null : dock}><PageChatCatalog.Provider value={{ ...catalog, builds: activity.rows, onScreen: activity.onScreen }}>{settingsPlace ? <DisplaySettings.Provider value={() => openSettings(activeElement())}>{children}</DisplaySettings.Provider> : children}</PageChatCatalog.Provider></ShellDock.Provider>
    </main>
    {/* outside main and the drawer, so it is never inert or aria-hidden */}
    <span ref={liveRegion} className="sr-only" role="status">{spoken}</span>
    {displaySettings && <SettingsDialog open={settingsOpen} onClose={closeSettings} restoreFocus={() => focusBack(settingsOpener)} serverForcesAsk={serverForcesAsk} canWrite={canWrite} />}
    {workspace && shortcutsOpen && <ShortcutsSheet onClose={closeShortcuts} restoreFocus={() => focusBack(shortcutsOpener)} />}
    {paletteOpen && <CommandPalette commands={commands} pages={pageEntries} searchChats={nav.searchChats(dismissDrawer)} onClose={closePalette} restoreFocus={() => focusBack(paletteOpener)} />}
  </SidebarProvider>;
}
