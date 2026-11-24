import { useSyncExternalStore } from "react";

export const SETTINGS_KEY = "achilles-settings";
export const AUTO_THEME = "auto";
export const themeChoices = [AUTO_THEME, "g1-light", "g1-dark"] as const;
export type ThemeChoice = (typeof themeChoices)[number];
export type UiFont = "jetbrains-mono" | "ibm-plex-sans" | "inter" | "system";
export type CodeFont = "jetbrains-mono" | "ibm-plex-mono" | "system-mono";
export type Density = "comfortable" | "compact";

export type Settings = {
  v: 1;
  theme: ThemeChoice;
  uiFont: UiFont;
  codeFont: CodeFont;
  size: 13 | 14 | 15 | 16;
  density: Density;
  vim: boolean;
  autoApproveDefault: boolean;
};

export const defaultSettings: Settings = {
  v: 1,
  theme: AUTO_THEME,
  uiFont: "system",
  codeFont: "system-mono",
  size: 15,
  density: "comfortable",
  vim: false,
  autoApproveDefault: true,
};

const uiFonts: readonly UiFont[] = ["jetbrains-mono", "ibm-plex-sans", "inter", "system"];
const codeFonts: readonly CodeFont[] = ["jetbrains-mono", "ibm-plex-mono", "system-mono"];
const densities: readonly Density[] = ["comfortable", "compact"];
const sizes: readonly Settings["size"][] = [13, 14, 15, 16];
const includes = <T extends string | number>(values: readonly T[], value: unknown): value is T => values.includes(value as T);

export function parseSettings(value: string | null): Settings {
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = value === null ? {} : JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch {
    // Invalid browser storage is treated as an empty settings object.
  }
  return {
    v: 1,
    theme: includes(themeChoices, input.theme) ? input.theme : defaultSettings.theme,
    uiFont: includes(uiFonts, input.uiFont) ? input.uiFont : defaultSettings.uiFont,
    codeFont: includes(codeFonts, input.codeFont) ? input.codeFont : defaultSettings.codeFont,
    size: includes(sizes, input.size) ? input.size : defaultSettings.size,
    density: includes(densities, input.density) ? input.density : defaultSettings.density,
    vim: typeof input.vim === "boolean" ? input.vim : defaultSettings.vim,
    autoApproveDefault: typeof input.autoApproveDefault === "boolean" ? input.autoApproveDefault : defaultSettings.autoApproveDefault,
  };
}

const uiFontValues: Record<UiFont, string> = {
  "jetbrains-mono": '"JetBrains Mono Variable", var(--font-mono)',
  "ibm-plex-sans": '"IBM Plex Sans Variable", system-ui, sans-serif',
  inter: '"Inter Variable", system-ui, sans-serif',
  system: "var(--font-sans)",
};
const codeFontValues: Record<CodeFont, string> = {
  "jetbrains-mono": '"JetBrains Mono Variable", var(--font-mono)',
  "ibm-plex-mono": '"IBM Plex Mono", var(--font-mono)',
  "system-mono": "var(--font-mono)",
};

function queryTheme(): ThemeChoice | null {
  if (typeof location === "undefined") return null;
  const value = new URLSearchParams(location.search).get("theme");
  return includes(themeChoices, value) ? value : null;
}

export function applySettings(settings: Settings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = queryTheme() ?? settings.theme;
  if (theme === AUTO_THEME) {
    delete root.dataset.achillesTheme;
    delete root.dataset.fulcrumTheme;
  } else {
    root.dataset.achillesTheme = theme;
    root.dataset.fulcrumTheme = theme === "g1-dark" ? "github-dark" : "github-light";
  }
  if (settings.uiFont === "jetbrains-mono" || settings.codeFont === "jetbrains-mono") {
    void import("@fontsource-variable/jetbrains-mono");
  }
  if (settings.uiFont === "ibm-plex-sans") void import("@fontsource-variable/ibm-plex-sans");
  if (settings.uiFont === "inter") void import("@fontsource-variable/inter");
  if (settings.codeFont === "ibm-plex-mono") void import("@fontsource/ibm-plex-mono/400.css");
  root.dataset.codeFont = settings.codeFont;
  root.dataset.density = settings.density;
  root.style.setProperty("--achilles-ui-font", uiFontValues[settings.uiFont]);
  root.style.setProperty("--achilles-code-font", codeFontValues[settings.codeFont]);
  root.style.setProperty("--achilles-ui-size", `${settings.size}px`);
}

let current = parseSettings(typeof localStorage === "undefined" ? null : localStorage.getItem(SETTINGS_KEY));
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => current;

export function updateSettings(patch: Partial<Omit<Settings, "v">>): void {
  current = parseSettings(JSON.stringify({ ...current, ...patch, v: 1 }));
  if (typeof localStorage !== "undefined") localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
  applySettings(current);
  listeners.forEach((listener) => listener());
}

// reset never changes auto-approve: turning it on needs its own confirm
export const resetTarget = (settings: Settings): Settings => ({ ...defaultSettings, autoApproveDefault: settings.autoApproveDefault });

export function resetSettings(): void {
  current = resetTarget(current);
  if (typeof localStorage !== "undefined") localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
  applySettings(current);
  listeners.forEach((listener) => listener());
}

export function getSettings(): Settings {
  return current;
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

if (typeof window !== "undefined") {
  applySettings(current);
  window.addEventListener("storage", (event) => {
    if (event.key !== SETTINGS_KEY) return;
    current = parseSettings(event.newValue);
    applySettings(current);
    listeners.forEach((listener) => listener());
  });
}
