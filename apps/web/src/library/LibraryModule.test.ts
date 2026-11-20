import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import type { ZetaClient } from "@fulcrum/zeta";

// after test-dom: React must see the registered DOM, or input events never reach onChange.
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { LibraryModule } = await import("./LibraryModule");
const { createLibraryWriter } = await import("./libraryWrites");

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

test("a create save that lands after discard does not close or clear a form opened later", async () => {
  let land!: () => void;
  const calls: string[] = [];
  const client = { request: (method: string, params: { name?: string; mutation?: { document: string } }) => {
    calls.push(method);
    if (method !== "skill_write") return Promise.resolve({ revision: "r", data: { items: [] } });
    return new Promise((resolve) => { land = async () => resolve({ revision: await sha(params.mutation!.document), data: { name: params.name, scope: "home", redacted: false } }); });
  } } as unknown as ZetaClient;
  const write = { controller: true, allowed: true, takeControl: async () => null, feedback: null, drafts: new Map(), edits: new Map(), writer: createLibraryWriter(undefined, () => client), releaseControl: () => {} };
  const view = render(createElement(LibraryModule, { client, kind: "skills", reads: { catalog: true, read: true }, write }));
  await view.findByText("no skills found");
  const fill = async (name: string) => {
    for (const [label, value] of [["name", name], ["description", "synthetic draft"]] as const)
      await act(async () => { fireEvent.change(view.getByLabelText(label), { target: { value } }); });
  };
  fireEvent.click(view.getByRole("button", { name: "+ new skill" }));
  await fill("fixture-first");
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "save skill" })); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "discard" })); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "discard changes" })); });
  expect(document.activeElement?.textContent).toBe("+ new skill");
  fireEvent.click(view.getByRole("button", { name: "+ new skill" }));
  await fill("fixture-second");
  await act(async () => land());

  expect(view.container.querySelector<HTMLInputElement>('.library-editor input[aria-describedby$="-rules"]')?.value, "the form opened after discard").toBe("fixture-second");
  expect(write.drafts.get("skills/new")?.name).toBe("fixture-second");
  expect(await view.findByText("saved fixture-first. running sessions pick up the change at their next catalog refresh.")).toBeTruthy();
  expect(calls.filter((method) => method === "skill_write")).toHaveLength(1);
});

