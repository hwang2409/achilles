import { describe, expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { createLibraryWriter, createProblems, IN_PROGRESS, REDACTION_MARKER, type WriteOutcome, type WriteTarget } from "./libraryWrites";

const target: WriteTarget = { kind: "skills", name: "fixture-skill", scope: "home" };
const document = "---\nname: fixture-skill\ndescription: synthetic\n---\nbody\n";
const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const revision = await sha(document);
const error = (code: number, data?: object) => Object.assign(new Error("fixture"), { code, data });
const saved = (redacted = false, rev = revision) => ({ revision: rev, data: { name: target.name, scope: target.scope, redacted } });

type Reply = object | Error;
function fakeZeta(writes: Reply[], reads: Reply[] = []) {
  const calls: [string, unknown][] = [];
  const client = {
    request: async (method: string, params: unknown) => {
      calls.push([method, params]);
      const reply = (method === "skill_write" ? writes : reads).shift();
      if (!reply) throw new Error(`unexpected ${method}`);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as ZetaClient;
  return { client, calls };
}
const open = () => new AbortController().signal;
const fakeClock = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number, signal?: AbortSignal) => { if (signal?.aborted) throw new Error("aborted"); waits.push(ms); } };
};

describe("library create outcomes", () => {
  const busy = () => error(-32004, { reason: "operation_busy" });
  test.each<[string, Reply[], Reply[], string, Partial<WriteOutcome>, number, number[]]>([
    ["saved", [saved()], [], document, { status: "saved", revision, redacted: false }, 1, []],
    ["saved and redacted", [saved(true)], [], document, { status: "saved", revision, redacted: true }, 1, []],
    ["stale: the name exists", [error(-32009, { reason: "stale_library_revision" })], [], document, { status: "stale", message: "a home skill named fixture-skill already exists." }, 1, []],
    ["busy three times, then saved", [busy(), busy(), busy(), saved()], [], document, { status: "saved", revision }, 4, [500, 1_000, 2_000]],
    ["busy four times", [busy(), busy(), busy(), busy()], [], document, { status: "busy" }, 4, [500, 1_000, 2_000]],
    ["observer", [error(-32008, { reason: "observer_read_only" })], [], document, { status: "observer" }, 1, []],
    ["zeta refuses the name (-32602)", [error(-32602, { reason: "name_too_long" })], [], document, { status: "invalid", message: "this name is too long for a file name." }, 1, []],
    ["zeta refuses the redaction marker (-32602)", [error(-32602, { reason: "contains_redaction_marker" })], [], document,
      { status: "invalid", message: `the text contains zeta's mask ${REDACTION_MARKER}. remove it or replace it with the real text before saving.` }, 1, []],
    ["the marker is refused before sending", [], [], `${document}token ${REDACTION_MARKER}\n`, { status: "invalid", message: `the text contains zeta's mask ${REDACTION_MARKER}. remove it or replace it with the real text before saving.` }, 0, []],
    ["no project session (-32005)", [error(-32005)], [], document, { status: "unavailable" }, 1, []],
    ["unknown method (-32601)", [error(-32601)], [], document, { status: "unavailable" }, 1, []],
    ["unknown, a read settles it as saved", [error(-32000)], [{ revision, data: { name: target.name, redacted: false } }], document, { status: "saved", revision }, 2, []],
    ["unknown, a read finds nothing", [new Error("socket closed")], [error(-32602, { reason: "resource_not_found" })], document, { status: "unknown", message: "zeta did not save it. try again." }, 2, []],
    ["a wrong echoed revision is settled by a read", [saved(false, "0".repeat(64))], [{ revision: "f".repeat(64), data: {} }], document, { status: "stale" }, 2, []],
  ])("%s", async (_name, writes, reads, text, expected, requests, waits) => {
    const zeta = fakeZeta(writes, reads);
    const clock = fakeClock();
    const outcome = await createLibraryWriter(clock.sleep).create(zeta.client, target, text, open());
    expect(outcome).toMatchObject(expected);
    expect(zeta.calls).toHaveLength(requests);
    expect(zeta.calls.filter(([method]) => method === "skill_write").every(([, params]) =>
      JSON.stringify(params) === JSON.stringify({ name: target.name, scope: "home", mutation: { document: text } }))).toBe(true);
    expect(clock.waits).toEqual(waits);
  });
});

test.each([
  ["fixture-skill", []],
  ["", ["enter a name"]],
  ["two words", ["one word: no spaces, no / or \\, not . or .."]],
  ["a/b", ["one word: no spaces, no / or \\, not . or .."]],
  ["..", ["one word: no spaces, no / or \\, not . or .."]],
])("create checks the name %p before save", (name, problems) => {
  expect(createProblems(name, document)).toEqual(problems);
});

