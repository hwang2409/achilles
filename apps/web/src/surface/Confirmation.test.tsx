import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, mock, test } from "bun:test";
import { useState } from "react";
import { Confirmation, reviewText as text, type ConfirmationProps } from "./Confirmation";
// bun links CommonJS react-dom before this file's imports run, so it loads only after the DOM above exists.
const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");

afterEach(() => { cleanup(); document.body.replaceChildren(); });

const common = { action: text("turn off"), keep: text("keep current"), effect: text("new sessions will not get github tools") };
type Inline = Extract<ConfirmationProps, { level: 1 }>;
function Row({ execute }: Pick<Inline, "execute">) {
  const [value, setValue] = useState(text("on"));
  return <Confirmation {...common} level={1} label={text("github")} value={value} onCommitted={setValue}
    execute={execute} checkResult={async () => ({ status: "unknown" })} />;
}

function review(execute: Extract<ConfirmationProps, { level: 2 }>["execute"], options?: Partial<Extract<ConfirmationProps, { level: 2 }>>) {
  const activity = document.body.appendChild(document.createElement("section"));
  const ui = render(<Confirmation {...common} level={2} title={text("cancel paper?")} action={text("cancel run")}
    scope={text("child of lead")} current={text("running")} after={text("cancelled")} undo={text("work in progress can be lost")}
    fields={[{ label: text("credential"), value: { provided: true } }]}
    proof={{ kind: "name", name: text("paper") }} activity={activity} execute={execute}
    checkResult={async () => ({ status: "unknown" })} {...options} />);
  const opener = ui.getByRole("button", { name: "cancel run" });
  fireEvent.click(opener);
  const modal = ui.getByRole("dialog", { name: "cancel paper?" });
  return { opener, modal, dialog: within(modal), activity: within(activity) };
}
const cancel = (dialog: HTMLElement) => fireEvent(dialog, new Event("cancel", { cancelable: true }));
async function settle(operation: string, action: () => void) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      act(async () => { action(); }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`timed out: ${operation}`)), 1_000); }),
    ]);
  } finally { clearTimeout(timeout); }
}
const click = (button: HTMLElement) => settle(`click ${button.textContent}`, () => { fireEvent.click(button); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("inline confirm takes focus; Escape keeps the authoritative state without writing", () => {
  const execute = mock(async () => ({ status: "unknown" as const }));
  const ui = render(<Row execute={execute} />);
  const opener = ui.getByRole("button", { name: "turn off" });
  fireEvent.click(opener);
  const confirm = within(ui.getByRole("group")).getByRole("button", { name: "turn off" });
  expect(document.activeElement).toBe(confirm);
  fireEvent.keyDown(confirm, { key: "Escape" });
  expect(document.activeElement).toBe(opener);
  expect(ui.getByText("on")).toBeTruthy();
  expect(execute).not.toHaveBeenCalled();
});

test("inline pending locks only its row; success uses the returned value and timestamps the receipt", async () => {
  const pending = deferred<Awaited<ReturnType<Inline["execute"]>>>();
  const ui = render(<><Row execute={() => pending.promise} /><button>other row</button></>);
  const opener = ui.getByRole("button", { name: "turn off" });
  fireEvent.click(opener);
  await click(within(ui.getByRole("group")).getByRole("button", { name: "turn off" }));
  expect(opener.hasAttribute("disabled")).toBe(true);
  expect(ui.getByRole("button", { name: "other row" }).hasAttribute("disabled")).toBe(false);
  expect(ui.getByText("saving…")).toBeTruthy();
  expect(ui.getByText("on")).toBeTruthy();
  await settle("deliver inline receipt", () => { pending.resolve({ status: "committed", value: text("off for new sessions"), receipt: text("github turned off") }); });
  expect(document.activeElement).toBe(opener);
  expect(ui.getByText("off for new sessions")).toBeTruthy();
  expect(ui.getByText(/github turned off at/).querySelector("time")?.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("inline known failure keeps the old value and announces a safe failure", async () => {
  const ui = render(<Row execute={async () => ({ status: "failed", reason: "changed" })} />);
  fireEvent.click(ui.getByRole("button", { name: "turn off" }));
  await click(within(ui.getByRole("group")).getByRole("button", { name: "turn off" }));
  expect(ui.getByText("on")).toBeTruthy();
  const result = ui.getByRole("alert");
  expect(document.activeElement === result).toBe(true);
  expect(result.textContent).toContain("refresh before trying again");
  expect(ui.container.querySelector("time")).toBeNull();
});

test("name proof is exact, including case and whitespace; Escape before submit returns focus", () => {
  const execute = mock(async () => ({ status: "unknown" as const }));
  const { opener, modal, dialog } = review(execute);
  const name = dialog.getByRole("textbox", { name: "type paper to confirm" });
  const submit = dialog.getByRole("button", { name: "cancel run" });
  expect(document.activeElement).toBe(name);
  expect(dialog.getByText("provided")).toBeTruthy();
  expect(dialog.getByText("now → after")).toBeTruthy();
  expect(dialog.getByText("running → cancelled")).toBeTruthy();
  expect(dialog.getByText("review", { selector: "header span" })).toBeTruthy();
  for (const value of ["", "Paper", "paper "]) {
    fireEvent.change(name, { target: { value } });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.submit(submit.closest("form")!);
  }
  expect(execute).not.toHaveBeenCalled();
  cancel(modal);
  expect(modal.isConnected).toBe(false);
  expect(document.activeElement).toBe(opener);
});

test("review invokes execute before confirm dispatch returns and maps a synchronous throw to unknown", async () => {
  const execute = mock(() => { throw new Error("private operation failure"); });
  const { dialog } = review(execute);
  fireEvent.change(dialog.getByRole("textbox"), { target: { value: "paper" } });
  const form = dialog.getByRole("button", { name: "cancel run" }).closest("form")!;
  await settle("submit a review with a synchronous throw", () => {
    fireEvent.submit(form);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  expect(dialog.getByText(/^result unknown\./)).toBeTruthy();
  await settle("resubmit the review with an unknown result", () => { fireEvent.submit(form); });
  expect(execute).toHaveBeenCalledTimes(1);
});

test("pending and unknown lock dismissal and duplicate submit; only a read confirms success", async () => {
  const pending = deferred<Awaited<ReturnType<Inline["execute"]>>>();
  const execute = mock(() => pending.promise);
  const checkResult = mock(async () => ({ status: "committed" as const, receipt: text("paper cancelled") }));
  const { opener, modal, dialog, activity } = review(execute, { checkResult });
  fireEvent.change(dialog.getByRole("textbox"), { target: { value: "paper" } });
  const submit = dialog.getByRole("button", { name: "cancel run" });
  const form = submit.closest("form")!;
  await settle("submit the review twice", () => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(execute).toHaveBeenCalledTimes(1);
  cancel(modal);
  expect(dialog.getByText("finishing…")).toBeTruthy();
  expect(activity.queryByText(/paper cancelled/)).toBeNull();
  await settle("deliver unknown result", () => { pending.reject(new Error("private transport body")); });
  const check = dialog.getByRole("button", { name: "check now" });
  cancel(modal);
  fireEvent.submit(form);
  expect(modal.isConnected).toBe(true);
  expect(document.activeElement?.textContent).toMatch(/^result unknown\./);
  expect(dialog.queryByText(/private transport body/)).toBeNull();
  expect(execute).toHaveBeenCalledTimes(1);
  await click(check);
  expect(checkResult).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(modal.isConnected).toBe(false);
  expect(document.activeElement).toBe(opener);
  expect(activity.getByText(/paper cancelled at/).querySelector("time")).toBeTruthy();
  fireEvent.click(activity.getByRole("button", { name: "dismiss receipt" }));
  expect(activity.queryByText(/paper cancelled/)).toBeNull();
});

test("scope proof gates submit; a known failure leaves a recoverable dialog open", async () => {
  const execute = mock(async () => ({ status: "failed" as const, reason: "not-applied" as const }));
  const { modal, dialog, activity } = review(execute, { proof: { kind: "scope" } });
  const scope = dialog.getByRole("checkbox", { name: "i reviewed the scope" });
  const submit = dialog.getByRole("button", { name: "cancel run" });
  expect(document.activeElement).toBe(scope);
  expect(dialog.queryByRole("textbox")).toBeNull();
  expect(submit.hasAttribute("disabled")).toBe(true);
  expect(dialog.getByText("check the box to continue.").id).toBe(submit.getAttribute("aria-describedby"));
  fireEvent.click(scope);
  expect(dialog.queryByText("check the box to continue.")).toBeNull();
  await click(submit);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(modal.isConnected).toBe(true);
  expect(document.activeElement).toBe(dialog.getByRole("alert"));
  expect(dialog.getByRole("alert").textContent).toContain("you can try again");
  expect(submit.hasAttribute("disabled")).toBe(false);
  expect(activity.queryByRole("button")).toBeNull();
});

test("a refused failure says another tab has control, keeps the dialog open, and a message replaces the fixed copy", async () => {
  const results = [{ status: "failed" as const, reason: "refused" as const }, { status: "failed" as const, reason: "not-applied" as const, message: text("not changed. zeta refused this change: fixture") }];
  const execute = mock(async () => results.shift()!);
  const { modal, dialog } = review(execute, { proof: { kind: "scope", label: text("i understand the scope") } });
  fireEvent.click(dialog.getByRole("checkbox", { name: "i understand the scope" }));
  await click(dialog.getByRole("button", { name: "cancel run" }));
  expect(modal.isConnected).toBe(true);
  expect(dialog.getByRole("alert").textContent).toBe("not changed. another tab has control; a chat tab keeps it while it is open. try again after it finishes or closes.");
  await click(dialog.getByRole("button", { name: "cancel run" }));
  expect(dialog.getByRole("alert").textContent).toBe("not changed. zeta refused this change: fixture");
  expect(execute).toHaveBeenCalledTimes(2);
});

const focusCases = ([1, 2] as const).flatMap(level => ([
  "success", "refusal", "unknown", "keep", "Escape", "refusal then keep", "refusal then Escape",
] as const).map(path => ({ level, path })));

test.each(focusCases)("level $level focus: $path", async ({ level, path }: (typeof focusCases)[number]) => {
  const execute: Inline["execute"] = async () => path === "success"
    ? { status: "committed", value: text("off"), receipt: text("done") }
    : path === "unknown" ? { status: "unknown" } : { status: "failed", reason: "denied" };
  const action = level === 1 ? "turn off" : "cancel run";
  const ui = level === 1 ? render(<Row execute={execute} />) : null;
  const modal = level === 2 ? review(execute) : null;
  const opener = modal?.opener ?? ui!.getByRole("button", { name: action });
  if (ui) fireEvent.click(opener);
  const surface = modal?.modal ?? ui!.getByRole("group");
  const confirm = within(surface).getByRole("button", { name: action });
  if (modal) fireEvent.change(modal.dialog.getByRole("textbox"), { target: { value: "paper" } });
  if (path !== "keep" && path !== "Escape") await click(confirm);
  // A level 1 refusal already closed the bar. Reopen it to exercise subsequent dismissal.
  if (path.startsWith("refusal then") && level === 1) fireEvent.click(opener);
  if (path.endsWith("keep")) {
    const host = modal?.modal ?? ui!.getByRole("group");
    const button = within(host).getByRole("button", { name: "keep current" });
    button.focus();
    fireEvent.click(button);
  }
  if (path.endsWith("Escape")) {
    if (modal) cancel(modal.modal); // Native dialog Escape dispatches cancel.
    else fireEvent.keyDown(ui!.getByRole("group"), { key: "Escape" });
  }
  const target = path === "refusal" ? within(modal?.modal ?? ui!.container).getByRole("alert")
    : path === "unknown" ? within(surface).getByText(/^result unknown\./) : opener;
  expect(document.activeElement === target).toBe(true);
});
