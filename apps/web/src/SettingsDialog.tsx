import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import {
  themeChoices,
  resetSettings,
  resetTarget,
  updateSettings,
  useSettings,
  type CodeFont,
  type Density,
  type Settings,
  type ThemeChoice,
  type UiFont,
} from "./settings";
import { wrapTab } from "./keyboard";
import { allowNotifications, notificationsSupported } from "./notify";
import "./surface/confirmation.css";
import { WRITE_SURFACE } from "./writeSurfaces";
import "./settings-dialog.css";

const swatches = ["bg", "fg", "accent", "ok", "warn", "danger"];
const uiFonts: Array<[UiFont, string]> = [["geist", "Geist"], ["system", "System"], ["jetbrains-mono", "JetBrains Mono"], ["ibm-plex-sans", "IBM Plex Sans"], ["inter", "Inter"]];
const codeFonts: Array<[CodeFont, string]> = [["jetbrains-mono", "JetBrains Mono"], ["ibm-plex-mono", "IBM Plex Mono"], ["system-mono", "System monospace"]];
const densities: Array<[Density, string]> = [["comfortable", "Comfortable"], ["compact", "Compact"]];
const themeLabels: Record<ThemeChoice, string> = { auto: "System", "g1-light": "Light", "g1-dark": "Dark" };

function Swatch({ theme }: { theme: ThemeChoice }) {
  return <span className="settings-swatch" aria-hidden="true" data-achilles-theme={theme}>
    {swatches.map((name) => <span key={name} style={{ background: `var(--fulcrum-${name})` }} />)}
  </span>;
}

function ThemeList({ value, onChange }: { value: ThemeChoice; onChange(value: ThemeChoice): void }) {
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const focus = (index: number) => options.current[index]?.focus();
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = themeChoices.length - 1;
    const next: Record<string, number> = {
      ArrowDown: Math.min(last, index + 2),
      ArrowUp: Math.max(0, index - 2),
      ArrowRight: Math.min(last, index + 1),
      ArrowLeft: Math.max(0, index - 1),
      Home: 0,
      End: last,
    };
    if (event.key in next) { event.preventDefault(); focus(next[event.key]!); }
  };
  return <div className="theme-options" role="listbox" aria-label="theme">
    {themeChoices.map((theme, index) => <button
      key={theme}
      ref={(node) => { options.current[index] = node; }}
      type="button"
      role="option"
      aria-selected={theme === value}
      tabIndex={theme === value ? 0 : -1}
      data-selected={theme === value || undefined}
      onKeyDown={(event) => onKeyDown(event, index)}
      onClick={() => onChange(theme)}
    >
      <span>{themeLabels[theme]}</span><Swatch theme={theme} />
    </button>)}
  </div>;
}

function Segments<T extends string | number>({ label, value, choices, onChange, surface }: { label: string; value: T; choices: Array<[T, string]>; onChange(value: T): void; surface: string }) {
  return <div className="settings-segments" role="group" aria-label={label} data-write-surface={surface}>
    {choices.map(([choice, text]) => <button key={choice} type="button" aria-pressed={choice === value} onClick={() => onChange(choice)}>{text}</button>)}
  </div>;
}

function Toggle({ label, checked, onChange, disabled, surface, ref }: { label: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean; surface: string; ref?: Ref<HTMLButtonElement> }) {
  return <button ref={ref} className="settings-toggle" type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} data-write-surface={surface} onClick={() => onChange(!checked)}><span /></button>;
}

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="settings-row"><div className="settings-row-label"><h3>{title}</h3><p>{description}</p></div><div>{children}</div></section>;
}

// turning the default on lets new chats run tools without asking, so it goes through a confirm; turning it off does not.
// the switch stays mounted in both states, so focus stays on it; the confirm bar opens below it.
function AutoApprove({ open, on, canWrite, serverForcesAsk }: { open: boolean; on: boolean; canWrite: boolean; serverForcesAsk: boolean }) {
  const toggle = useRef<HTMLButtonElement>(null);
  const allow = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  const effectId = useId();
  useLayoutEffect(() => { if (!open || on) setAsking(false); }, [open, on]);
  // at 390 px the bar opens below the fold; bring "keep asking" into view too
  useLayoutEffect(() => { if (asking) { allow.current?.focus(); bar.current?.scrollIntoView({ block: "nearest" }); } }, [asking]);
  const close = (allowTools: boolean) => {
    if (allowTools && canWrite) updateSettings({ autoApproveDefault: true });
    setAsking(false);
    toggle.current?.focus();
  };
  const explanation = serverForcesAsk ? "the server forces ask mode, so new chats still ask for approval." : on ? "on. new chats allow tool calls by default." : "off. new chats ask before tool calls.";
  const effect = serverForcesAsk ? "new chats allow tool calls without asking once the server stops forcing ask mode." : "new chats allow tool calls without asking.";
  return <div className="settings-auto-approve">
    <div className="setting-explanation"><Toggle ref={toggle} label="auto-approve default" checked={on} disabled={!canWrite} surface={WRITE_SURFACE.settingsAutoApprove} onChange={(next) => { if (!canWrite) return; if (next) setAsking(true); else updateSettings({ autoApproveDefault: false }); }} /><span>{explanation}</span></div>
    {asking && !on && canWrite && <div ref={bar} className="confirmation-inline"><div role="group" className="confirmation-bar" aria-labelledby={effectId}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(false); } }}>
      <p id={effectId}>{effect}</p>
      <div className="confirmation-actions">
        <button ref={allow} type="button" className="confirmation-primary" onClick={() => close(true)}>allow without asking</button>
        <button type="button" onClick={() => close(false)}>keep asking</button>
      </div>
    </div></div>}
  </div>;
}

