import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ZetaClient } from "@fulcrum/zeta";
import { LibraryModule } from "./LibraryModule";

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
