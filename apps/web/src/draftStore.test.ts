import { describe, expect, test } from "bun:test";
import { draftStore } from "./draftStore";

describe("draft store", () => {
  test.each([
    ["vim operator edit survives a composer switch", "operator", ["remove\nkeep", "keep"], "keep"],
    ["confirmed send clears before a composer switch", "sent", ["message", ""], ""],
    ["multiline text survives a composer switch exactly", "multiline", ["first\n\n  third"], "first\n\n  third"],
    ["reconnect reads the session draft", "reconnect", ["kept draft"], "kept draft"],
  ])("%s", (_name, sessionId, writes, expected) => {
    for (const text of writes) draftStore.set(sessionId, text);
    expect(draftStore.get(sessionId)).toBe(expected);
    draftStore.set(sessionId, "");
  });

  test("keeps sessions separate and publishes changes", () => {
    const values: string[] = [];
    const unsubscribe = draftStore.subscribe("one", () => values.push(draftStore.get("one")));
    draftStore.set("one", "alpha");
    draftStore.set("two", "beta");
    draftStore.set("one", "");
    unsubscribe();
    expect(draftStore.get("two")).toBe("beta");
    expect(values).toEqual(["alpha", ""]);
    draftStore.set("two", "");
  });

  test("reconciles independent tabs and caps drafts by utf-8 bytes", async () => {
    const values = new Map<string, string>();
    const data = new Map<string, string>();
    const sharedStorage = {
      get length() { return data.size; },
      key(index: number) { return [...data.keys()][index] ?? null; },
      getItem(key: string) { return data.get(key) ?? null; },
      setItem(key: string, value: string) { data.set(key, value); },
      removeItem(key: string) { data.delete(key); },
      clear() { data.clear(); },
    };
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: sharedStorage });
    try {
      const [{ draftStore: tabA }, { draftStore: tabB }] = await Promise.all([
        import("./draftStore?tab=a"),
        import("./draftStore?tab=b"),
      ]);
      tabA.subscribe("chat-1", () => values.set("chat-1", tabA.get("chat-1")));
      tabA.set("chat-1", "already sent");
      tabB.get("chat-1");
      tabA.confirm("chat-1", "already sent");
      tabB.set("chat-2", "other draft");
      expect(tabA.get("chat-1")).toBe("");

      tabA.subscribe("chat-2", () => values.set("chat-2", tabA.get("chat-2")));
      tabB.set("chat-1", "edited elsewhere");
      const event = new Event("storage");
      Object.defineProperties(event, { key: { value: "achilles:draft:chat-1" }, newValue: { value: data.get("achilles:draft:chat-1") }, storageArea: { value: sharedStorage } });
      globalThis.dispatchEvent(event);
      expect(tabA.get("chat-1")).toBe("edited elsewhere");

      const oversized = "🙂".repeat(32 * 1024);
      tabA.set("chat-3", oversized);
      expect(tabA.get("chat-3")).toBe(oversized);
      expect(data.has("achilles:draft:chat-3")).toBe(false);
      expect(values.get("chat-2")).toBeUndefined();
    } finally {
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
