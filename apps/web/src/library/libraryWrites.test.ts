import { describe, expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { createLibraryWriter, createProblems, REDACTION_MARKER, type WriteOutcome, type WriteTarget } from "./libraryWrites";

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
    const outcome = await createLibraryWriter(clock.sleep).create(zeta.client, target, text);
    expect(outcome).toMatchObject(expected);
    expect(zeta.calls).toHaveLength(requests);
    expect(zeta.calls.filter(([method]) => method === "skill_write").every(([, params]) =>
      JSON.stringify(params) === JSON.stringify({ name: target.name, scope: "home", mutation: { document: text } }))).toBe(true);
    expect(clock.waits).toEqual(waits);
  });

  test("a double submit sends one request and both callers get its outcome", async () => {
    const zeta = fakeZeta([saved()]);
    const writer = createLibraryWriter(fakeClock().sleep);
    const [first, second] = await Promise.all([writer.create(zeta.client, target, document), writer.create(zeta.client, target, document)]);
    expect(zeta.calls).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first.status).toBe("saved");
  });

  test("cancel during the busy wait stops retrying", async () => {
    const zeta = fakeZeta([error(-32004), saved()]);
    const abort = new AbortController();
    let release!: () => void;
    const sleep = (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      release = resolve;
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const pending = createLibraryWriter(sleep).create(zeta.client, target, document, abort.signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(zeta.calls).toHaveLength(1);
    abort.abort();
    expect((await pending).status).toBe("busy");
    release();
    expect(zeta.calls).toHaveLength(1);
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
    const outcome = await createLibraryWriter(clock.sleep).save(zeta.client, target, opened, text);
    expect(outcome).toMatchObject(expected.status === "saved" ? { ...expected, revision: rev } : expected);
    expect(zeta.calls).toHaveLength(requests);
    // every write carries the revision the user opened; a read never turns into a second write.
    expect(zeta.calls.filter(([method]) => method === "skill_write").map(([, params]) => params))
      .toEqual(Array.from({ length: requests - readCount }, () => ({ name: target.name, scope: "home", revision: opened, mutation: { document: text } })));
    expect(clock.waits).toEqual(waits);
  });

  test("a double submit sends one request", async () => {
    const zeta = fakeZeta([saved(false, await sha(document))]);
    const writer = createLibraryWriter(fakeClock().sleep);
    const [first, second] = await Promise.all([writer.save(zeta.client, target, opened, document), writer.save(zeta.client, target, opened, document)]);
    expect(zeta.calls).toHaveLength(1);
    expect(first).toEqual(second);
  });
});

test("after a socket drop, the read that settles an unknown result uses the reconnected client", async () => {
  const dead = fakeZeta([new Error("socket closed")], [new Error("socket closed")]);
  const fresh = fakeZeta([], [{ revision, data: { redacted: false } }]);
  let current: ZetaClient | null = null;
  const clock = fakeClock();
  // the connection is still reconnecting for the first wait, then the new client is live.
  const sleep = async (ms: number) => { await clock.sleep(ms); current = fresh.client; };
  const outcome = await createLibraryWriter(sleep, () => current).create(dead.client, target, document);
  expect(outcome).toMatchObject({ status: "saved", revision });
  expect(dead.calls.map(([method]) => method)).toEqual(["skill_write", "skill_read"]);
  expect(fresh.calls).toEqual([["skill_read", { name: target.name, scope: "home" }]]);
  expect(clock.waits).toEqual([500]);
});
