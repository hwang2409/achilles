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
// the chat transcript's sub-agent row says "done"; use the same word in agent views
export const stateWord = (status: string) => status === "completed" ? "done" : status;
export const isTerminal = (state: unknown): state is typeof terminal[number] => terminal.some((value) => value === state);
// the chat transcript's live sub-agent row for a run (fulcrum's sub_agent item). zeta's run report can lag it, so a
// running report takes the running row's newer step and tool count; finished runs keep the report
export function withLiveRow(row: AgentRun, live: { status: string; latestActivity?: string; toolCount?: number } | undefined): AgentRun {
  if (!live || ["done", "error", "canceled"].includes(live.status) || isTerminal(row.status)) return row;
  return { ...row, currentStep: live.latestActivity ?? row.currentStep, toolCount: live.toolCount === undefined ? row.toolCount : Math.max(row.toolCount ?? 0, live.toolCount) };
}

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
function reviewedIdentity(intent: Intent, root: string): string {
  if (intent.kind === "spawn") {
    const { parent, profile, task } = intent;
    return JSON.stringify([intent.kind, root, parent.cwd, profile.name, profile.description, profile.tools, task]);
  }
  const { parentRunId, agentType, description, runId } = intent.row;
  return JSON.stringify([intent.kind, root, parentRunId, agentType, description, runId]);
}
type Outcome = Result<{ status: "committed"; receipt: ReviewText }>;
const unknown: Outcome = { status: "unknown" };
const fail = (reason: "changed" | "denied" | "not-applied" | "refused", message?: ReviewText, final?: true): Outcome =>
  ({ status: "failed", reason, message, final });
const committed = (receipt: ReviewText): Outcome => ({ status: "committed", receipt });
const spawned = (intent: Extract<Intent, { kind: "spawn" }>) => committed(displayControl(`spawned ${intent.profile.name}: ${intent.task}`, 420));
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

function parseReply(intent: Intent, reply: unknown): Outcome {
  const data = object(reply) ? reply.data : null;
  if (!object(data) || data.accepted !== true || !text(data.run_id)) return unknown;
  if (intent.kind === "spawn") return spawned(intent);
  if (data.run_id !== intent.row.runId) return unknown;
  if (data.state === "cancelling") return committed(reviewText("cancellation requested."));
  return isTerminal(data.state) ? committed(displayControl(`this run was already ${stateWord(data.state)}.`)) : unknown;
}

/** Owns unresolved attempts across view and socket replacement. Checks are read-only. */
export function createChildControls(connection: Pick<Connection, "client" | "withControl">, advertised = supportsRequest) {
  type Attempt = { readonly identity: string; run: Promise<Outcome>; check: () => Promise<Outcome>; checking?: Promise<Outcome> };
  const attempts = new Map<string, Attempt>();
  return {
    operation(intent: Intent, refresh: () => void) {
      const root = intent.kind === "spawn" ? intent.parent.id : intent.row.sessionId;
      const key = intent.kind === "spawn" ? rowKey(root, "") : rowKey(root, intent.row.runId);
      const identity = reviewedIdentity(intent, root);
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
          return isTerminal(state) ? committed(displayControl(`zeta reports this run is ${stateWord(state)}.`)) : unknown;
        }
        const matches = rows.filter((row) => before && !before.has(row.runId) && row.parentRunId === null &&
          row.agentType === intent.profile.name && row.description === intent.task);
        return matches.length === 1 ? spawned(intent) : unknown;
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
            return parseReply(intent, await client.request(method, params, { signal, timeoutMs: 10_000 }));
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
          if (existing) {
            if (existing.identity !== identity) return Promise.resolve(fail("not-applied", intent.kind === "spawn"
              ? reviewText("not sent. the result of an earlier spawn is still pending or unknown. check it in its original review before trying again.")
              : reviewText("not sent. the result of an earlier cancel is still pending or unknown. check it in its original review before trying again.")));
            current = existing;
            return existing.run;
          }
          const entry: Attempt = { identity, check, run: send().then((result) => {
            if (result.status !== "unknown") attempts.delete(key);
            return result;
          }) };
          attempts.set(key, entry);
          current = entry;
          return entry.run;
        },
        checkResult() {
          const entry = current ?? attempts.get(key);
          if (!entry || entry.identity !== identity || attempts.get(key) !== entry) return Promise.resolve(unknown);
          return entry.checking ??= entry.run.then((result) => result.status === "unknown" ? entry.check() : result)
            .catch(() => unknown).then((result) => {
              entry.checking = undefined;
              if (result.status !== "unknown" && attempts.get(key) === entry) attempts.delete(key);
              return result;
            });
        },
      };
    },
  };
}
export type ChildControls = ReturnType<typeof createChildControls>;
