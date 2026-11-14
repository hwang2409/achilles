import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Effect = { deps: unknown[]; cleanup?: () => void };
type Deferred = { promise: Promise<Response>; resolve: (response: Response) => void };
type Element = React.ReactElement<Record<string, unknown>>;

let states: unknown[] = [];
let refs: Array<{ current: unknown }> = [];
let effects: Effect[] = [];
let pendingEffects: Array<() => void> = [];
let stateIndex = 0;
let refIndex = 0;
let effectIndex = 0;
let activePage = page("page-one", "books");

function resetHooks() {
  for (const effect of effects) effect.cleanup?.();
  states = [];
  refs = [];
  effects = [];
  pendingEffects = [];
}

function beginRender() {
  stateIndex = 0;
  refIndex = 0;
  effectIndex = 0;
  pendingEffects = [];
}

function flushEffects() {
  for (const run of pendingEffects) run();
  pendingEffects = [];
}

function useState<T>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
  const index = stateIndex++;
  if (!(index in states)) states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
  return [states[index] as T, (next) => { states[index] = typeof next === "function" ? (next as (value: T) => T)(states[index] as T) : next; }];
}

function useRef<T>(initial: T): React.RefObject<T> {
  const index = refIndex++;
  refs[index] ??= { current: initial };
  return refs[index] as React.RefObject<T>;
}

function useEffect(run: () => void | (() => void), deps: unknown[]) {
  const index = effectIndex++;
  const previous = effects[index];
  if (previous && deps.every((value, dependency) => Object.is(value, previous.deps[dependency]))) return;
  pendingEffects.push(() => {
    previous?.cleanup?.();
    const cleanup = run();
    effects[index] = { deps, cleanup: cleanup || undefined };
  });
}

function page(id: string, collection: string) {
  return {
    id,
    title: id,
    create_mode: false,
    approval_mode: "ask",
    layout: { blocks: [{ type: "list", title: "reading", collection }] },
  };
}

const noOperation = () => {};
const asyncNoOperation = async () => {};

beforeAll(() => {
  mock.module("react", () => ({
    ...React,
    useEffect,
    useLayoutEffect: useEffect,
    useMemo: (factory: () => unknown) => factory(),
    useRef,
    useState,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  }));
  const settings = { v: 1, theme: "auto", uiFont: "jetbrains-mono", codeFont: "jetbrains-mono", size: 14, density: "comfortable", vim: false, autoApproveDefault: true };
  mock.module("./settings", () => ({ AUTO_THEME: "auto", defaultSettings: settings, resetSettings: noOperation, updateSettings: noOperation, useSettings: () => settings }));
  mock.module("./zeta", () => ({
    createConnection: () => ({
      client: null,
      state: { phase: "connected" },
      subscribe: () => noOperation,
      stop: noOperation,
    }),
  }));
  mock.module("./useActiveChat", () => ({
    DroppedSteerDeliveryError: class extends Error {},
    UncertainSteerDeliveryError: class extends Error {},
    useActiveChat: () => ({
      state: { phase: "empty", page: activePage, credential: "secret", serverApprovalMode: "ask" },
      continueWaitingChat: asyncNoOperation,
      creationError: null,
      focusSessionId: null,
      listRefresh: 0,
      newChat: asyncNoOperation,
      recordLastState: noOperation,
      refreshPage: asyncNoOperation,
      retrySaving: asyncNoOperation,
      selectChat: noOperation,
      send: asyncNoOperation,
      settleApprovalMode: asyncNoOperation,
      toggle: noOperation,
      toggleBlocked: false,
      toggleError: null,
      toggleRetryable: false,
      toggling: false,
    }),
  }));
});

afterAll(() => resetHooks());

