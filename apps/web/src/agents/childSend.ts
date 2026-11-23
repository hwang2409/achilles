import { sendChildRun, ZetaError, type ChildRunKey, type ZetaClient } from "@fulcrum/zeta";
import { createWriteForms } from "../writeForms";
import { supportsRequest, type Connection } from "../zeta/connection";
import { rpcCode } from "../zeta/historyRead";
import { rowKey } from "./reads";

type Outcome = { message: string; accepted?: true; refreshAfter?: number };
type Draft = { text: string; pending?: boolean; outcome?: Outcome };
const empty: Draft = { text: "" };
const unknown = { message: "delivery is unknown; check the child transcript before sending again." };
const refused = { message: "zeta did not accept the message." };
const sendMethod = "child_run_send";

const send = (client: ZetaClient, key: ChildRunKey, text: string, signal: AbortSignal) => {
  if (!supportsRequest(client, sendMethod)) return Promise.resolve({ kind: "unavailable", feature: "child_runs" } as const);
  return sendChildRun(client, key, text, { signal, timeoutMs: 12_000 });
};

// Forms belong to the route, not the socket or the mounted editor.
export function createChildSendOwner({ withControl }: Pick<Connection, "withControl">, request = send) {
  const forms = createWriteForms<Outcome, string>({ inProgress: { message: "a send is already in progress." }, unexpected: unknown });
  const entries = new Map<string, { form: string; draft: Draft }>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: (id: string) => entries.get(id)?.draft ?? empty,
    edit(id: string, text: string) {
      let entry = entries.get(id);
      if (!entry) {
        const target = { form: forms.open(), draft: empty };
        forms.attach(target.form, (outcome, sent) => {
          target.draft = { text: outcome.accepted && target.draft.text === sent ? "" : target.draft.text, outcome };
          notify();
        });
        entries.set(id, target);
        entry = target;
      }
      entry.draft = { ...entry.draft, text };
      notify();
    },
    send(key: ChildRunKey, reportedAt: number) {
      const id = rowKey(key.sessionId, key.runId);
      const entry = entries.get(id);
      const text = entry?.draft.text;
      if (!text?.trim() || !entry || entry.draft.pending || (entry.draft.outcome?.refreshAfter ?? -Infinity) >= reportedAt) return;
      entry.draft = { text, pending: true };
      notify();
      return forms.run(entry.form, id, text, text, async (signal) => {
        let dispatched = false;
        try {
          const response = await withControl(async (client): Promise<Outcome> => {
            dispatched = true;
            const reply = await request(client, key, text, signal);
            if (reply.kind === "unavailable") return { message: "this zeta does not support sending to children." };
            return reply.kind === "accepted" && reply.runId === key.runId ? { accepted: true, message: "message accepted by zeta." } : unknown;
          });
          return "refused" in response ? { message: response.refused } : response.value;
        } catch (error) {
          const code = error instanceof ZetaError ? undefined : rpcCode(error);
          if (code === -32005 || code === -32003) return { message: "the child is no longer available for follow-up. refresh the run before trying again.", refreshAfter: Date.now() };
          return !dispatched || typeof code === "number" ? refused : unknown;
        }
      });
    },
  };
}

export type ChildSendOwner = ReturnType<typeof createChildSendOwner>;