describe("library edit outcomes", () => {
  const opened = "a".repeat(64);
  const edited = `${document}more text\n`;
  test.each<[string, Reply[], Reply[], string, Partial<WriteOutcome>, number, number[]]>([
    ["saved", [saved(false, "")], [], edited, { status: "saved", redacted: false }, 1, []],
    ["saved and redacted", [saved(true, "")], [], edited, { status: "saved", redacted: true }, 1, []],
    ["stale: the file changed since it was opened", [error(-32009, { reason: "stale_library_revision" })], [], edited,
      { status: "stale", message: "this file changed after you opened it. your text is kept." }, 1, []],
    ["busy, then saved", [error(-32004), saved(false, "")], [], edited, { status: "saved" }, 2, [500]],
    ["zeta refuses the redaction marker: no retry", [error(-32602, { reason: "contains_redaction_marker" })], [], edited,
      { status: "invalid", message: `the text contains zeta's mask ${REDACTION_MARKER}. remove it or replace it with the real text before saving.` }, 1, []],
    ["unknown, a read settles it as saved", [error(-32000)], [{ revision: "", data: { redacted: false } }], edited, { status: "saved" }, 2, []],
    ["unknown, the read still has the opened revision", [new Error("socket closed")], [{ revision: opened, data: {} }], edited,
      { status: "unknown", message: "zeta did not save it. try again." }, 2, []],
    ["unknown, the read has other text", [new Error("socket closed")], [{ revision: "f".repeat(64), data: {} }], edited,
      { status: "stale", message: "this file changed after you opened it. your text is kept." }, 2, []],
  ])("%s", async (_name, writes, reads, text, expected, requests, waits) => {
    // "" stands for the sha256 of the sent text, which zeta returns as the new revision.
    const rev = await sha(text);
    for (const reply of [...writes, ...reads]) if ("revision" in reply && reply.revision === "") reply.revision = rev;
    const readCount = reads.length;
    const zeta = fakeZeta(writes, reads);
    const clock = fakeClock();
    const outcome = await createLibraryWriter(clock.sleep).save(zeta.client, target, opened, text, open());
    expect(outcome).toMatchObject(expected.status === "saved" ? { ...expected, revision: rev } : expected);
    expect(zeta.calls).toHaveLength(requests);
    // every write carries the revision the user opened; a read never turns into a second write.
    expect(zeta.calls.filter(([method]) => method === "skill_write").map(([, params]) => params))
      .toEqual(Array.from({ length: requests - readCount }, () => ({ name: target.name, scope: "home", revision: opened, mutation: { document: text } })));
    expect(clock.waits).toEqual(waits);
  });
});