function deferred(): Deferred {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(records: Record<string, unknown>[]) {
  return new Response(JSON.stringify(records), { headers: { "content-type": "application/json", "x-achilles-total": String(records.length) } });
}

function find(element: React.ReactNode, name: string): Element | null {
  if (!React.isValidElement(element)) return null;
  if (typeof element.type === "function" && element.type.name === name) return element as Element;
  for (const child of React.Children.toArray((element.props as { children?: React.ReactNode }).children)) {
    const match = find(child, name);
    if (match) return match;
  }
  return null;
}

function renderRecordList(component: (props: Record<string, unknown>) => React.ReactNode, props: Record<string, unknown>) {
  beginRender();
  const view = component(props) as React.ReactElement;
  return renderToStaticMarkup(view);
}

async function recordListTypes() {
  const { App } = await import("./App");
  beginRender();
  const layout = find(App(), "LayoutBlock");
  expect(layout).not.toBeNull();
  const LayoutBlock = layout!.type as (props: Record<string, unknown>) => Element;
  resetHooks();
  const first = LayoutBlock({ block: activePage.layout.blocks[0], pageId: activePage.id, credential: "secret", refreshKey: "0:0" });
  return { LayoutBlock, RecordList: first.type as (props: Record<string, unknown>) => React.ReactNode, first };
}

function installHeldFetch() {
  const calls: Deferred[] = [];
  const originalFetch = globalThis.fetch;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://achilles.test" } });
  globalThis.fetch = (() => {
    const call = deferred();
    calls.push(call);
    return call.promise;
  }) as typeof fetch;
  return {
    calls,
    restore() {
      resetHooks();
      globalThis.fetch = originalFetch;
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
      else delete (globalThis as { location?: unknown }).location;
    },
  };
}

async function settle(call: Deferred, value: Record<string, unknown>[]) {
  call.resolve(response(value));
  await call.promise;
  await Promise.resolve();
  await Promise.resolve();
}

describe("RecordList", () => {
  test("shows loading instead of empty while the first fetch is held", async () => {
    activePage = page("page-one", "books");
    const fetch = installHeldFetch();
    try {
      const { RecordList, first } = await recordListTypes();
      const markup = renderRecordList(RecordList, first.props);
      expect(markup).toContain("loading records…");
      expect(markup).not.toContain("no records yet");
      flushEffects();
      await settle(fetch.calls[0], []);
    } finally {
      fetch.restore();
    }
  });

  test("keeps rows on refresh, resets identity, and ignores stale responses", async () => {
    activePage = page("page-one", "books");
    const fetch = installHeldFetch();
    try {
      const { LayoutBlock, RecordList, first } = await recordListTypes();
      let currentKey = first.key;
      renderRecordList(RecordList, first.props);
      flushEffects();
      await settle(fetch.calls[0], []);
      expect(renderRecordList(RecordList, first.props)).toContain("no records yet");

      const loaded = LayoutBlock({ block: activePage.layout.blocks[0], pageId: activePage.id, credential: "secret", refreshKey: "0:1" });
      renderRecordList(RecordList, loaded.props);
      flushEffects();
      await settle(fetch.calls[1], [{ record_id: "book-1", title: "The Dispossessed" }]);
      expect(renderRecordList(RecordList, loaded.props)).toContain("The Dispossessed");

      const refreshing = LayoutBlock({ block: activePage.layout.blocks[0], pageId: activePage.id, credential: "secret", refreshKey: "0:2" });
      const refreshMarkup = renderRecordList(RecordList, refreshing.props);
      flushEffects();
      expect(refreshMarkup).toContain("The Dispossessed");
      expect(refreshMarkup).not.toContain("loading records…");

      activePage = page("page-two", "books");
      const switched = LayoutBlock({ block: activePage.layout.blocks[0], pageId: activePage.id, credential: "secret", refreshKey: "0:2" });
      if (switched.key !== currentKey) {
        resetHooks();
        currentKey = switched.key;
      }
      const switchedMarkup = renderRecordList(RecordList, switched.props);
      expect(switchedMarkup).toContain("loading records…");
      expect(switchedMarkup).not.toContain("The Dispossessed");
      flushEffects();

      const newer = LayoutBlock({ block: activePage.layout.blocks[0], pageId: activePage.id, credential: "secret", refreshKey: "0:3" });
      renderRecordList(RecordList, newer.props);
      flushEffects();
      await settle(fetch.calls[4], [{ record_id: "book-2", title: "A Wizard of Earthsea" }]);
      await settle(fetch.calls[3], [{ record_id: "stale", title: "Old row" }]);
      const newestMarkup = renderRecordList(RecordList, newer.props);
      expect(newestMarkup).toContain("A Wizard of Earthsea");
      expect(newestMarkup).not.toContain("Old row");
      await settle(fetch.calls[2], []);
    } finally {
      fetch.restore();
    }
  });
});
