import type { ZetaClient } from "@fulcrum/zeta";
import { supportsFeature, supportsRequest } from "../zeta/connection";
import { libraryMethods, type LibraryKind } from "./catalog";

/**
 * The only module that sends library writes and maps their errors. Components never call `client.request` for a write.
 * Wire truth: zeta 34f0477b7 `library_write_v1` (`skill_write`, `agent_profile_write`).
 */
export const WRITE_FEATURE = "library_write_v1";
/** Shown after a save that zeta flagged `redacted: true`. zeta stores the document as written. */
export const REDACTED_NOTICE = "this file contains text that looks like a secret; zeta stored it as written; reads show it masked";
/** zeta's redaction mask (src/zeta/memory/safety.py REDACTED_SECRET); saving it would replace a secret with the mask. */
export const REDACTION_MARKER = "[secret omitted]";
/** `where`: the saved file, when the notice is not already next to the item. */
export const savedNotice = (name: string, where?: string) =>
  `saved ${name}${where ? ` to ${where}` : ""}. running sessions pick up the change at their next catalog refresh.`;
const MAX_DOCUMENT_BYTES = 128 * 1024;
const BUSY_BACKOFF_MS = [500, 1_000, 2_000];
const RECONNECT_WAIT_MS = [500, 1_000, 2_000, 4_000];
const DETAIL_CHARS = 500;

export type WriteScope = "home" | "project";
export type WriteTarget = { kind: LibraryKind; name: string; scope: WriteScope };
export type WriteOutcome =
  | { status: "saved"; revision: string; redacted: boolean }
  | { status: "stale" | "busy" | "observer" | "invalid" | "unavailable" | "unknown"; message: string };
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type LibraryWriter = ReturnType<typeof createLibraryWriter>;

/** `none`: no write control (no `library_write_v1`). zeta lists methods per role, so an observer hello never names a
 * write: an observer shows the control on the feature alone, and a controller also needs this kind's write method. */
export const writeAccess = (client: ZetaClient, kind: LibraryKind, controller: boolean): "none" | "allowed" | "refused" =>
  !supportsFeature(client, WRITE_FEATURE) ? "none" : !controller || supportsRequest(client, libraryMethods(kind).write) ? "allowed" : "refused";
/** Shown when take control succeeded but this zeta does not list the write method. */
export const REFUSED_NOTICE = "this zeta does not allow saving here";

/** zeta's name rule (library.py `valid_name`) as copy; null when the name is usable. */
export function nameProblem(name: string): string | null {
  if (!name) return "enter a name";
  if (/\s/.test(name) || /[/\\\0]/.test(name) || name === "." || name === "..") return "one word: no spaces, no / or \\, not . or ..";
  return null;
}

/** Checks zeta would refuse anyway, shown before save. */
export function createProblems(name: string, document: string): string[] {
  const problems = [nameProblem(name)];
  if (!document.trim()) problems.push("the file is empty");
  if (new TextEncoder().encode(document).length > MAX_DOCUMENT_BYTES) problems.push("the file is over 128 KiB");
  if (document.includes(REDACTION_MARKER)) problems.push(markerMessage);
  return problems.filter((problem): problem is string => problem !== null);
}

const markerMessage = `the text contains zeta's mask ${REDACTION_MARKER}. remove it or replace it with the real text before saving.`;
const noun = (kind: LibraryKind) => kind === "skills" ? "skill" : "profile";