// One table for "which form owns this save", through the public save API on a synthetic zeta that compares revisions
// like zeta does. Form A saves text A from the opened file. `second`: while A's write is held in flight, a second save of
// the same item from A's form (a double submit) or another form (discard, reopen, save). `cancel`: when form A closes.
// `drop`: the socket drops; the write may have landed, the old client is dead, and the first wait reconnects.
describe("which form owns a save", () => {
  const opened = "---\nname: fixture-skill\ndescription: synthetic\n---\nopened\n";
  const texts = { A: opened.replace("opened", "text A"), B: opened.replace("opened", "text B") };
  const busy = () => error(-32004, { reason: "operation_busy" });
  const dropped = () => new Error("socket closed");
  type Write = "apply" | "hold" | "apply, then drop" | Error;
  type Row = {
    op?: "create"; writes: Write[]; second?: { form: "A" | "B"; text: "A" | "B" }; cancel?: "before send" | "in flight" | "wait"; drop?: boolean;
    first: Partial<WriteOutcome> | null; secondOutcome?: Partial<WriteOutcome> | null; requests: number; file: "opened" | "A" | null; waits: number[]; landed?: number;
  };
  test.each<[string, Row]>([
    ["success", { writes: ["apply"], first: { status: "saved" }, requests: 1, file: "A", waits: [] }],
    ["a true double submit joins the save: one request", { writes: ["hold"], second: { form: "A", text: "A" }, first: { status: "saved" }, secondOutcome: { status: "saved" }, requests: 1, file: "A", waits: [] }],
    ["another form's other text while in flight never gets A's outcome", { writes: ["hold"], second: { form: "B", text: "B" }, first: { status: "saved" }, secondOutcome: IN_PROGRESS, requests: 1, file: "A", waits: [] }],
    ["another form's same text while in flight is refused too", { writes: ["hold"], second: { form: "B", text: "A" }, first: { status: "saved" }, secondOutcome: IN_PROGRESS, requests: 1, file: "A", waits: [] }],
    ["the form's own other text while in flight is refused", { writes: ["hold"], second: { form: "A", text: "B" }, first: { status: "saved" }, secondOutcome: IN_PROGRESS, requests: 1, file: "A", waits: [] }],
    ["closed before send: no write, no result", { writes: [], cancel: "before send", first: null, requests: 0, file: "opened", waits: [] }],
    ["closed during the busy backoff: no retry, no result", { writes: [busy()], cancel: "wait", first: null, requests: 1, file: "opened", waits: [500] }],
    ["closed during the settle wait: no read, no result", { writes: [dropped()], drop: true, cancel: "wait", first: null, requests: 2, file: "opened", waits: [500] }],
    ["closed while the edit is in flight: no result; the landed save is reported once", { writes: ["hold"], cancel: "in flight", first: null, requests: 1, file: "A", waits: [], landed: 1 }],
    ["closed while the create is in flight: no result; the landed save is reported once", { op: "create", writes: ["hold"], cancel: "in flight", first: null, requests: 1, file: "A", waits: [], landed: 1 }],
    ["send error, the read shows the opened file", { writes: [error(-32000)], first: { status: "unknown", message: "zeta did not save it. try again." }, requests: 2, file: "opened", waits: [] }],
    ["busy until the retries run out", { writes: [busy(), busy(), busy(), busy()], first: { status: "busy" }, requests: 4, file: "opened", waits: [500, 1_000, 2_000] }],
    ["unknown result, settled by a read on the live client after the reconnect", { writes: ["apply, then drop"], drop: true, first: { status: "saved" }, requests: 3, file: "A", waits: [500] }],
    ["reconnect mid-save, the write never landed", { writes: [dropped()], drop: true, first: { status: "unknown", message: "zeta did not save it. try again." }, requests: 3, file: "opened", waits: [500] }],
  ])("%s", async (_name, row) => {
    let file: string | null = row.op === "create" ? null : opened;
    const calls: string[] = [];
    let release!: () => void;
    let sent!: () => void;
    const held = new Promise<void>((resolve) => { sent = resolve; });
    const writes = [...row.writes];
    const zeta = (dead: () => boolean) => ({
      request: async (method: string, params: { revision?: string; mutation?: { document: string } }) => {
        calls.push(method);
        if (dead()) throw dropped();
        if (method === "skill_read") return { revision: file === null ? null : await sha(file), data: { redacted: false } };
        const reply = writes.shift();
        if (reply instanceof Error) throw reply;
        if (reply === "hold") { sent(); await new Promise<void>((resolve) => { release = resolve; }); }
        if ((params.revision ?? null) !== (file === null ? null : await sha(file))) throw error(-32009);
        file = params.mutation!.document;
        if (reply === "apply, then drop") { gone = true; throw dropped(); }
        return { revision: await sha(file), data: { name: target.name, scope: target.scope, redacted: false } };
      },
    }) as unknown as ZetaClient;
    let gone = false;
    let live: ZetaClient | null = null;
    const first = zeta(() => gone);
    const fresh = zeta(() => false);
    const forms = { A: new AbortController(), B: new AbortController() };
    const waits: number[] = [];
    const sleep = async (ms: number, signal?: AbortSignal) => {
      waits.push(ms);
      if (row.cancel === "wait") forms.A.abort();
      if (signal?.aborted) throw new Error("aborted");
      if (row.drop) live = fresh;
    };
    const landed: string[] = [];
    const writer = createLibraryWriter(sleep, () => live, (item) => landed.push(item.name));
    const base = await sha(opened);
    const save = (form: "A" | "B", text: "A" | "B") => row.op === "create"
      ? writer.create(first, target, texts[text], forms[form].signal) : writer.save(first, target, base, texts[text], forms[form].signal);
    if (row.writes[0] instanceof Error && row.drop) gone = true; // the socket is already gone when the write goes out
    const a = save("A", "A");
    if (row.cancel === "before send") forms.A.abort();
    let b: Promise<WriteOutcome | null> | undefined;
    if (row.writes[0] === "hold") {
      await held;
      if (row.cancel === "in flight") forms.A.abort();
      if (row.second) b = save(row.second.form, row.second.text);
      release();
    }
    const outcomes = [await a, await b];

    expect(outcomes[0] === null ? null : outcomes[0]).toEqual(row.first === null ? null : expect.objectContaining(row.first));
    if (row.second) expect(outcomes[1]).toEqual(row.secondOutcome ? expect.objectContaining(row.secondOutcome) : null);
    // a reported save is always the text that call sent, and the file holds it.
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome?.status !== "saved") continue;
      const sentText = i === 0 ? texts.A : texts[row.second!.text];
      expect([outcome.revision, file]).toEqual([await sha(sentText), sentText]);
    }
    expect(calls).toHaveLength(row.requests);
    expect(file).toBe(row.file === "A" ? texts.A : row.file === "opened" ? opened : null);
    expect(waits).toEqual(row.waits);
    expect(landed).toHaveLength(row.landed ?? 0);
  });
});
