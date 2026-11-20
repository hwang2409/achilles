import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CommandPalette, ShortcutsSheet, type PaletteEntry } from "./CommandPalette";
import { SettingsDialog } from "./SettingsDialog";
import { updateSettings, useSettings } from "./settings";
import { firstFocusable, hasAppModifier, isEditableTarget, modKey, restorableFocus, useFocusAfterCommit, useModalFocus } from "./keyboard";
import { PageChatCatalog, type useAgentNavAdapter } from "./surface/AgentNavAdapter";
import { WRITE_SURFACE } from "./writeSurfaces";

import { ModuleFrame, ModuleState } from "./surface/ModuleState";
import { SurfaceNav } from "./surface/SurfaceNav";
import type { CreateModeOwner } from "./create/createMode";
import type { SurfaceRoute } from "./surface/routes";

type WorkspaceActions = {
  canWrite: boolean;
  serverForcesAsk?: boolean;
  createMode?: CreateModeOwner;
};

type Props = {
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

// Short screens use a drawer too. Keep this breakpoint in sync with shell.css.
const DRAWER_MEDIA = "(max-width: 760px), (max-height: 500px)";

export function AppShell({ current, nav, workspace, newChat, connectionStatus, hasComposer, banner, header, children }: Props) {
  const { canWrite = false, serverForcesAsk = false, createMode } = workspace ?? {};
  const settingsPlace = current.id === "settings";
  const displaySettings = Boolean(workspace) || settingsPlace;
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const settings = useSettings();
  const [narrow, setNarrow] = useState(() => matchMedia(DRAWER_MEDIA).matches);
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
  const closeDrawer = () => { requestFocus(() => restorableFocus(menuButton.current)); setDrawer(false); };
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
    focusBack(settingsOpener);
    setSettingsOpen(false);
  };
  const activeElement = () => document.activeElement instanceof Element ? document.activeElement : null;
  const openPalette = () => { if (!paletteOpen) paletteOpener.current = activeElement(); setPaletteOpen(true); };
  const closePalette = () => { focusBack(paletteOpener); setPaletteOpen(false); };
  const openShortcuts = (opener: Element | null) => { if (!shortcutsOpen) shortcutsOpener.current = opener; setShortcutsOpen(true); };
  const closeShortcuts = () => { focusBack(shortcutsOpener); setShortcutsOpen(false); };

  useEffect(() => { const media = matchMedia(DRAWER_MEDIA); const changed = () => setNarrow(media.matches); media.addEventListener("change", changed); return () => media.removeEventListener("change", changed); }, []);
  useEffect(() => { if (!narrow) setDrawer(false); }, [narrow]);
  useEffect(() => {
    const layers: Array<() => void> = [];
    if (query) layers.push(clearSearch);
    if (drawer) layers.push(closeDrawer);
    if (settingsOpen) layers.push(closeSettings);
    if (shortcutsOpen) layers.push(closeShortcuts);
    if (paletteOpen) layers.push(closePalette);
    const top = layers.at(-1);
    if (!top) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || (event.target instanceof Element && event.target.closest("[data-inline-rename], .page-chat-head[data-popup]"))) return;
      event.preventDefault();
      event.stopPropagation();
      top();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [drawer, query, settingsOpen, shortcutsOpen, paletteOpen]);
  useModalFocus(narrow && drawer, sidebar);
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
      if (isEditableTarget(event)) return;
      if (event.key === "/") {
        event.preventDefault();
        const search = restorableFocus(sidebar.current?.querySelector(".chat-search input") ?? null);
        if (search) search.focus(); else openPalette();
      }
      if (workspace && event.key === "?" && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); openShortcuts(activeElement()); }
    };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, [workspace, shortcutsOpen, paletteOpen]);

  const commands: PaletteEntry[] = [
    ...!newChat.available || newChat.pending ? [] : [{ id: "new-chat", label: "new chat", shortcut: modKey("⇧O"), run: startNewChat }],
    ...loading || !createMode?.available || createMode.pending ? [] : [{ id: "create-mode", label: "toggle create mode", shortcut: modKey("."), detail: createMode.enabled ? "on · this page" : "off · this page", run: () => void createMode.toggle() }],
    ...displaySettings ? [{ id: "display-settings", label: "display settings", shortcut: modKey(","), run: () => openSettings(paletteOpener.current) }] : [],
    ...workspace ? [
      { id: "vim", label: "toggle vim mode", detail: settings.vim ? "on" : "off", run: () => updateSettings({ vim: !settings.vim }) },
      { id: "shortcuts", label: "keyboard shortcuts", shortcut: "?", run: () => openShortcuts(paletteOpener.current) },
    ] : [],
  ];
  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""} ${drawer ? "drawer-open" : ""} ${loading ? "shell-loading" : ""}`}>
    <a className="skip-link" href="#message-composer" inert={narrow && drawer ? true : undefined} onClick={(event) => { event.preventDefault(); const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="message"]'); if (composer) composer.focus(); else document.querySelector<HTMLElement>(".main-pane")?.focus(); }}>{hasComposer ? "skip to message" : "skip to main content"}</a>
    <button className="drawer-scrim" aria-label="close menu" hidden={!drawer} tabIndex={-1} onClick={closeDrawer} />
    <SurfaceNav current={current} sidebar={sidebar} narrow={narrow} drawer={drawer} collapsed={collapsed} onClose={closeDrawer} onCollapse={collapse} openPalette={openPalette} connectionStatus={connectionStatus} createMode={createMode}
      action={<button className="new-chat" aria-label="new chat" data-write-surface={WRITE_SURFACE.shellNewChat} disabled={!newChat.available} aria-disabled={newChat.pending || undefined} aria-busy={newChat.pending || undefined} title={newChat.pending ? "starting chat…" : !newChat.available ? "this tab is read-only; take control to create a chat" : "new chat"} onClick={startNewChat}><span aria-hidden="true">+</span><b>{newChat.pending ? "starting…" : "new chat"}</b><kbd>{modKey("⇧O")}</kbd></button>}
      search={nav.searchControl(dismissDrawer)} counts={nav.counts} recent={nav.recent(dismissDrawer)} />
    <main className="main-pane" tabIndex={-1} aria-hidden={narrow && drawer ? "true" : undefined} inert={narrow && drawer ? true : undefined}>
      {banner}
      <div className="shell-header">
        <button ref={menuButton} className="menu-button" aria-label="open menu" aria-controls="surface-sidebar" aria-expanded={drawer} onClick={() => setDrawer(true)}>☰</button>
        {header}
      </div>
      <PageChatCatalog.Provider value={catalog}>{settingsPlace ? <ModuleFrame title={current.label}>
        <ModuleState kind="unsupported" title="display settings are here for now. more settings come later." action={{ label: "display settings", run: () => openSettings(activeElement()) }} />
      </ModuleFrame> : children}</PageChatCatalog.Provider>
    </main>
    {displaySettings && <SettingsDialog open={settingsOpen} onClose={closeSettings} serverForcesAsk={serverForcesAsk} canWrite={canWrite} />}
    {workspace && shortcutsOpen && <ShortcutsSheet onClose={closeShortcuts} />}
    {paletteOpen && <CommandPalette commands={commands} pages={pageEntries} searchChats={nav.searchChats(dismissDrawer)} onClose={closePalette} />}
  </div>;
}
