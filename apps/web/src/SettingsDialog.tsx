import { useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
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
import { WRITE_SURFACE } from "./writeSurfaces";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const uiFonts: Array<[UiFont, string]> = [["system", "System"], ["jetbrains-mono", "JetBrains Mono"], ["ibm-plex-sans", "IBM Plex Sans"], ["inter", "Inter"]];
const codeFonts: Array<[CodeFont, string]> = [["jetbrains-mono", "JetBrains Mono"], ["ibm-plex-mono", "IBM Plex Mono"], ["system-mono", "System monospace"]];
const densities: Array<[Density, string]> = [["comfortable", "Comfortable"], ["compact", "Compact"]];
const themeLabels: Record<ThemeChoice, string> = { auto: "System", "g1-light": "Light", "g1-dark": "Dark" };

function Segments<T extends string | number>({ label, value, choices, onChange, surface }: { label: string; value: T; choices: Array<[T, string]>; onChange(value: T): void; surface: string }) {
  return <ToggleGroup type="single" variant="outline" className="flex-wrap gap-1" aria-label={label} value={String(value)} data-write-surface={surface}
    onValueChange={(next) => { const choice = choices.find(([item]) => String(item) === next); if (choice) onChange(choice[0]); }}>
    {choices.map(([choice, text]) => <ToggleGroupItem key={choice} type="button" value={String(choice)} aria-pressed={choice === value} className="min-h-9 rounded-md border data-[state=on]:bg-primary data-[state=on]:text-primary-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]">{text}</ToggleGroupItem>)}
  </ToggleGroup>;
}

function Toggle({ label, checked, onChange, disabled, surface, ref }: { label: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean; surface: string; ref?: Ref<HTMLButtonElement> }) {
  return <Switch className="relative min-h-[24px] min-w-[38px] px-0.5 max-sm:min-h-[44px] max-sm:min-w-[44px]" ref={ref} aria-label={label} checked={checked} disabled={disabled} data-write-surface={surface} onCheckedChange={onChange} />;
}

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="grid gap-2 border-t py-4 sm:grid-cols-[12rem_minmax(0,1fr)]"><div><h3 className="font-semibold">{title}</h3><p className="text-sm text-muted-foreground">{description}</p></div><div>{children}</div></section>;
}

// turning the default on lets new chats run tools without asking, so it goes through a confirm; turning it off does not.
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
  return <div className="grid gap-2">
    <div className="flex items-center gap-3 text-sm text-muted-foreground"><Toggle ref={toggle} label="auto-approve default" checked={on} disabled={!canWrite} surface={WRITE_SURFACE.settingsAutoApprove} onChange={(next) => { if (!canWrite) return; if (next) setAsking(true); else updateSettings({ autoApproveDefault: false }); }} /><span>{explanation}</span></div>
    {asking && !on && canWrite && <div ref={bar} className="border-l-2 border-warning bg-warning/5 p-3"><div role="group" className="grid gap-2" aria-labelledby={effectId}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(false); } }}>
      <p id={effectId}>{effect}</p>
      <div className="flex flex-wrap gap-2">
        <Button ref={allow} type="button" onClick={() => close(true)}>allow without asking</Button>
        <Button variant="outline" type="button" onClick={() => close(false)}>keep asking</Button>
      </div>
    </div></div>}
  </div>;
}

export function SettingsDialog({ open, onClose, restoreFocus, serverForcesAsk = false, canWrite }: { open: boolean; onClose(): void; restoreFocus(): void; serverForcesAsk?: boolean; canWrite: boolean }) {
  const settings = useSettings();
  const resetDone = JSON.stringify(settings) === JSON.stringify(resetTarget(settings));
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined} className="max-h-[90dvh] [&_button]:max-sm:min-h-[44px] [&_button]:max-sm:min-w-[44px] gap-0 overflow-auto rounded-none animate-none p-4 sm:max-w-2xl sm:p-6" onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
      <header className="sticky -top-4 z-10 flex flex-wrap items-center justify-between gap-2 bg-background pb-4 sm:-top-6"><DialogTitle>settings</DialogTitle><div className="flex items-center gap-3 text-sm text-muted-foreground"><span>Saved in this browser</span><Button type="button" size="sm" variant="outline" onClick={onClose}>esc</Button></div></header>
      <div>
        <Row title="Theme" description="System follows your device’s light or dark appearance."><Segments label="theme" value={settings.theme} choices={themeChoices.map((theme) => [theme, themeLabels[theme]])} surface={WRITE_SURFACE.settingsTheme} onChange={(theme) => updateSettings({ theme })} /></Row>
        <Row title="Fonts" description="Code uses a monospace font."><div className="grid gap-2"><span>UI</span><Segments label="UI font" value={settings.uiFont} choices={uiFonts} surface={WRITE_SURFACE.settingsUiFont} onChange={(uiFont) => updateSettings({ uiFont })} /><span>Code</span><Segments label="code font" value={settings.codeFont} choices={codeFonts} surface={WRITE_SURFACE.settingsCodeFont} onChange={(codeFont) => updateSettings({ codeFont })} /></div></Row>
        <Row title="Size" description="App text and composers."><div className="grid gap-2"><Segments label="font size" value={settings.size} choices={([13, 14, 15, 16] as Settings["size"][]).map((size) => [size, String(size)])} surface={WRITE_SURFACE.settingsSize} onChange={(size) => updateSettings({ size })} /><span>Density</span><Segments label="density" value={settings.density} choices={densities} surface={WRITE_SURFACE.settingsDensity} onChange={(density) => updateSettings({ density })} /></div></Row>
        <Row title="Vim mode" description="Desktop only, in the composer."><div className="flex items-start gap-3 text-sm text-muted-foreground"><Toggle label="vim mode" checked={settings.vim} surface={WRITE_SURFACE.settingsVim} onChange={(vim) => updateSettings({ vim })} /><span>Starts in INSERT. Esc goes to NORMAL; Esc in NORMAL leaves the composer.</span></div></Row>
      </div>
      <section aria-label="new chat defaults and reset" aria-describedby={!canWrite ? "settings-lock-note" : undefined} className="border-t">
        {!canWrite && <p id="settings-lock-note">only a tab that controls zeta can change auto-approve or reset.</p>}
        <div className="mt-2">
          <Row title="Auto-approve" description="Default for new chats."><AutoApprove open={open} on={settings.autoApproveDefault} canWrite={canWrite} serverForcesAsk={serverForcesAsk} /></Row>
        </div>
        <footer className="flex flex-wrap justify-between gap-2 border-t pt-3 text-xs text-muted-foreground"><span><Button variant="link" size="xs" type="button" data-write-surface={WRITE_SURFACE.settingsReset} onClick={() => { if (canWrite && !resetDone) resetSettings(); }} disabled={!canWrite} aria-disabled={resetDone || undefined}>reset to defaults</Button> <span >auto-approve is not reset.</span></span><span>keyboard shortcuts&nbsp;&nbsp;?</span></footer>
      </section>
    </DialogContent>
  </Dialog>;
}
