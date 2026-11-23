import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import {
  AUTO_THEME,
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
import { focusConfirmationResult } from "./surface/Confirmation";
import { WRITE_SURFACE } from "./writeSurfaces";
import "./settings-dialog.css";

const swatches = ["bg", "fg", "accent", "ok", "warn", "danger"];
const uiFonts: Array<[UiFont, string]> = [["jetbrains-mono", "JetBrains Mono"], ["ibm-plex-sans", "IBM Plex Sans"], ["inter", "Inter"], ["system", "system"]];
const codeFonts: Array<[CodeFont, string]> = [["jetbrains-mono", "JetBrains Mono"], ["ibm-plex-mono", "IBM Plex Mono"], ["system-mono", "system mono"]];
const densities: Array<[Density, string]> = [["comfortable", "comfortable"], ["compact", "compact"]];
const displayedThemes: readonly ThemeChoice[] = ["auto", "github-dark", "gruvbox-dark", "gruvbox-light", "dracula", "nord", "tokyo-night", "catppuccin-mocha", "catppuccin-latte", "solarized-dark", "solarized-light", "github-light", "one-dark"];

function Swatch({ theme }: { theme: ThemeChoice }) {
  return <span className="settings-swatch" aria-hidden="true" data-fulcrum-theme={theme === AUTO_THEME ? undefined : theme}>
    {swatches.map((name) => <span key={name} style={{ background: `var(--fulcrum-${name})` }} />)}
  </span>;
}

function ThemeList({ value, onChange }: { value: ThemeChoice; onChange(value: ThemeChoice): void }) {
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const focus = (index: number) => options.current[index]?.focus();
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = displayedThemes.length - 1;
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
    {displayedThemes.map((theme, index) => <button
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
      <span>{theme}</span><Swatch theme={theme} />
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
// the confirm bar opens below the switch. cancel returns to the switch; success focuses the updated explanation.
function AutoApprove({ open, on, canWrite, serverForcesAsk }: { open: boolean; on: boolean; canWrite: boolean; serverForcesAsk: boolean }) {
  const toggle = useRef<HTMLButtonElement>(null);
  const allow = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLSpanElement>(null);
  const confirmed = useRef(false);
  const [asking, setAsking] = useState(false);
  const effectId = useId();
  useLayoutEffect(() => {
    if (!open || on) setAsking(false);
    if (open && on && confirmed.current) focusConfirmationResult(result.current);
    if (!open || on) confirmed.current = false;
  }, [open, on]);
  // at 390 px the bar opens below the fold; bring "keep asking" into view too
  useLayoutEffect(() => { if (asking) { allow.current?.focus(); bar.current?.scrollIntoView({ block: "nearest" }); } }, [asking]);
  const close = (allowTools: boolean) => {
    if (allowTools && canWrite) {
      confirmed.current = true;
      updateSettings({ autoApproveDefault: true });
    } else toggle.current?.focus();
    setAsking(false);
  };
  const explanation = serverForcesAsk ? `${on ? "on" : "off"}. the server forces ask mode, so new chats still ask for approval.` : on ? "on. new chats allow tool calls by default." : "off. new chats ask before tool calls.";
  const effect = serverForcesAsk ? "new chats allow tool calls without asking once the server stops forcing ask mode." : "new chats allow tool calls without asking.";
  return <div className="settings-auto-approve">
    <div className="setting-explanation"><Toggle ref={toggle} label="auto-approve default" checked={on} disabled={!canWrite} surface={WRITE_SURFACE.settingsAutoApprove} onChange={(next) => { if (!canWrite) return; if (next) setAsking(true); else updateSettings({ autoApproveDefault: false }); }} /><span ref={result} tabIndex={-1}>{explanation}</span></div>
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
      <div className="settings-titlebar"><div><span className="settings-mark" /><h2 id="settings-title">settings</h2></div><div><span>saved in this browser</span><button type="button" onClick={onClose}>esc</button></div></div>
      <div className="settings-content">
        <Row title="theme" description="fulcrum palettes. auto follows the OS."><div data-write-surface={WRITE_SURFACE.settingsTheme}><ThemeList value={settings.theme} onChange={(theme) => updateSettings({ theme })} /></div></Row>
        <Row title="fonts" description="self-hosted. code stays mono."><div className="font-options"><span>ui</span><Segments label="UI font" value={settings.uiFont} choices={uiFonts} surface={WRITE_SURFACE.settingsUiFont} onChange={(uiFont) => updateSettings({ uiFont })} /><span>code</span><Segments label="code font" value={settings.codeFont} choices={codeFonts} surface={WRITE_SURFACE.settingsCodeFont} onChange={(codeFont) => updateSettings({ codeFont })} /></div></Row>
        <Row title="size" description="app text and composers."><div className="size-density"><Segments label="font size" value={settings.size} choices={([13, 14, 15, 16] as Settings["size"][]).map((size) => [size, String(size)])} surface={WRITE_SURFACE.settingsSize} onChange={(size) => updateSettings({ size })} /><span>density</span><Segments label="density" value={settings.density} choices={densities} surface={WRITE_SURFACE.settingsDensity} onChange={(density) => updateSettings({ density })} /></div></Row>
        <Row title="vim mode" description="desktop only, in the composer."><div className="setting-explanation"><Toggle label="vim mode" checked={settings.vim} surface={WRITE_SURFACE.settingsVim} onChange={(vim) => updateSettings({ vim })} /><span>starts in INSERT. esc goes to NORMAL; esc in NORMAL leaves the composer.</span></div></Row>
      </div>
      <section aria-label="new chat defaults and reset" aria-describedby={!canWrite ? "settings-lock-note" : undefined} className="settings-session">
        {!canWrite && <p id="settings-lock-note">only a tab that controls zeta can change auto-approve or reset.</p>}
        <div className="settings-content">
          <Row title="auto-approve" description="default for new chats."><AutoApprove open={open} on={settings.autoApproveDefault} canWrite={canWrite} serverForcesAsk={serverForcesAsk} /></Row>
        </div>
        <footer><span><button type="button" className="settings-link" data-write-surface={WRITE_SURFACE.settingsReset} onClick={() => { if (canWrite && !resetDone) resetSettings(); }} disabled={!canWrite} aria-disabled={resetDone || undefined}>reset to defaults</button> <span className="settings-reset-note">auto-approve is not reset.</span></span><span>keyboard shortcuts&nbsp;&nbsp;?</span></footer>
      </section>
    </div>
  </dialog>;
}
