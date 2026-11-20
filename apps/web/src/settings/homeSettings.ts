import type { ZetaClient } from "@fulcrum/zeta";
import { reviewText, type Result, type ReviewText } from "../surface/Confirmation";
import { supportsRequest, TAKEOVER_FAILED } from "../zeta";

// The only module that sends `home_settings_get` and `home_settings_update` (zeta `home_settings_v1`) and maps their
// errors. Every result is outside input: keep only the allowlisted fields; anything else is unreadable.

export const HOME_SETTINGS_FEATURE = "home_settings_v1";

/** `on`/`off`: the built-in endpoint or none. `custom`/`unknown`: zeta does not change it (or sent a value this page
 * does not know). Only `on` and `off` can be `editable`. */
export type TelemetryState = "on" | "off" | "custom" | "unknown";
export type HomeSettings = { revision: string; telemetry: TelemetryState; editable: boolean; malformed: boolean };
/** What must restart to use a change. `null`: zeta did not report it (the result was settled by a reread). */
export type Restart = { sessions: string[]; complete: boolean } | null;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const REVISION = /^sha256:[0-9a-f]{64}$/;

function telemetry(value: unknown): { state: TelemetryState; editable: boolean } | null {
  if (!record(value) || typeof value.editable !== "boolean" || typeof value.source !== "string") return null;
  if (value.source === "unknown") return exactly(value, ["source", "editable"]) ? { state: "unknown", editable: false } : null;
  if (!exactly(value, ["enabled", "source", "editable"]) || typeof value.enabled !== "boolean") return null;
  const state = value.source === "builtin" && value.enabled ? "on" : value.source === "off" && !value.enabled ? "off"
    : value.source === "custom" ? "custom" : "unknown";
  return { state, editable: value.editable && (state === "on" || state === "off") };
}

function settings(revision: unknown, value: unknown, malformed: boolean): HomeSettings | null {
  if (typeof revision !== "string" || !REVISION.test(revision) || !record(value) || !exactly(value, ["telemetry"])) return null;
  const parsed = telemetry(value.telemetry);
  return parsed && { revision, telemetry: parsed.state, editable: parsed.editable, malformed };
}

export function parseGet(result: unknown): HomeSettings | null {
  if (!record(result) || !exactly(result, ["revision", "settings", "settings_malformed"]) || typeof result.settings_malformed !== "boolean") return null;
  return settings(result.revision, result.settings, result.settings_malformed);
}

export function parseUpdate(result: unknown): { settings: HomeSettings; restart: Restart } | null {
  if (!record(result) || !exactly(result, ["revision", "settings", "restart"])) return null;
  const parsed = settings(result.revision, result.settings, false);
  const restart = result.restart;
  if (!parsed || !record(restart) || !exactly(restart, ["serve", "sessions", "complete"]) || restart.serve !== true ||
      typeof restart.complete !== "boolean" || !Array.isArray(restart.sessions) || !restart.sessions.every((id) => typeof id === "string")) return null;
  return { settings: parsed, restart: { sessions: restart.sessions as string[], complete: restart.complete } };
}

export async function readHomeSettings(client: ZetaClient): Promise<HomeSettings> {
  const parsed = parseGet(await client.request("home_settings_get", {}));
  if (!parsed) throw new Error("unreadable home settings");
  return parsed;
}

/** One line of plain text from zeta, at most 300 characters. */
export const plain = (value: string): ReviewText =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) as ReviewText;

type RpcError = { code?: unknown; message?: unknown; data?: unknown } | null;
type Failed = Extract<Result<never>, { status: "failed" }>;
const failed = (reason: Failed["reason"], message?: ReviewText): Failed => ({ status: "failed", reason, ...message ? { message } : {} });

export const NOT_ALLOWED = reviewText("not changed. this zeta does not allow changing settings here.");
export const CUSTOM = reviewText("not changed. telemetry uses a custom endpoint from settings.toml. change it there.");
export const MALFORMED = reviewText("not changed. settings.toml has an error. zeta will not start until it is fixed.");
export const UNSAFE = reviewText("not changed. settings.toml is a link or a shared file. zeta does not change it.");

