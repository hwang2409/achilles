import { expect, test } from "bun:test";
import { createWriteForms } from "./writeForms";

function setup() {
  const late: unknown[][] = [];
  const forms = createWriteForms<string, string>({ inProgress: "busy", unexpected: "failed", afterClose: (...args) => late.push(args) });
  const a = forms.open(), b = forms.open();
  const seen: unknown[][] = [];
  const attach = (form: string) => forms.attach(form, (...args) => seen.push(args));
  const gate = Promise.withResolvers<string>();
  let starts = 0, followed = false;
  const attempt = async (signal: AbortSignal) => {
    starts++;
    const outcome = await gate.promise;
    if (!signal.aborted) followed = true;
    return outcome;
  };
  const run = (form = a, key = "project", fingerprint = "x") => forms.run(form, key, fingerprint, fingerprint, attempt);
  return { ...forms, a, b, run, attach, seen, late, gate, starts: () => starts, followed: () => followed };
}

test.each([
  { name: "same form and request join", other: "same", key: "project", fingerprint: "x", starts: 1, conflict: false },
  { name: "another form on the same key is refused", other: "different", key: "project", fingerprint: "x", starts: 1, conflict: true },
  { name: "another request from the same form is refused", other: "same", key: "project", fingerprint: "y", starts: 1, conflict: true },
  { name: "independent keys run", other: "different", key: "other", fingerprint: "x", starts: 2, conflict: false },
])("write forms: $name", async ({ other, key, fingerprint, starts, conflict }) => {
  const f = setup();
  f.attach(f.a); f.attach(f.b);
  try {
    const run = f.run();
    const second = f.run(other === "same" ? f.a : f.b, key, fingerprint);
    expect(f.pending(f.a)).toBe(true);
    expect(f.starts()).toBe(starts);
    if (!conflict && starts === 1) expect(second).toBe(run);
    expect(f.seen).toEqual(conflict ? [["busy", fingerprint]] : []);
    f.gate.resolve("landed");
    await Promise.all([run, second]);
    expect(f.pending(f.a)).toBe(false);
    expect(f.seen).toEqual([...(conflict ? [["busy", fingerprint]] : []), ...Array.from({ length: starts }, () => ["landed", "x"])]);
  } finally { f.gate.resolve("landed"); }
});

test("write forms: an outcome held during a remount is delivered once", async () => {
  const f = setup();
  const detach = f.attach(f.a);
  const run = f.run();
  detach();
  f.gate.resolve("landed");
  await run;
  expect(f.seen).toEqual([]);
  f.attach(f.a)(); f.attach(f.a);
  expect(f.seen).toEqual([["landed", "x"]]);
});

test("write forms: close aborts follow-up work but reports a sent request that lands", async () => {
  const f = setup();
  f.attach(f.a);
  const run = f.run();
  f.close(f.a);
  f.gate.resolve("landed");
  await run;
  expect(f.followed()).toBe(false);
  expect(f.seen).toEqual([]);
  expect(f.late).toEqual([["landed", "x"]]);
});
