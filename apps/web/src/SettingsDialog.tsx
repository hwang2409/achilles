import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
import {
  AUTO_THEME,
  getSettings,
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
import { Confirmation, reviewText } from "./surface/Confirmation";
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

// turning the default on lets new chats run tools without asking, so it goes through a confirm; turning it off does not
function AutoApprove({ open, on, canWrite, serverForcesAsk }: { open: boolean; on: boolean; canWrite: boolean; serverForcesAsk: boolean }) {
  const toggle = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  useLayoutEffect(() => {
    // the confirm row goes away once the default is on: keep focus on the row's control
    if (on && confirmed.current) toggle.current?.focus();
    confirmed.current = false;
  }, [on]);
  const explanation = <span>{serverForcesAsk ? "the server forces ask mode, so new chats still ask for approval." : on ? "on. new chats allow tool calls by default." : "off. new chats ask before tool calls."}</span>;
  if (on || !canWrite) return <div className="setting-explanation"><Toggle ref={toggle} label="auto-approve default" checked={on} disabled={!canWrite} surface={WRITE_SURFACE.settingsAutoApprove} onChange={(autoApproveDefault) => { if (canWrite) updateSettings({ autoApproveDefault }); }} />{explanation}</div>;
  return <div className="settings-auto-approve">
    {/* closing the settings dialog drops an open confirm */}
    <Confirmation key={String(open)} level={1} surface={WRITE_SURFACE.settingsAutoApprove} label={reviewText("auto-approve default")} value={reviewText("off")}
      action={reviewText("allow without asking")} keep={reviewText("keep asking")} effect={reviewText("new chats allow tool calls without asking.")}
      execute={async () => {
        if (!canWrite) return { status: "failed", reason: "refused" };
        confirmed.current = true;
        updateSettings({ autoApproveDefault: true });
        return { status: "committed", receipt: reviewText("auto-approve on"), value: reviewText("on") };
      }}
      checkResult={async () => getSettings().autoApproveDefault ? { status: "committed", receipt: reviewText("auto-approve on"), value: reviewText("on") } : { status: "failed", reason: "not-applied" }} onCommitted={() => {}} />
    {explanation}
  </div>;
}

export function SettingsDialog({ open, onClose, serverForcesAsk = false, canWrite }: { open: boolean; onClose(): void; serverForcesAsk?: boolean; canWrite: boolean }) {
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
        {!canWrite && <p id="settings-lock-note">locked while another tab controls zeta</p>}
        <div className="settings-content">
          <Row title="auto-approve" description="default for new chats."><AutoApprove open={open} on={settings.autoApproveDefault} canWrite={canWrite} serverForcesAsk={serverForcesAsk} /></Row>
        </div>
        <footer><span><button type="button" className="settings-link" data-write-surface={WRITE_SURFACE.settingsReset} onClick={() => { if (canWrite) resetSettings(); }} disabled={!canWrite || JSON.stringify(settings) === JSON.stringify(resetTarget(settings))}>reset to defaults</button> <span className="settings-reset-note">auto-approve is not reset.</span></span><span>keyboard shortcuts&nbsp;&nbsp;?</span></footer>
      </section>
    </div>
  </dialog>;
}
