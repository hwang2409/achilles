// @ts-nocheck
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  GlobalRegistrator.unregister();
  globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

const { act, createElement, useState } = await import("react");
const { fireEvent, render } = await import("@testing-library/react");
const { EnumListbox } = await import("./EnumListbox");

let mounted: ReturnType<typeof render> | null = null;
afterEach(async () => {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
});

const options = ["food", "fiction", "music", "travel"] as const;
const Harness = (props: { invalid?: boolean; disabled?: boolean }) => {
  const [value, setValue] = useState("music");
  return createElement(EnumListbox, {
    value,
    options,
    onChange: setValue,
    label: "kind",
    invalid: props.invalid,
    disabled: props.disabled,
  });
};
const view = () => mounted as ReturnType<typeof render>;
const button = () => view().getByRole("button", { name: "kind" });
const menu = () => view().getByRole("listbox");

async function openWith(key = "Enter") {
  fireEvent.keyDown(button(), { key });
  await act(async () => Promise.resolve());
}

test("opens with enter, moves with arrows, and selects with enter", async () => {
  mounted = render(createElement(Harness, {}));
  await openWith();
  expect(button().getAttribute("aria-expanded")).toBe("true");
  expect(menu().getAttribute("aria-activedescendant")).toBeTruthy();
  fireEvent.keyDown(menu(), { key: "ArrowDown" });
  fireEvent.keyDown(menu(), { key: "ArrowDown" });
  expect(menu().getAttribute("aria-activedescendant")).toContain("option-3");
  fireEvent.keyDown(menu(), { key: "Enter" });
  expect(button().textContent).toContain("travel");
  expect(button().getAttribute("aria-expanded")).toBe("false");
});

test("home and end move to the first and last options", async () => {
  mounted = render(createElement(Harness, {}));
  await openWith("ArrowDown");
  fireEvent.keyDown(menu(), { key: "Home" });
  expect(menu().getAttribute("aria-activedescendant")).toContain("option-0");
  fireEvent.keyDown(menu(), { key: "End" });
  expect(menu().getAttribute("aria-activedescendant")).toContain("option-3");
});

test("type-ahead shows its query, activates the match, and enter picks it", async () => {
  mounted = render(createElement(Harness, {}));
  await openWith();
  fireEvent.keyDown(menu(), { key: "f" });
  fireEvent.keyDown(menu(), { key: "o" });
  expect(button().textContent).toContain("jump fo");
  expect(menu().getAttribute("aria-activedescendant")).toContain("option-0");
  expect(Array.from(view().getAllByRole("option")).find((option) => option.textContent?.includes("food"))?.querySelector("u")?.textContent).toBe("fo");
  fireEvent.keyDown(menu(), { key: "Enter" });
  expect(button().textContent).toContain("food");
});

test("escape closes without changing the value and returns focus to the button", async () => {
  mounted = render(createElement(Harness, {}));
  await openWith();
  fireEvent.keyDown(menu(), { key: "ArrowDown" });
  fireEvent.keyDown(menu(), { key: "Escape" });
  expect(button().textContent).toContain("music");
  expect(button().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(button());
});

test("arrow-up opens at the last option and clicking outside closes", async () => {
  mounted = render(createElement(Harness, {}));
  await openWith("ArrowUp");
  expect(menu().getAttribute("aria-activedescendant")).toContain("option-3");
  fireEvent.pointerDown(document.body);
  expect(view().queryByRole("listbox")).toBeNull();
  expect(button().textContent).toContain("music");
});

test("clicking an option selects it and exposes selected semantics", async () => {
  mounted = render(createElement(Harness, {}));
  fireEvent.click(button());
  const food = view().getByRole("option", { name: "food" });
  expect(food.getAttribute("aria-selected")).toBe("false");
  fireEvent.click(food);
  expect(button().textContent).toContain("food");
  fireEvent.click(button());
  expect(view().getByRole("option", { name: "food" }).getAttribute("aria-selected")).toBe("true");
});

test("passes label, description, invalid, and disabled semantics", () => {
  mounted = render(createElement(Harness, { invalid: true, disabled: true }));
  expect(button().getAttribute("aria-haspopup")).toBe("listbox");
  expect(button().getAttribute("aria-invalid")).toBe("true");
  expect((button() as HTMLButtonElement).disabled).toBe(true);
  expect(button().getAttribute("aria-controls")).toBeTruthy();
});
