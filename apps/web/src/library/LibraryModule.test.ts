import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import type { ZetaClient } from "@fulcrum/zeta";

// after test-dom: React must see the registered DOM, or input events never reach onChange.
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { LibraryModule } = await import("./LibraryModule");

afterEach(cleanup);

const row = (name: string) => ({ name, description: `synthetic ${name}`, keywords: [], source: "home", scope: "home", filename: `${name}/SKILL.md`, editable: true, diagnostics: [] });

test("a skill body loads only on click, and a late read for an older selection never appears", async () => {
  const calls: [string, unknown][] = [];
  const reads = new Map<string, (body: string) => void>();
  const client = {
    features: ["library_read_v1"],
    request: (method: string, params: { name: string }) => {
      calls.push([method, params]);
      if (method === "skill_catalog") return Promise.resolve({ revision: "r", data: { items: [row("alpha"), row("beta")] } });
      return new Promise((resolve) => reads.set(params.name, (body) => resolve({ revision: "r", data: { name: params.name, frontmatter: {}, body, source: "home", editable: true, redacted: false } })));
    },
  } as unknown as ZetaClient;
  const view = render(createElement(LibraryModule, { client, kind: "skills", reads: { catalog: true, read: true } }));

  fireEvent.click(await view.findByRole("button", { name: /alpha/ }));
  expect(calls).toStrictEqual([["skill_catalog", { scope: "effective", limit: 100 }]]);
  expect(view.container.querySelector(".library-body")).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "show skill text" }));
  expect(calls.slice(1)).toStrictEqual([["skill_read", { name: "alpha", scope: "home" }]]);
  fireEvent.click(view.getByRole("button", { name: /beta/ }));
  await act(async () => reads.get("alpha")?.("ALPHA BODY"));

  expect(view.container.textContent).not.toContain("ALPHA BODY");
  expect(view.getByRole("button", { name: "show skill text" })).toBeTruthy();
  expect(calls).toHaveLength(2);

  fireEvent.click(view.getByRole("button", { name: "show skill text" }));
  await act(async () => reads.get("beta")?.("<b>BETA</b> BODY"));
  expect(view.container.querySelector("pre.library-body")?.textContent).toBe("<b>BETA</b> BODY");
  expect(view.container.querySelector("pre.library-body b")).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("beta skill text");
  expect(view.container.querySelector(".library-text [role=status]")?.textContent).toBe("skill text loaded");
});

test("a page with no rows still lists the files zeta skipped", async () => {
  const diagnostics = [{ source: "home", file: "broken/SKILL.md", reason: "invalid YAML frontmatter" }];
  const client = { request: () => Promise.resolve({ revision: "r", data: { items: [], diagnostics } }) } as unknown as ZetaClient;
  const view = render(createElement(LibraryModule, { client, kind: "skills", reads: { catalog: true, read: true } }));

  expect(await view.findByText("no skills found")).toBeTruthy();
  expect(view.container.querySelector(".library-skipped summary")?.textContent).toBe("1 file skipped or shadowed");
  expect(view.container.querySelector(".library-skipped li")?.textContent).toBe("home · broken/SKILL.md invalid YAML frontmatter");
});

test("a draft stays visible and read-only when zeta stops allowing the save, and nothing is sent", async () => {
  const calls: string[] = [];
  const client = { request: (method: string) => { calls.push(method); return Promise.resolve({ revision: "r", data: { items: [] } }); } } as unknown as ZetaClient;
  const write = { controller: true, allowed: true, takeControl: async () => null, feedback: null };
  const props = { client, kind: "skills" as const, reads: { catalog: true, read: true } };
  const view = render(createElement(LibraryModule, { ...props, write }));
  await view.findByText("no skills found");
  fireEvent.click(view.getByRole("button", { name: "+ new skill" }));
  for (const [label, value] of [["name", "fixture-draft"], ["description", "synthetic draft"]] as const) {
    const field = view.getByLabelText(label);
    await act(async () => { fireEvent.change(field, { target: { value } }); });
  }
  view.rerender(createElement(LibraryModule, { ...props, write: { ...write, allowed: false } }));

  const text = view.container.querySelector<HTMLTextAreaElement>(".library-editor textarea")!;
  expect(text.value).toContain('name: "fixture-draft"');
  expect(text.readOnly).toBe(true);
  expect(view.getByRole("alert").textContent).toBe("this zeta does not allow saving here. your text is kept; nothing was sent.");
  expect(view.queryByRole("button", { name: /^save/ })).toBeNull();
  expect(calls.filter((method) => method.endsWith("_write"))).toEqual([]);
});