// turning it on asks the browser once (only while it has not answered); a refusal leaves it off and says where to allow it.
// the switch stays enabled while the browser asks, so focus stays on it
function Notifications({ on }: { on: boolean }) {
  const [asked, setAsked] = useState(false);
  const supported = notificationsSupported();
  const blocked = supported && Notification.permission === "denied";
  // the setting alone is not "on": the site permission can be reset after it was given
  const showing = on && supported && Notification.permission === "granted";
  const explanation = !supported ? "this browser cannot show notifications."
    : blocked ? "the browser blocks notifications for this site. allow them in its site settings, then turn this on."
    : showing ? "on. a hidden tab tells you when a chat needs you or finishes."
    : on ? "off: the browser has no permission now. turn this on to ask again." : "off. turning it on asks the browser for permission.";
  const change = async (next: boolean) => {
    if (!next) { updateSettings({ notify: false }); return; }
    if (asked) return;
    setAsked(true);
    try { if (await allowNotifications()) updateSettings({ notify: true }); } finally { setAsked(false); }
  };
  return <div className="setting-explanation"><Toggle label="notifications" checked={showing} disabled={!supported} surface={WRITE_SURFACE.settingsNotify} onChange={(next) => void change(next)} /><span>{explanation}</span></div>;
}

export function SettingsDialog({ open, onClose, serverForcesAsk = false, canWrite }: { open: boolean; onClose(): void; serverForcesAsk?: boolean; canWrite: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const settings = useSettings();
  // aria-disabled, not disabled, once reset is done: a disabled button would drop focus to the page
  const resetDone = JSON.stringify(settings) === JSON.stringify(resetTarget(settings));
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return <dialog
    ref={dialog}
    className="settings-dialog"
    aria-labelledby="settings-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    onKeyDown={(event) => wrapTab(event, event.currentTarget)}
  >
    <div className="settings-panel">
      <div className="settings-titlebar"><div><span className="settings-mark" /><h2 id="settings-title">settings</h2></div><div><span>Saved in this browser</span><button type="button" onClick={onClose}>esc</button></div></div>
      <div className="settings-content">
        <Row title="Theme" description="System follows your device’s light or dark appearance."><div data-write-surface={WRITE_SURFACE.settingsTheme}><ThemeList value={settings.theme} onChange={(theme) => updateSettings({ theme })} /></div></Row>
        <Row title="Fonts" description="Code uses a monospace font."><div className="font-options"><span>UI</span><Segments label="UI font" value={settings.uiFont} choices={uiFonts} surface={WRITE_SURFACE.settingsUiFont} onChange={(uiFont) => updateSettings({ uiFont })} /><span>Code</span><Segments label="code font" value={settings.codeFont} choices={codeFonts} surface={WRITE_SURFACE.settingsCodeFont} onChange={(codeFont) => updateSettings({ codeFont })} /></div></Row>
        <Row title="Size" description="App text and composers."><div className="size-density"><Segments label="font size" value={settings.size} choices={([13, 14, 15, 16] as Settings["size"][]).map((size) => [size, String(size)])} surface={WRITE_SURFACE.settingsSize} onChange={(size) => updateSettings({ size })} /><span>Density</span><Segments label="density" value={settings.density} choices={densities} surface={WRITE_SURFACE.settingsDensity} onChange={(density) => updateSettings({ density })} /></div></Row>
        <Row title="Vim mode" description="Desktop only, in the composer."><div className="setting-explanation"><Toggle label="vim mode" checked={settings.vim} surface={WRITE_SURFACE.settingsVim} onChange={(vim) => updateSettings({ vim })} /><span>Starts in INSERT. Esc goes to NORMAL; Esc in NORMAL leaves the composer.</span></div></Row>
        <Row title="Notifications" description="When this tab is hidden."><Notifications on={settings.notify} /></Row>
      </div>
      <section aria-label="new chat defaults and reset" aria-describedby={!canWrite ? "settings-lock-note" : undefined} className="settings-session">
        {!canWrite && <p id="settings-lock-note">only a tab that controls zeta can change auto-approve or reset.</p>}
        <div className="settings-content">
          <Row title="Auto-approve" description="Default for new chats."><AutoApprove open={open} on={settings.autoApproveDefault} canWrite={canWrite} serverForcesAsk={serverForcesAsk} /></Row>
        </div>
        <footer><span><button type="button" className="settings-link" data-write-surface={WRITE_SURFACE.settingsReset} onClick={() => { if (canWrite && !resetDone) resetSettings(); }} disabled={!canWrite} aria-disabled={resetDone || undefined}>reset to defaults</button> <span className="settings-reset-note">auto-approve is not reset.</span></span><span>keyboard shortcuts&nbsp;&nbsp;?</span></footer>
      </section>
    </div>
  </dialog>;
}
