import type { ZetaClient } from "@fulcrum/zeta";
import { reviewText, type Result, type ReviewText } from "../surface/Confirmation";
import { supportsFeature, supportsRequest, type Connection } from "../zeta/connection";
import { rpcCode } from "../zeta/historyRead";
import { readControlRoot, rowKey, type AgentRun } from "./reads";

export const controlFeature = "child_run_control_v1";
export const newerControls = reviewText("this action needs a newer zeta.");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
export const displayControl = (value: string, limit = 300): ReviewText =>
  value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit) as ReviewText;
export const runDisplayId = (profile: string | undefined, id: string) =>
  displayControl(`${displayControl(profile || "agent", 100)} · ${id.slice(-8)}`);
const terminal = ["completed", "failed", "canceled"] as const;
export const isTerminal = (state: unknown): state is typeof terminal[number] => terminal.some((value) => value === state);

type Profile = { name: string; description: string; tools: string[] | null };
export type ControlParent = { id: string; cwd: string; profiles: Profile[]; idle: boolean };
export async function readControlParent(client: ZetaClient, signal: AbortSignal): Promise<ControlParent | null> {
  const result: unknown = await client.request("status", {}, { signal, timeoutMs: 5000 });
  const session = object(result) ? result.session : null;
  if (!object(session) || !text(session.session_id) || !text(session.cwd)) return null;
  const profiles = new Map<string, Profile>();
  if (Array.isArray(session.agent_catalog)) for (const raw of session.agent_catalog) {
    if (!object(raw) || !text(raw.name) || typeof raw.description !== "string") continue;
    const tools = Array.isArray(raw.tools) && raw.tools.every(text) ? raw.tools as string[] : null;
    profiles.set(raw.name, { name: raw.name, description: raw.description, tools });
  }
  return { id: session.session_id, cwd: session.cwd, profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)), idle: object(result) && result.state === "idle" };
}

type Intent = { kind: "spawn"; parent: ControlParent; profile: Profile; task: string }
  | { kind: "cancel"; row: AgentRun };
type Outcome = Result<{ status: "committed"; receipt: ReviewText }>;
const unknown: Outcome = { status: "unknown" };
const fail = (reason: "changed" | "denied" | "not-applied" | "refused", message?: ReviewText, final?: true): Outcome =>
  ({ status: "failed", reason, message, final });
const committed = (receipt: ReviewText): Outcome => ({ status: "committed", receipt });
const spawned = (profile: string, id: string) => committed(displayControl(`spawned ${profile} as ${runDisplayId(profile, id)}`, 420));
const parentChanged = () => fail("changed", reviewText("the active parent or reviewed scope changed. reopen the review."), true);
const busy = () => fail("not-applied", reviewText("zeta is busy. wait for the parent to be idle, then try again."));
function refusal(code: unknown) {
  switch (code) {
    case -32601: return fail("not-applied", newerControls, true);
    case -32602: return fail("not-applied", reviewText("zeta rejected the reviewed details. check the profile and task."), true);
    case -32003: return parentChanged();
    case -32004: return busy();
    case -32005: return fail("not-applied", reviewText("child state is unavailable. refresh before trying again."), true);
    case -32008: return fail("denied");
    case -32012: return fail("changed", reviewText("zeta no longer has this child run. the catalog has been refreshed."), true);
    default: return unknown;
  }
}