// A synthetic zeta with one home skill file. Writes check the revision like zeta's compare-and-swap.
const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const fileText = "---\nname: alpha\ndescription: synthetic alpha\n---\noriginal body\n";
type Fixture = { document: string; redacted?: boolean; truncated?: boolean; withheld?: boolean; source?: string; writeErrors?: object[] };
function editZeta(fixture: Fixture) {
  const calls: [string, Record<string, unknown>][] = [];
  const zeta = {
    file: fixture.document,
    calls,
    writes: () => calls.filter(([method]) => method === "skill_write").map(([, params]) => params),
    client: () => ({
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push([method, params]);
        const source = fixture.source ?? "home";
        if (method === "skill_catalog") return { revision: "r", data: { items: [{ ...row("alpha"), source, scope: source === "packaged" ? "effective" : source, editable: source !== "packaged" }] } };
        if (method === "skill_read") return { revision: await sha(zeta.file), data: { name: "alpha", frontmatter: {}, body: "body", source, editable: source !== "packaged",
          redacted: fixture.redacted === true, ...(fixture.truncated ? { truncated: true } : {}),
          ...(fixture.redacted || fixture.truncated || fixture.withheld || source === "packaged" ? {} : { document: zeta.file }) } };
        const failure = fixture.writeErrors?.shift();
        if (failure) throw failure;
        if (params.revision !== await sha(zeta.file)) throw Object.assign(new Error("stale"), { code: -32009, data: { reason: "stale_library_revision" } });
        zeta.file = (params.mutation as { document: string }).document;
        return { revision: await sha(zeta.file), data: { name: params.name, scope: params.scope, redacted: zeta.file.includes("sk_fixture") } };
      },
    }) as unknown as ZetaClient,
  };
  return zeta;
}
const writable = { controller: true, allowed: true, takeControl: async () => null, feedback: null };
const textarea = (view: ReturnType<typeof render>, label: RegExp) => view.getByLabelText(label) as HTMLTextAreaElement;
async function openEditor(zeta: ReturnType<typeof editZeta>, write: typeof writable = writable) {
  const view = render(createElement(LibraryModule, { client: zeta.client(), kind: "skills", reads: { catalog: true, read: true }, write }));
  fireEvent.click(await view.findByRole("button", { name: /alpha/ }));
  fireEvent.click(view.getByRole("button", { name: "show skill text" }));
  fireEvent.click(await view.findByRole("button", { name: "edit" }));
  return view;
}
const type = (view: ReturnType<typeof render>, value: string) => act(async () => { fireEvent.change(textarea(view, /^alpha · file text/), { target: { value } }); });
const press = (view: ReturnType<typeof render>, name: string | RegExp) => act(async () => { fireEvent.click(view.getByRole("button", { name })); });

test("edit sends the opened revision, and the saved text becomes the new baseline", async () => {
  const zeta = editZeta({ document: fileText });
  const view = await openEditor(zeta);
  const opened = await sha(fileText);
  expect(textarea(view, /^alpha · file text/).value).toBe(fileText);
  const edited = fileText.replace("original", "edited");
  await type(view, edited);
  // Escape in the editor does not leave it; Ctrl+S saves once.
  await act(async () => { fireEvent.keyDown(textarea(view, /file text/), { key: "Escape" }); });
  await act(async () => { fireEvent.keyDown(textarea(view, /file text/), { key: "s", ctrlKey: true }); });
  await press(view, "save skill");

  expect(zeta.writes()).toEqual([{ name: "alpha", scope: "home", revision: opened, mutation: { document: edited } }]);
  expect(zeta.file).toBe(edited);
  expect(await view.findByText("saved. running sessions pick up the change at their next catalog refresh.")).toBeTruthy();
  expect(textarea(view, /^alpha · file text$/).value).toBe(edited);
  expect(view.getByRole("button", { name: "save skill" }).getAttribute("aria-disabled")).toBe("true");
  expect(zeta.calls.filter(([method]) => method === "skill_catalog")).toHaveLength(2);
});

test("a save zeta reports as redacted closes the editor and says the file has secret-like text", async () => {
  const zeta = editZeta({ document: fileText });
  const view = await openEditor(zeta);
  await type(view, `${fileText}token sk_fixture_0000000000\n`);
  await press(view, "save skill");
  expect(await view.findByText("this file contains text that looks like a secret; zeta stored it as written; reads show it masked")).toBeTruthy();
  expect(view.container.querySelector(".library-editor")).toBeNull();
  expect(view.container.textContent).not.toContain("sk_fixture");
});

