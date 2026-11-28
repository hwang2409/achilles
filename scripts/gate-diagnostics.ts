import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Page } from "../apps/web/node_modules/playwright";

const SECRET_KEYS = /token|authorization|headers|mcp_bindings|credential|secret|password/i;
export const appShortcut = (key: string) => `ControlOrMeta+${key}`;

export type DesktopPageChatProof = {
  mobileQuery: boolean;
  barVisible: boolean;
  docked: boolean;
  surfaceVisible: boolean;
  surfaceRole?: string | null;
  surfaceAriaModal?: string | null;
  evidenceVisible: boolean;
  evidenceHit: boolean;
  evidenceInsideSurface: boolean;
};

export function desktopPageChatProof(state: DesktopPageChatProof): boolean {
  return !state.mobileQuery && !state.barVisible && state.docked && state.surfaceVisible && !state.surfaceRole && !state.surfaceAriaModal && state.evidenceVisible && state.evidenceHit && state.evidenceInsideSurface;
}

// the python server polls control.json while it holds zeta's turn: a reader must never see a partial file
export async function writeControl(path: string, document: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(document), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

type FrameSummary = { direction: "received" | "sent"; method?: string; event?: string; delivery_id?: string; status?: string; error_code?: number | string; count?: number };

type AsyncMethod = (...args: never[]) => Promise<unknown>;

export type GateWait = {
  <T>(operation: () => Promise<T>): Promise<T>;
  playwright<T extends object, K extends keyof T>(
    owner: T,
    method: K,
    ...args: T[K] extends (...args: infer A) => Promise<unknown> ? A : never
  ): T[K] extends (...args: never[]) => Promise<infer R> ? Promise<R> : never;
};

export function createGateWait(
  frames: () => readonly FrameSummary[],
  control: () => Promise<string>,
): GateWait {
  const wait = async <T>(operation: () => Promise<T>) => {
    try {
      return await operation();
    } catch (error) {
      throw new Error(`${error}; websocket frames=${JSON.stringify(frames())}; backend catalog=${await control()}`);
    }
  };
  return Object.assign(wait, {
    playwright: (owner: object, method: PropertyKey, ...args: never[]) =>
      wait(() => (owner[method as keyof typeof owner] as AsyncMethod).apply(owner, args)),
  }) as GateWait;
}

export function createFrameRing(limit = 20) {
  const frames: FrameSummary[] = [];
  const pending = new Map<string, { delivery_id?: string; method?: string }>();
  return {
    record(socket: number, direction: FrameSummary["direction"], payload: string) {
      try {
        const frame = JSON.parse(payload) as { error?: { code?: number | string }; id?: number | string; method?: string; params?: { delivery_id?: string; event?: string }; result?: { status?: string } };
        const key = frame.id === undefined ? undefined : `${socket}:${frame.id}`;
        const request = key === undefined ? undefined : pending.get(key);
        const summary = Object.fromEntries(Object.entries({
          direction,
          method: frame.method ?? request?.method,
          event: frame.method === "event" ? frame.params?.event : undefined,
          delivery_id: frame.params?.delivery_id ?? request?.delivery_id,
          status: frame.result?.status,
          error_code: frame.error?.code,
        }).filter(([, value]) => value !== undefined)) as FrameSummary;
        if (direction === "sent" && key !== undefined && frame.method)
          pending.set(key, { method: frame.method, delivery_id: frame.params?.delivery_id });
        if (!(direction === "sent" && frame.method === "delivery_status")) {
          const previous = frames.at(-1);
          const same = previous && JSON.stringify({ ...previous, count: undefined }) === JSON.stringify(summary);
          if (same) previous.count = (previous.count ?? 1) + 1;
          else frames.push(summary);
          if (frames.length > limit) frames.shift();
        }
        if (direction === "received" && key !== undefined) pending.delete(key);
      } catch { /* non-JSON frames have no safe diagnostic fields */ }
    },
    snapshot: () => frames,
  };
}

const scrub = (value: unknown, secrets: readonly string[]): unknown => {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
    return text.replace(/bearer\s+[^\s,}\"]+/gi, "Bearer [redacted]");
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.test(key) ? "[redacted]" : scrub(item, secrets),
      ]),
    );
  }
  return value;
};

export const diagnostic = (value: unknown, secrets: readonly string[] = []): string =>
  typeof value === "string"
    ? String(scrub(value, secrets))
    : JSON.stringify(scrub(value, secrets));

