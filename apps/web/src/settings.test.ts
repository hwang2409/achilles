import { describe, expect, test } from "bun:test";
import { applySettings, defaultSettings, parseSettings } from "./settings";

async function moduleMockCalls() {
  const calls: string[] = [];
  for (const pattern of ["**/*.test.ts", "**/*.test.tsx"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: import.meta.dir, absolute: true })) {
      if (/mock\s*\.\s*module\s*\(/.test(await Bun.file(path).text())) calls.push(path.replace(`${import.meta.dir}/`, "apps/web/src/"));
    }
  }
  return calls;
}

describe("web test isolation", () => {
  test("injects dependencies instead of replacing shared modules", async () => {
    expect(await moduleMockCalls(), "mock.module leaks across test files; inject the dependency instead").toEqual([]);
  });
});

describe("parseSettings", () => {
  test("defaults to system appearance and font, system monospace, and 15px", () => {
    expect(parseSettings(null)).toMatchObject({ theme: "auto", uiFont: "system", codeFont: "system-mono", size: 15 });
  });

  test("replaces old named palettes but still applies v1 font and size choices", () => {
    const palettes = ["github-light", "github-dark", "gruvbox-light", "gruvbox-dark", "dracula", "nord", "tokyo-night", "catppuccin-mocha", "catppuccin-latte", "solarized-dark", "solarized-light", "one-dark"];
    for (const theme of palettes) expect(parseSettings(JSON.stringify({ theme })).theme).toBe("auto");
    const ui = [["jetbrains-mono", "JetBrains Mono"], ["ibm-plex-sans", "IBM Plex Sans"], ["inter", "Inter"], ["system", "--font-sans"]] as const;
    const code = [["jetbrains-mono", "JetBrains Mono"], ["ibm-plex-mono", "IBM Plex Mono"], ["system-mono", "--font-mono"]] as const;
    const root = document.documentElement;
    const original = root.style.cssText;
    try {
      for (const [uiFont, uiFamily] of ui) for (const [codeFont, codeFamily] of code) for (const size of [13, 14, 15, 16]) {
        const saved = parseSettings(JSON.stringify({ v: 1, theme: "nord", uiFont, codeFont, size }));
        expect(saved).toMatchObject({ theme: "auto", uiFont, codeFont, size });
        applySettings(saved);
        expect(root.style.getPropertyValue("--achilles-ui-font")).toContain(uiFamily);
        expect(root.style.getPropertyValue("--achilles-code-font")).toContain(codeFamily);
        expect(root.style.getPropertyValue("--achilles-ui-size")).toBe(`${size}px`);
      }
    } finally {
      root.style.cssText = original;
    }
  });

  test("falls back per field for malformed browser storage", () => {
    expect(parseSettings("not json")).toEqual(defaultSettings);
    expect(parseSettings(JSON.stringify({
      v: 99,
      theme: "not-a-theme",
      uiFont: "inter",
      codeFont: 42,
      size: 99,
      density: "compact",
      vim: "yes",
      autoApproveDefault: false,
      unknown: "ignored",
    }))).toEqual({
      ...defaultSettings,
      uiFont: "inter",
      density: "compact",
      autoApproveDefault: false,
    });
    expect(parseSettings(JSON.stringify({ uiFont: "constructor", codeFont: "__proto__" }))).toEqual(defaultSettings);
    expect(parseSettings(JSON.stringify(["gruvbox-light"]))).toEqual(defaultSettings);
  });
});