test("a stale save shows the conflict bar, sends nothing more, and loading the latest keeps the user's text", async () => {
  const zeta = editZeta({ document: fileText });
  const view = await openEditor(zeta);
  const mine = fileText.replace("original", "mine");
  await type(view, mine);
  zeta.file = fileText.replace("original", "theirs");
  await press(view, "save skill");
  expect((await view.findByText("this file changed after you opened it. your text is kept.")).closest(".library-conflict")).toBeTruthy();
  await press(view, "load the latest version first");
  await act(async () => { fireEvent.keyDown(textarea(view, /file text/), { key: "s", metaKey: true }); });
  expect(zeta.writes()).toHaveLength(1);
  expect(textarea(view, /file text/).value).toBe(mine);

  await press(view, "load the latest version");
  expect(textarea(view, /^alpha · file text/).value).toBe(zeta.file);
  expect(textarea(view, /your unsaved text/).value).toBe(mine);
  expect(zeta.writes()).toHaveLength(1);
  await type(view, mine);
  await press(view, "save skill");
  expect(zeta.writes()[1]?.revision).toBe(await sha(fileText.replace("original", "theirs")));
  expect(zeta.file).toBe(mine);
});

test("an observer refusal offers take control, keeps the draft across the client swap, and the next save works", async () => {
  const zeta = editZeta({ document: fileText, writeErrors: [Object.assign(new Error("observer"), { code: -32008, data: { reason: "observer_read_only" } })] });
  let taken = 0;
  const write = { ...writable, takeControl: async () => { taken++; return null; } };
  const view = await openEditor(zeta, write);
  const edited = fileText.replace("original", "edited");
  await type(view, edited);
  await press(view, "save skill");
  await press(view, "take control");
  expect(taken).toBe(1);
  view.rerender(createElement(LibraryModule, { client: zeta.client(), kind: "skills", reads: { catalog: true, read: true }, write }));
  expect(textarea(view, /file text/).value).toBe(edited);
  await press(view, "save skill");
  expect(await view.findByText("saved. running sessions pick up the change at their next catalog refresh.")).toBeTruthy();
  expect(zeta.writes()).toHaveLength(2);
  expect(zeta.file).toBe(edited);
});

test("the redaction marker blocks the save before anything is sent", async () => {
  const zeta = editZeta({ document: fileText });
  const view = await openEditor(zeta);
  await type(view, `${fileText}key [secret omitted]\n`);
  await press(view, "save skill");
  expect(view.getByRole("alert").textContent).toContain("the text contains zeta's mask [secret omitted]");
  expect(zeta.writes()).toEqual([]);
});

test("discarding unsaved text asks first, and keep editing keeps it", async () => {
  const zeta = editZeta({ document: fileText });
  const view = await openEditor(zeta);
  await type(view, `${fileText}more\n`);
  await press(view, "discard");
  expect(document.activeElement?.textContent).toBe("keep editing");
  await press(view, "keep editing");
  expect(textarea(view, /file text/).value).toBe(`${fileText}more\n`);
  await press(view, "discard");
  await press(view, "discard changes");
  expect(view.container.querySelector(".library-editor")).toBeNull();
  expect(zeta.writes()).toEqual([]);
});

test.each<[string, Fixture, string]>([
  ["redacted", { document: fileText, redacted: true }, "this file has text that looks like a secret, shown masked."],
  ["truncated", { document: fileText, truncated: true }, "this file is over 128 KiB."],
  ["document withheld", { document: fileText, withheld: true }, "zeta did not send an editable copy"],
  ["packaged", { document: fileText, source: "packaged" }, "built-in items are read-only."],
])("no edit control when the read has no document: %s", async (_name, fixture, why) => {
  const zeta = editZeta(fixture);
  const view = render(createElement(LibraryModule, { client: zeta.client(), kind: "skills", reads: { catalog: true, read: true }, write: writable }));
  fireEvent.click(await view.findByRole("button", { name: /alpha/ }));
  fireEvent.click(view.getByRole("button", { name: "show skill text" }));
  expect((await view.findByText((text) => text.startsWith(why))).className).toBe("library-edit-why");
  expect(view.container.querySelector('[data-write-surface="library.edit"]')).toBeNull();
});