export const controlSnapshot = (text: string, secrets: readonly string[] = []): string => {
  try {
    const value = JSON.parse(text);
    const allowed = Object.fromEntries(
      ["request_count", "last_message", "schemas", "returned_tool_calls", "pid", "turn_start_barrier", "release_turn_start_barrier", "turn_barrier", "release_turn_barrier", "inspect_turn_barrier"].flatMap(
        (key) => (key in value ? [[key, value[key]]] : []),
      ),
    );
    return diagnostic(allowed, secrets);
  } catch {
    return diagnostic(text, secrets);
  }
};

// covers `"token": "x"`, escaped `\"token\":\"x\"`, `'Authorization': 'Basic x'`, `x-api-key: x`, and `credential=x` in log lines that are not JSON.
// a quoted value keeps its quotes, and an unquoted value stops at a quote, so a redacted JSON line stays valid.
// a key starts only at the start of a `[\w-]` run, and its parts are bounded to 64 characters, so a long run cannot backtrack for minutes.
// shortcut: a key with more than 64 characters on one side of the keyword is not matched; widen the bound if such a key appears.
const FIELD_KEY = String.raw`(?<![\w-])[\w-]{0,64}(?:token|authorization|credential|mcp_bindings|cookie|api[_-]?key|secret|password)[\w-]{0,64}`;
const SECRET_FIELD = new RegExp(String.raw`((?:\\*["'])?${FIELD_KEY}(?:\\*["'])?\s*[:=]\s*)(?:(\\*["'])(?:(?!\2).)*?\2|(?:basic|bearer|digest)\s+[^\s,}&"'\\]+|[^\s,}&"'\\]+)`, "gi");
// a python header tuple `(b'x-api-key', b'x')`.
const HEADER_TUPLE = new RegExp(String.raw`(\(\s*b?(["'])${FIELD_KEY}\2\s*,\s*b?)(["'])(?:(?!\3).)*?\3`, "gi");
// a `Cookie:` or `set-cookie:` header value runs to the end of the line, across `;`.
const COOKIE_HEADER = /(\bcookie\s*:\s*)[^\r\n"'\\]+/gi;
const BEARER_PROTOCOL = /zeta\.bearer\.[^\s"'\\,]+/gi;

// one log line or websocket payload, made safe for a public CI artifact.
export const redactArtifact = (line: string, secrets: readonly string[] = [], home = homedir()): string => {
  let text: string;
  try {
    const value = JSON.parse(line);
    text = value && typeof value === "object" ? diagnostic(value, secrets) : diagnostic(line, secrets);
  } catch {
    text = diagnostic(line, secrets);
  }
  text = text
    .replace(COOKIE_HEADER, "$1[redacted]")
    .replace(BEARER_PROTOCOL, "zeta.bearer.[redacted]")
    .replace(HEADER_TUPLE, "$1$3[redacted]$3")
    .replace(SECRET_FIELD, (match: string, key: string, quote?: string) =>
      match.slice(key.length).includes("[redacted]") ? match : quote ? `${key}${quote}[redacted]${quote}` : `${key}[redacted]`);
  return home.length > 1 ? text.split(home).join("~") : text;
};

/** the one localStorage dump in the gate scripts; compare two dumps only with storageDiff, never as strings (chromium lists keys in hash order) */
export const storageSnapshot = (page: Page): Promise<string> =>
  page.evaluate(() => JSON.stringify({ ...localStorage }));

/** key-level diff of two storageSnapshot dumps, for every gate storage compare; "" when both hold the same keys and values, in any order */
export function storageDiff(before: string, after: string, limit = 200): string {
  const [a, b] = [before, after].map((dump) => JSON.parse(dump) as Record<string, string>);
  const cut = (value: string) => value.length > limit ? `${value.slice(0, limit)}...` : value;
  const lines = [
    ...Object.keys(a).filter((key) => !(key in b)).map((key) => `only before: ${key}=${cut(a[key])}`),
    ...Object.keys(b).filter((key) => !(key in a)).map((key) => `only after: ${key}=${cut(b[key])}`),
    ...Object.keys(a).filter((key) => key in b && a[key] !== b[key]).map((key) => `changed: ${key}: ${cut(a[key])} -> ${cut(b[key])}`),
  ];
  return lines.join("\n");
}