async function sha256(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const defaultSleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

type RpcError = { code?: unknown; data?: { reason?: unknown; detail?: unknown } } | null;

/** Error codes with a definite meaning. null: the result is unknown and a read must settle it. */
function mapError(error: unknown, target: WriteTarget, edit: boolean): WriteOutcome | null {
  const rpc = error as RpcError;
  switch (rpc?.code) {
    case -32009: return { status: "stale", message: edit ? "this file changed after you opened it. your text is kept." : `a ${target.scope} ${noun(target.kind)} named ${target.name} already exists.` };
    case -32004: return { status: "busy", message: "another zeta writer is using the library. nothing was saved; try again in a moment." };
    case -32008: return { status: "observer", message: "this tab is read-only. take control to save. your text is kept." };
    case -32005: return { status: "unavailable", message: "project items need an open chat in that project." };
    case -32601: return { status: "unavailable", message: "this zeta cannot save library items." };
    case -32602: return { status: "invalid", message: invalidMessage(rpc!.data?.reason, rpc!.data?.detail, target) };
    default: return null;
  }
}

function invalidMessage(reason: unknown, detail: unknown, target: WriteTarget) {
  switch (reason) {
    case "contains_redaction_marker": return markerMessage;
    case "invalid_document": return `zeta did not save it: ${typeof detail === "string" ? detail.slice(0, DETAIL_CHARS) : "the file is not valid."}`;
    case "name_mismatch": return `the name: in the header must be ${target.name}.`;
    case "document_too_large": return "the file is over 128 KiB.";
    case "name_too_long": return "this name is too long for a file name.";
    case "unsafe_path": return "this name cannot be a file name here.";
    default: return "zeta refused this name or text.";
  }
}

/** Another form's save of the same item is in flight; this one sends nothing. */
const IN_PROGRESS: WriteOutcome = { status: "busy", message: "another save of this item is in progress. nothing was sent; try again in a moment." };

// The page threw before sending (for example `crypto.subtle` is missing outside a secure context).
const NOT_SENT: WriteOutcome = { status: "unknown", message: "this page could not send the save. nothing was sent." };

/** What a form sent, delivered with its outcome, so a form that remounted applies the save it actually sent. */
export type Sent = { target: WriteTarget; document: string };
type Deliver = (outcome: WriteOutcome, sent: Sent) => void;
type Form = { abort: AbortController; deliver?: Deliver; held?: [WriteOutcome, Sent] };

/** The only owner of library writes and of "which form owns this save". It lives above the library view, so a socket
 * drop that remounts the view keeps every form and its save.
 * - `open()` gives a form its identity; `close(form)` ends it: its retries and settle reads stop, and it gets nothing.
 *   A save it sent that still lands goes to the `onLanded` listeners.
 * - a call joins an in-flight save only when form and request are identical (a double submit); any other save of that
 *   item while one is in flight is refused with IN_PROGRESS.
 * - each outcome goes once to the form that sent it, through `attach`; one that settles while the form is not mounted
 *   waits for the remounted form.
 * `live`: the connection's current client, so the read that settles an unknown result after a socket drop uses the
 * reconnected one. */
export function createLibraryWriter(sleep: Sleep = defaultSleep, live: () => ZetaClient | null = () => null) {
  const forms = new Map<string, Form>();
  const inFlight = new Map<string, { form: string; base: string | null; document: string; run: Promise<void> }>();
  const landed = new Set<(target: WriteTarget, redacted: boolean) => void>();
  let opened = 0;

  // A reply that is not a definite answer: read the item; never send the write again. Stops when the form closes.
  async function settle(client: ZetaClient, target: WriteTarget, base: string | null, expected: string, form: AbortSignal): Promise<WriteOutcome | null> {
    for (let attempt = 0; !form.aborted; attempt++) {
      try {
        const read = await (live() ?? client).request(libraryMethods(target.kind).read, { name: target.name, scope: target.scope }) as { revision?: unknown; data?: { redacted?: unknown } } | null;
        if (read?.revision === expected) return { status: "saved", revision: expected, redacted: read.data?.redacted === true };
        if (base !== null && read?.revision === base) return { status: "unknown", message: "zeta did not save it. try again." };
        return { status: "stale", message: base !== null ? "this file changed after you opened it. your text is kept."
          : `a ${target.scope} ${noun(target.kind)} named ${target.name} exists with other text.` };
      } catch (error) {
        const rpc = error as RpcError;
        if (rpc?.data?.reason === "resource_not_found") return { status: "unknown", message: "zeta did not save it. try again." };
        // no JSON-RPC error code: the socket is gone. wait for the reconnect, then read with the new client.
        const transport = !(typeof rpc?.code === "number" && rpc.code < 0);
        if (transport && attempt < RECONNECT_WAIT_MS.length) {
          try { await sleep(RECONNECT_WAIT_MS[attempt]!, form); } catch { return null; }
          continue;
        }
        return { status: "unknown", message: "could not check whether zeta saved it. refresh the list before trying again." };
      }
    }
    return null;
  }

  async function send(client: ZetaClient, target: WriteTarget, base: string | null, document: string, form: AbortSignal): Promise<WriteOutcome | null> {
    const problems = createProblems(target.name, document);
    if (problems.length) return { status: "invalid", message: problems[0]! };
    const expected = await sha256(document);
    // base null: create (zeta refuses if the name exists). Otherwise zeta replaces the file only if it still has `base`.
    const params = { name: target.name, scope: target.scope, ...(base === null ? {} : { revision: base }), mutation: { document } };
    for (let attempt = 0; !form.aborted; attempt++) {
      try {
        // the live client: a save pressed on an observer tab sends after take control replaced the socket.
        const result = await (live() ?? client).request(libraryMethods(target.kind).write, params) as { revision?: unknown; data?: { name?: unknown; redacted?: unknown } } | null;
        if (result?.revision === expected && result.data?.name === target.name && typeof result.data.redacted === "boolean")
          return { status: "saved", revision: expected, redacted: result.data.redacted };
        return settle(client, target, base, expected, form);
      } catch (error) {
        const outcome = mapError(error, target, base !== null);
        // busy: zeta refused before any change, so the same request is safe to repeat.
        if (outcome?.status === "busy" && attempt < BUSY_BACKOFF_MS.length) {
          try { await sleep(BUSY_BACKOFF_MS[attempt]!, form); continue; } catch { return null; }
        }
        return outcome ?? settle(client, target, base, expected, form);
      }
    }
    return null;
  }

  function deliver(state: Form, outcome: WriteOutcome, sent: Sent) {
    if (state.deliver) state.deliver(outcome, sent);
    else state.held = [outcome, sent];
  }

  function once(client: ZetaClient, target: WriteTarget, base: string | null, document: string, form: string): Promise<void> {
    const state = forms.get(form);
    if (!state) return Promise.resolve();
    const key = `${target.kind}/${target.scope}/${target.name}`;
    const flight = inFlight.get(key);
    if (flight?.form === form && flight.base === base && flight.document === document) return flight.run;
    if (flight) return Promise.resolve(deliver(state, IN_PROGRESS, { target, document }));
    const signal = state.abort.signal;
    const run = send(client, target, base, document, signal).catch(() => NOT_SENT).then((outcome) => {
      inFlight.delete(key);
      // a sent write cannot be recalled: one that lands after its form closed is reported once, here.
      if (signal.aborted) { if (outcome?.status === "saved") for (const listener of landed) listener(target, outcome.redacted); }
      else if (outcome) deliver(state, outcome, { target, document });
    });
    inFlight.set(key, { form, base, document, run });
    return run;
  }

  return {
    open: () => {
      const form = `form-${++opened}`;
      forms.set(form, { abort: new AbortController() });
      return form;
    },
    close: (form: string) => {
      forms.get(form)?.abort.abort();
      forms.delete(form);
    },
    /** The form's outcomes, each once. One that settled while no one listened comes at once. Returns detach. */
    attach: (form: string, listener: Deliver) => {
      const state = forms.get(form);
      if (!state) return () => {};
      state.deliver = listener;
      const held = state.held;
      state.held = undefined;
      if (held) listener(...held);
      return () => { if (state.deliver === listener) state.deliver = undefined; };
    },
    pending: (form: string) => [...inFlight.values()].some((flight) => flight.form === form),
    onLanded: (listener: (target: WriteTarget, redacted: boolean) => void) => {
      landed.add(listener);
      return () => { landed.delete(listener); };
    },
    /** Create `target` (no revision). Resolves when the save is done; the outcome goes to `attach`. */
    create: (client: ZetaClient, target: WriteTarget, document: string, form: string) => once(client, target, null, document, form),
    /** Replace `target` only if zeta still has the `base` revision the user opened; stale is never retried. */
    save: (client: ZetaClient, target: WriteTarget, base: string, document: string, form: string) => once(client, target, base, document, form),
  };
}