// project: the remounted form's project check has not answered when the outcome arrives, so the notice must use the
// target fixed when the save started.
test.each([
  ["home", "home · skills/fixture-new.md"],
  ["project", "fixture-project · .zeta/skills/fixture-new.md"],
] as const)("a %s create whose reply was lost in a socket drop shows saved after the remount, not a name collision", async (scope, where) => {
  let file: string | null = null;
  let probes = 0;
  const writes: unknown[] = [];
  const client = { request: async (method: string, params: { name?: string; scope?: string; mutation?: { document: string } }) => {
    if (method === "skill_catalog" && params.scope === "project" && ++probes > 1) return new Promise(() => {}); // the remounted check hangs
    if (method === "skill_catalog") return { revision: "r", data: { items: file === null ? [] : [{ ...row("fixture-new"), source: scope, scope }] } };
    if (method === "status") return { session: { cwd: "/synthetic/fixture-project" } };
    if (method === "skill_read") {
      if (file === null) throw Object.assign(new Error("gone"), { code: -32602, data: { reason: "resource_not_found" } });
      return { revision: await sha(file), data: { name: "fixture-new", redacted: false } };
    }
    if (method !== "skill_write") throw Object.assign(new Error("no project"), { code: -32005 });
    writes.push(params);
    file = params.mutation!.document;
    throw new Error("socket closed"); // zeta wrote the file; its reply died with the socket
  } } as unknown as ZetaClient;
  // `liveClient` is the older shape of the same seam; `writer` is the router's writer, with a clock that does not wait.
  const write = { controller: true, allowed: true, takeControl: async () => null, feedback: null, drafts: new Map(), edits: new Map(),
    liveClient: () => client, writer: createLibraryWriter(async () => {}, () => client), releaseControl: () => {} };
  const props = { client, kind: "skills", reads: { catalog: true, read: true }, write } as const;
  const view = render(createElement(LibraryModule, props));
  await view.findByText("no skills found");
  fireEvent.click(view.getByRole("button", { name: "+ new skill" }));
  if (scope === "project") fireEvent.click(await view.findByRole("radio", { name: "project · fixture-project" }));
  for (const [label, value] of [["name", "fixture-new"], ["description", "synthetic draft"]] as const)
    await act(async () => { fireEvent.change(view.getByLabelText(label), { target: { value } }); });
  fireEvent.click(view.getByRole("button", { name: "save skill" }));
  view.unmount(); // the socket drops before the outcome: the library view unmounts
  const again = render(createElement(LibraryModule, props));

  expect(await again.findByText(`saved fixture-new to ${where}. running sessions pick up the change at their next catalog refresh.`)).toBeTruthy();
  expect(again.container.querySelector(".library-editor")).toBeNull();
  expect(again.queryByText(/already exists/)).toBeNull();
  expect(writes).toEqual([expect.objectContaining({ scope })]);
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
const writable = () => ({ controller: true, allowed: true, takeControl: async () => null, feedback: null, drafts: new Map(), edits: new Map(), writer: createLibraryWriter(), releaseControl: () => {} });
const textarea = (view: ReturnType<typeof render>, label: RegExp) => view.getByLabelText(label) as HTMLTextAreaElement;
async function openEditor(zeta: ReturnType<typeof editZeta>, write: ReturnType<typeof writable> = writable()) {
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
  expect(await view.findByText(/^saved (alpha|fixture-first to home · skills\/fixture-first\.md)\. running sessions pick up the change at their next catalog refresh\.$/)).toBeTruthy();
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
  const write = { ...writable(), takeControl: async () => { taken++; return null; } };
  const view = await openEditor(zeta, write);
  const edited = fileText.replace("original", "edited");
  await type(view, edited);
  await press(view, "save skill");
  await press(view, "take control");
  expect(taken).toBe(1);
  view.rerender(createElement(LibraryModule, { client: zeta.client(), kind: "skills", reads: { catalog: true, read: true }, write }));
  expect(textarea(view, /file text/).value).toBe(edited);
  await press(view, "save skill");
  expect(await view.findByText(/^saved (alpha|fixture-first to home · skills\/fixture-first\.md)\. running sessions pick up the change at their next catalog refresh\.$/)).toBeTruthy();
  expect(zeta.writes()).toHaveLength(2);
  expect(zeta.file).toBe(edited);
});

test("discarding unsaved text asks first, and keep editing keeps it", async () => {
  const zeta = editZeta({ document: fileText });
  const view = await openEditor(zeta);
  // an open edit holds control: "+ new" is not offered, so nothing can replace the edit or give the slot back.
  expect(view.queryByRole("button", { name: "+ new skill" })).toBeNull();
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
  ["redacted", { document: fileText, redacted: true }, "edit it in your own editor; saving here would replace the secret with the mask."],
  ["truncated", { document: fileText, truncated: true }, "this file is over 128 KiB."],
  ["document withheld", { document: fileText, withheld: true }, "zeta did not send an editable copy"],
  ["packaged", { document: fileText, source: "packaged" }, "built-in items are read-only."],
])("no edit control when the read has no document: %s", async (_name, fixture, why) => {
  const zeta = editZeta(fixture);
  const view = render(createElement(LibraryModule, { client: zeta.client(), kind: "skills", reads: { catalog: true, read: true }, write: writable() }));
  fireEvent.click(await view.findByRole("button", { name: /alpha/ }));
  fireEvent.click(view.getByRole("button", { name: "show skill text" }));
  expect((await view.findByText((text) => text.startsWith(why))).className).toBe("library-edit-why");
  expect(view.container.querySelector('[data-write-surface="library.edit"]')).toBeNull();
});

test("an open edit survives a socket drop that unmounts the library", async () => {
  const zeta = editZeta({ document: fileText });
  const write = writable();
  const view = await openEditor(zeta, write);
  await type(view, `${fileText}draft\n`);
  view.unmount();
  const again = render(createElement(LibraryModule, { client: zeta.client(), kind: "skills", reads: { catalog: true, read: true }, write }));
  expect(textarea(again, /^alpha · file text/).value).toBe(`${fileText}draft\n`);
  await press(again, "save skill");
  expect(zeta.writes()).toEqual([{ name: "alpha", scope: "home", revision: await sha(fileText), mutation: { document: `${fileText}draft\n` } }]);
});

test("save on a tab that lost control takes control first, and sends nothing when the slot is taken", async () => {
  const zeta = editZeta({ document: fileText });
  const live = zeta.client();
  let slotFree = false;
  const write = { ...writable(), writer: createLibraryWriter(undefined, () => live) };
  const view = await openEditor(zeta, write);
  view.rerender(createElement(LibraryModule, { client: zeta.client(), kind: "skills", reads: { catalog: true, read: true },
    write: { ...write, controller: false, takeControl: async () => slotFree ? null : "another tab has control. try again after it closes." } }));
  expect(view.getByText("this tab is read-only now. save takes control first, if no other tab has it.")).toBeTruthy();
  await type(view, fileText.replace("original", "edited"));
  await press(view, "save skill");
  expect(await view.findByText("another tab has control. try again after it closes.", { selector: ".library-error" })).toBeTruthy();
  expect(zeta.writes()).toEqual([]);
  slotFree = true;
  await press(view, "save skill");
  expect(await view.findByText(/^saved alpha\./)).toBeTruthy();
  expect(zeta.writes()).toHaveLength(1);
});
