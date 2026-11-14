import { useSyncExternalStore } from "react";
import { themes } from "@fulcrum/react";

export const SETTINGS_KEY = "achilles-settings";
export const AUTO_THEME = "auto";
export const themeChoices = [AUTO_THEME, ...themes] as const;
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
  uiFont: "jetbrains-mono",
  codeFont: "jetbrains-mono",
  size: 14,
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
  "jetbrains-mono": '"JetBrains Mono", ui-monospace, monospace',
  "ibm-plex-sans": '"IBM Plex Sans", system-ui, sans-serif',
  inter: '"Inter", system-ui, sans-serif',
  system: "system-ui, sans-serif",
};
const codeFontValues: Record<CodeFont, string> = {
  "jetbrains-mono": '"JetBrains Mono", ui-monospace, monospace',
  "ibm-plex-mono": '"IBM Plex Mono", ui-monospace, monospace',
  "system-mono": "ui-monospace, SFMono-Regular, Consolas, monospace",
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
  if (theme === AUTO_THEME) delete root.dataset.fulcrumTheme;
  else root.dataset.fulcrumTheme = theme;
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

export function resetSettings(): void {
  current = { ...defaultSettings };
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