/** Owns unresolved attempts across view and socket replacement. Checks are read-only. */
export function createChildControls(connection: Pick<Connection, "client" | "withControl">, advertised = supportsRequest) {
  type Attempt = { run: Promise<Outcome>; check: () => Promise<Outcome>; checking?: Promise<Outcome> };
  const attempts = new Map<string, Attempt>();
  return {
    operation(intent: Intent, refresh: () => void) {
      const root = intent.kind === "spawn" ? intent.parent.id : intent.row.sessionId;
      const key = intent.kind === "spawn" ? rowKey(root, "") : rowKey(root, intent.row.runId);
      const method = intent.kind === "spawn" ? "child_run_spawn" : "child_run_cancel";
      let before: Set<string> | undefined;
      let current: Attempt | undefined;
      const check = async (): Promise<Outcome> => {
        const client = connection.client;
        if (!client) return unknown;
        const rows = await readControlRoot(client, root, AbortSignal.timeout(8000));
        refresh();
        if (intent.kind === "cancel") {
          const state = rows.find((row) => row.runId === intent.row.runId)?.status;
          return isTerminal(state) ? committed(displayControl(`zeta reports this run is ${state}.`)) : unknown;
        }
        const matches = rows.filter((row) => before && !before.has(row.runId) && row.parentRunId === null &&
          row.agentType === intent.profile.name && row.description === intent.task);
        return matches.length === 1 ? spawned(intent.profile.name, matches[0].runId) : unknown;
      };
      const send = async (): Promise<Outcome> => {
        const observer = connection.client;
        if (!observer || !supportsFeature(observer, controlFeature)) return fail("not-applied", newerControls);
        let dispatched = false;
        try {
          const result = await connection.withControl(async (client): Promise<Outcome> => {
            if (!supportsFeature(client, controlFeature) || !advertised(client, method)) return fail("not-applied", newerControls, true);
            const signal = AbortSignal.timeout(16_000);
            if (intent.kind === "spawn") {
              const parent = await readControlParent(client, signal);
              const profile = parent?.profiles.find((entry) => entry.name === intent.profile.name);
              if (!parent || parent.id !== root || parent.cwd !== intent.parent.cwd || !profile ||
                JSON.stringify(profile) !== JSON.stringify(intent.profile)) return parentChanged();
              if (!parent.idle) return busy();
              before = new Set((await readControlRoot(client, root, signal)).map((row) => row.runId));
            }
            signal.throwIfAborted();
            const params = intent.kind === "spawn" ? { session_id: root, agent_type: intent.profile.name, task: intent.task, background: true }
              : { session_id: root, run_id: intent.row.runId, reason: "user_cancelled" };
            dispatched = true;
            const reply: unknown = await client.request(method, params, { signal, timeoutMs: 10_000 });
            const data = object(reply) ? reply.data : null;
            if (!object(data) || data.accepted !== true || !text(data.run_id)) return unknown;
            if (intent.kind === "spawn") return spawned(intent.profile.name, data.run_id);
            if (data.run_id !== intent.row.runId) return unknown;
            if (data.state === "cancelling") return committed(reviewText("cancellation requested."));
            return isTerminal(data.state) ? committed(displayControl(`this run was already ${data.state}.`)) : unknown;
          });
          if ("refused" in result) return fail("refused", displayControl(result.refused));
          if (result.value.status === "committed") refresh();
          return result.value;
        } catch (error) {
          const code = rpcCode(error);
          if (code === -32012) refresh();
          return dispatched ? refusal(code) : fail("not-applied", reviewText("could not verify the active scope. refresh before trying again."));
        }
      };
      return {
        execute() {
          const existing = attempts.get(key);
          if (existing) { current = existing; return existing.run; }
          const entry: Attempt = { check, run: send().then((result) => {
            if (result.status !== "unknown") attempts.delete(key);
            return result;
          }) };
          attempts.set(key, entry);
          current = entry;
          return entry.run;
        },
        checkResult() {
          const entry = current ?? attempts.get(key);
          if (!entry || attempts.get(key) !== entry) return Promise.resolve(unknown);
          return entry.checking ??= entry.run.then((result) => result.status === "unknown" ? entry.check() : result)
            .catch(() => unknown).then((result) => {
              entry.checking = undefined;
              if (result.status !== "unknown") attempts.delete(key);
              return result;
            });
        },
      };
    },
  };
}
export type ChildControls = ReturnType<typeof createChildControls>;