/** The update's error, mapped. `reread`: the row must read the file again. null: unknown, a read must settle it. */
export function mapUpdateError(error: unknown): { result: Failed; reread: boolean } | null {
  const rpc = error as RpcError;
  const data = record(rpc?.data) ? rpc.data : {};
  const message = typeof rpc?.message === "string" ? rpc.message : "";
  switch (rpc?.code) {
    case -32602: {
      // the field that names this refusal is not fixed yet in zeta: accept `reason` or `code`
      if (data.reason === "telemetry_unavailable" || data.code === "telemetry_unavailable") {
        const reason = [data.message, data.detail, message].find((text): text is string => typeof text === "string" && text.trim() !== "") ?? "";
        return { result: failed("not-applied", plain(`not changed. zeta cannot record telemetry on this computer: ${reason}`)), reread: false };
      }
      if (data.code === "custom_home_setting") return { result: failed("not-applied", CUSTOM), reread: true };
      return { result: failed("not-applied", plain(`not changed. zeta refused this change: ${message}`)), reread: false };
    }
    case -32009:
      if (data.code === "stale_revision") return { result: failed("changed"), reread: true };
      if (data.code === "settings_busy") return { result: failed("not-applied"), reread: false };
      return null;
    case -32000:
      if (data.code === "settings_malformed") return { result: failed("not-applied", MALFORMED), reread: true };
      if (data.code === "settings_unsafe") return { result: failed("not-applied", UNSAFE), reread: true };
      return null;
    case -32008: return { result: failed("refused"), reread: false };
    case -32601: return { result: failed("not-applied", NOT_ALLOWED), reread: false };
    default: return null;
  }
}

export const receipt = (enabled: boolean) => enabled
  ? reviewText("telemetry is on. restart zeta to start recording.")
  : reviewText("telemetry is off. restart zeta to stop recording.");
type Committed = { status: "committed"; receipt: ReviewText; value: ReviewText };
type WithControl = <T>(read: (client: ZetaClient) => Promise<T>) => Promise<{ value: T } | { refused: string }>;

/** One attempt to set `telemetry.enabled`, for `Confirmation`. `execute` sends at most one update, inside one borrow of
 * control; `checkResult` reads once on the live client and never sends the update again.
 * `committed`: the row's new state. `reread`: the row must read the file again. */
export function telemetryChange({ before, enabled, withControl, live, committed, reread, allowed = (client) => supportsRequest(client, "home_settings_update") }: {
  before: HomeSettings;
  enabled: boolean;
  withControl: WithControl;
  live: () => ZetaClient | null;
  committed: (settings: HomeSettings, restart: Restart) => void;
  reread: () => void;
  /** Whether the controller's hello lists the update (tests replace it: only a real hello records the list). */
  allowed?: (client: ZetaClient) => boolean;
}) {
  const done = (): Committed => ({ status: "committed", receipt: receipt(enabled), value: enabled ? reviewText("on") : reviewText("off") });
  return {
    async execute(): Promise<Result<Committed>> {
      let borrowed;
      try {
        borrowed = await withControl(async (client) => {
          // an observer hello never lists write methods: check the controller's after take control
          if (!allowed(client)) return null;
          return await client.request("home_settings_update", { expected_revision: before.revision, changes: [{ key: "telemetry.enabled", value: enabled }] });
        });
      } catch (error) {
        const mapped = mapUpdateError(error);
        if (!mapped) return { status: "unknown" };
        if (mapped.reread) reread();
        return mapped.result;
      }
      if ("refused" in borrowed) return failed(borrowed.refused === TAKEOVER_FAILED ? "not-applied" : "refused");
      if (borrowed.value === null) return failed("not-applied", NOT_ALLOWED);
      const parsed = parseUpdate(borrowed.value);
      if (!parsed) return { status: "unknown" };
      committed(parsed.settings, parsed.restart);
      return done();
    },
    async checkResult(): Promise<Result<Committed>> {
      const client = live();
      if (!client) return { status: "unknown" };
      let now: HomeSettings;
      try { now = await readHomeSettings(client); } catch { return { status: "unknown" }; }
      if (now.revision === before.revision) return failed("not-applied");
      if (now.telemetry === (enabled ? "on" : "off")) {
        committed(now, null);
        return done();
      }
      reread();
      return failed("changed");
    },
  };
}
