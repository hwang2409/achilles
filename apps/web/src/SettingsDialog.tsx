import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import {
  AUTO_THEME,
  defaultSettings,
  resetSettings,
  updateSettings,
  useSettings,
  type CodeFont,
  type Density,
  type Settings,
  type ThemeChoice,
  type UiFont,
} from "./settings";
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

function Segments<T extends string | number>({ label, value, choices, onChange }: { label: string; value: T; choices: Array<[T, string]>; onChange(value: T): void }) {
  return <div className="settings-segments" role="group" aria-label={label}>
    {choices.map(([choice, text]) => <button key={choice} type="button" aria-pressed={choice === value} onClick={() => onChange(choice)}>{text}</button>)}
  </div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <button className="settings-toggle" type="button" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>;
}

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="settings-row"><div className="settings-row-label"><h3>{title}</h3><p>{description}</p></div><div>{children}</div></section>;
}

export function SettingsDialog({ open, onClose, serverForcesAsk = false }: { open: boolean; onClose(): void; serverForcesAsk?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const settings = useSettings();
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
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled):not([tabindex='-1']), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
  >
    <div className="settings-panel">
      <div className="settings-titlebar"><div><span className="settings-mark" /><h2 id="settings-title">settings</h2></div><div><span>saved in this browser</span><button type="button" onClick={onClose}>esc</button></div></div>
      <div className="settings-content">
        <Row title="theme" description="fulcrum palettes. auto follows the OS."><ThemeList value={settings.theme} onChange={(theme) => updateSettings({ theme })} /></Row>
        <Row title="fonts" description="self-hosted. code stays mono."><div className="font-options"><span>ui</span><Segments label="UI font" value={settings.uiFont} choices={uiFonts} onChange={(uiFont) => updateSettings({ uiFont })} /><span>code</span><Segments label="code font" value={settings.codeFont} choices={codeFonts} onChange={(codeFont) => updateSettings({ codeFont })} /></div></Row>
        <Row title="size" description="achilles chrome."><div className="size-density"><Segments label="font size" value={settings.size} choices={([13, 14, 15, 16] as Settings["size"][]).map((size) => [size, String(size)])} onChange={(size) => updateSettings({ size })} /><span>density</span><Segments label="density" value={settings.density} choices={densities} onChange={(density) => updateSettings({ density })} /></div></Row>
        <Row title="vim mode" description="in the composer only."><div className="setting-explanation"><Toggle label="vim mode" checked={settings.vim} onChange={(vim) => updateSettings({ vim })} /><span>starts in INSERT. esc goes to NORMAL; esc in NORMAL leaves the composer.</span></div></Row>
        <Row title="auto-approve" description="default for new chats."><div className="setting-explanation"><Toggle label="auto-approve default" checked={settings.autoApproveDefault} onChange={(autoApproveDefault) => updateSettings({ autoApproveDefault })} /><span>{serverForcesAsk ? "the server forces ask mode, so new chats still ask for approval." : settings.autoApproveDefault ? "on. new chats allow tool calls by default." : "off. new chats ask before tool calls."}</span></div></Row>
      </div>
      <footer><button type="button" className="settings-link" onClick={() => resetSettings()} disabled={JSON.stringify(settings) === JSON.stringify(defaultSettings)}>reset to defaults</button><span>keyboard shortcuts&nbsp;&nbsp;?</span></footer>
    </div>
  </dialog>;
}

export function SettingsControl({ onOpen, className = "settings-entry" }: { onOpen(opener: HTMLElement): void; className?: string }) {
  return <button className={className} type="button" onClick={(event) => onOpen(event.currentTarget)}><span aria-hidden="true">☼</span><span className="settings-label">settings</span><kbd>{navigator.platform.includes("Mac") ? "⌘," : "ctrl+,"}</kbd></button>;
}
