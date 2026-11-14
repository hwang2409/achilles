import { describe, expect, test } from "bun:test";
import { expectBrowserErrors, type BrowserErrorExpectation } from "./browser-errors";

type Fake = { listeners: Record<string, ((value: unknown) => void)[]>; on(event: string, listener: (value: unknown) => void): void; off(event: string, listener: (value: unknown) => void): void; emit(event: string, value: unknown): void };
const fakePage = (): Fake => {
  const listeners: Fake["listeners"] = {};
  return { listeners, on: (event, listener) => (listeners[event] ??= []).push(listener), off: (event, listener) => { listeners[event] = (listeners[event] ?? []).filter((item) => item !== listener); }, emit: (event, value) => { for (const listener of listeners[event] ?? []) listener(value); } };
};
const response = (method: string, url: string, status: number) => ({ request: () => ({ method: () => method }), url: () => url, status: () => status });
const message = (url: string, text: string) => ({ type: () => "error", location: () => ({ url }), text: () => text });
const expected: BrowserErrorExpectation[] = [{ method: "GET", url: "http://test/fail", status: 503 }];

describe("expectBrowserErrors", () => {
  test("allows an exact response and console error", async () => {
    const page = fakePage();
    await expectBrowserErrors(page, expected, async () => { page.emit("response", response("GET", "http://test/fail", 503)); page.emit("console", message("http://test/fail", "503")); });
  });
  test("rejects the same status at a different url", async () => {
    const page = fakePage();
    await expect(expectBrowserErrors(page, expected, async () => { page.emit("response", response("GET", "http://test/fail", 503)); page.emit("console", message("http://test/other", "503")); })).rejects.toThrow("unexpected browser console error");
  });
  test("rejects a missing expected error", async () => {
    const page = fakePage();
    await expect(expectBrowserErrors(page, expected, async () => {})).rejects.toThrow("expected browser error did not occur");
  });
  test("reports an unexpected response after the step", async () => {
    const page = fakePage();
    let stepFinished = false;
    await expect(expectBrowserErrors(page, expected, async () => {
      page.emit("response", response("GET", "http://test/fail", 503));
      page.emit("response", response("GET", "http://test/other", 500));
      stepFinished = true;
    })).rejects.toThrow("unexpected browser response: GET http://test/other 500");
    expect(stepFinished).toBe(true);
  });
});
