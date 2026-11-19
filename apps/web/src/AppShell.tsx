import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CommandPalette, ShortcutsSheet, type PaletteEntry } from "./CommandPalette";
import { SettingsControl, SettingsDialog } from "./SettingsDialog";
import { updateSettings, useSettings } from "./settings";
import { firstFocusable, hasAppModifier, isEditableTarget, isMac, modKey, restorableFocus, useModalFocus } from "./keyboard";
import { PageChatCatalog, pageHref, useAgentNavAdapter, type Chat, type PageLink } from "./surface/AgentNavAdapter";
import { WRITE_SURFACE } from "./writeSurfaces";

export { PageChatCatalog, timeLabel, titleOf, type Chat } from "./surface/AgentNavAdapter";

type Props = {
  page: PageLink | null;
  sessionId: string | null;
  waiting: number;
  serverForcesAsk?: boolean;
  canWrite?: boolean;
  hasComposer: boolean;
  banner?: ReactNode;
  header?: ReactNode;
  children: ReactNode;
  refreshKey: number;
  pageRefreshKey: number;
} & (
  | {
      agentActions?: true;
      onNewChat: () => Promise<void>;
      onToggleCreateMode: () => Promise<unknown>;
      onSelectChat: (chat: Chat) => void;
      onRenameChat: (chat: Chat, title: string) => void;
    }
  | {
      agentActions: false;
      onNewChat?: never;
      onToggleCreateMode?: never;
      onSelectChat?: never;
      onRenameChat?: never;
    }
);

export const isTelemetryPath = (pathname: string) => pathname === "/telemetry" || pathname.startsWith("/telemetry/");

function useFocusAfterCommit() {
  const pending = useRef<(() => HTMLElement | null) | null>(null);
  useLayoutEffect(() => {
    const target = pending.current;
    pending.current = null;
    target?.()?.focus();
  });
  const [, commit] = useState(0);
  return (target: () => HTMLElement | null) => {
    pending.current = target;
    commit((value) => value + 1);
  };
}

// short heights use the drawer too: a phone on its side cannot spare 288px for the sidebar. matches style.css.
const DRAWER_MEDIA = "(max-width: 760px), (max-height: 500px)";

export function AppShell({ page, sessionId, waiting, serverForcesAsk = false, canWrite = false, hasComposer, banner, header, children, agentActions, onNewChat, onToggleCreateMode, onSelectChat, onRenameChat, refreshKey, pageRefreshKey }: Props) {
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
  const { loading, query, clearSearch, searchControl, lists, catalog, pageEntries, searchChats } = useAgentNavAdapter({ sessionId, waiting, canWrite, onSelectChat, onRenameChat, refreshKey, pageRefreshKey, onSelect: () => setDrawer(false), requestFocus });
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
      document.querySelector(".settings-button"),
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
        if (!narrow) setCollapsed((value) => !value);
      } else if (agentActions !== false && event.key === ",") {
        event.preventDefault();
        event.stopPropagation();
        const opener = paletteOpen ? paletteOpener.current : (document.activeElement instanceof Element ? document.activeElement : null);
        if (paletteOpen) closePalette();
        openSettings(opener);
      } else if (agentActions !== false && event.shiftKey && key === "o") {
        event.preventDefault();
        event.stopPropagation();
        if (!loading && canWrite) void onNewChat();
      } else if (agentActions !== false && event.key === ".") {
        event.preventDefault();
        event.stopPropagation();
        if (!loading && canWrite) void onToggleCreateMode();
      }
    };
    addEventListener("keydown", key, true); return () => removeEventListener("keydown", key, true);
  }, [agentActions, canWrite, loading, narrow, onNewChat, onToggleCreateMode, paletteOpen, drawer]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (isEditableTarget(event)) return;
      if (event.key === "/") { event.preventDefault(); document.querySelector<HTMLInputElement>(".chat-search input")?.focus(); }
      if (agentActions !== false && event.key === "?" && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); openShortcuts(activeElement()); }
    };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, [agentActions, shortcutsOpen]);

  const commands: PaletteEntry[] = agentActions === false ? [] : [
    ...loading || !canWrite ? [] : [{ id: "new-chat", label: "new chat", shortcut: modKey("⇧O"), run: () => { setDrawer(false); void onNewChat(); } }],
    ...loading || !page || !canWrite ? [] : [{ id: "create-mode", label: "toggle create mode", shortcut: modKey("."), run: () => void onToggleCreateMode() }],
    { id: "settings", label: "settings", shortcut: modKey(","), run: () => openSettings(paletteOpener.current) },
    { id: "vim", label: "toggle vim mode", detail: settings.vim ? "on" : "off", run: () => updateSettings({ vim: !settings.vim }) },
    { id: "shortcuts", label: "keyboard shortcuts", shortcut: "?", run: () => openShortcuts(paletteOpener.current) },
  ];
  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""} ${drawer ? "drawer-open" : ""} ${loading ? "shell-loading" : ""}`}>
    <a className="skip-link" href="#message-composer" inert={narrow && drawer ? true : undefined} onClick={(event) => { event.preventDefault(); const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="message"]'); if (composer) composer.focus(); else document.querySelector<HTMLElement>(".main-pane")?.focus(); }}>{hasComposer ? "skip to message" : "skip to main content"}</a>
    <button className="drawer-scrim" aria-label="close menu" hidden={!drawer} tabIndex={-1} onClick={closeDrawer} />
    <aside ref={sidebar} className="sidebar" aria-label="sidebar" aria-hidden={narrow && !drawer ? "true" : undefined} inert={narrow && !drawer ? true : undefined}>
      <div className="brand-row"><span className="brand-mark" /><strong>achilles</strong></div>
      {agentActions !== false && <button className="new-chat" data-write-surface={WRITE_SURFACE.shellNewChat} disabled={!canWrite} title={!canWrite ? "this tab is read-only; take control to create a chat" : undefined} onClick={() => { setDrawer(false); if (canWrite) void onNewChat(); }}><span>+</span><b>new chat</b><kbd>⌘⇧O</kbd></button>}
      {searchControl}
      <nav className="place-nav" aria-label="places">
        <a className="telemetry-link" href={pageHref("/telemetry")} aria-current={isTelemetryPath(location.pathname) ? "page" : undefined}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M1 8h3l2-4 3 8 2-4h4" />
          </svg>
          <b>telemetry</b>
        </a>
      </nav>
      {lists}
      <footer>{agentActions !== false && <SettingsControl onOpen={openSettings} className="settings-button" />}<button type="button" className="palette-button" aria-label="command palette" aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"} onClick={openPalette}><kbd>{modKey("K")}</kbd></button></footer>
    </aside>
    <main className="main-pane" tabIndex={-1} aria-hidden={narrow && drawer ? "true" : undefined} inert={narrow && drawer ? true : undefined}>
      {banner}
      <div className="shell-header">
        <button ref={menuButton} className="menu-button" aria-label="open menu" onClick={() => setDrawer(true)}>☰</button>
        {header}
      </div>
      <PageChatCatalog.Provider value={catalog}>{children}</PageChatCatalog.Provider>
    </main>
    {agentActions !== false && <SettingsDialog open={settingsOpen} onClose={closeSettings} serverForcesAsk={serverForcesAsk} canWrite={canWrite} />}
    {agentActions !== false && shortcutsOpen && <ShortcutsSheet onClose={closeShortcuts} />}
    {paletteOpen && <CommandPalette commands={commands} pages={pageEntries} searchChats={searchChats} onClose={closePalette} />}
  </div>;
}
