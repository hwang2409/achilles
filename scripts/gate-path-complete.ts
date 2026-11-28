import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { GateWait } from "./gate-diagnostics";

type WaitFor = (check: () => Promise<boolean>, label: string) => Promise<void>;
type Frame = {
  id?: number | string;
  method?: string;
  params?: { session_id?: string; text_before_cursor?: string };
  result?: { capabilities?: { features?: string[]; requests?: string[] }; entries?: { text: string }[]; session?: { session_id?: string; cwd?: string } };
  error?: unknown;
};

const FILE = "gate-path-complete.txt";
const TYPED = "read @gate-path";

// @path completion against real zeta: the hello negotiates path_completion, typing `@` plus a prefix sends debounced
// path_complete requests for the chat, the list shows a file written in the chat's cwd, tab inserts it, escape closes.
export async function gatePathComplete(page: Page, chatId: string, waitFor: WaitFor, requests: () => Frame[], gateWait: GateWait) {
  const field = page.getByRole("textbox", { name: "message", exact: true });
  const list = page.getByRole("listbox", { name: "path completions" });
  const option = list.getByRole("option", { name: `@${FILE}`, exact: true });
  if (!requests().some((frame) => frame.result?.capabilities?.features?.includes("path_completion") && frame.result.capabilities.requests?.includes("path_complete")))
    throw new Error("zeta did not negotiate path_completion in hello");
  // the chat's cwd is its page workspace; zeta reports it with the session
  const cwd = requests().findLast((frame) => frame.result?.session?.session_id === chatId && frame.result.session.cwd)?.result?.session?.cwd;
  if (!cwd) throw new Error("zeta did not report the chat's cwd");
  const file = join(cwd.replace(/^~(?=\/)/, homedir()), FILE);
  await writeFile(file, "synthetic\n");
  try {
    const before = requests().length;
    await field.fill("");
    await field.pressSequentially(TYPED, { delay: 20 });
    await gateWait.playwright(option, "waitFor", { state: "visible", timeout: 10_000 });
    const sent = requests().slice(before).filter((frame) => frame.method === "path_complete");
    const last = sent.at(-1);
    // ten keys end an @ token; the pause between requests sends far fewer than one per key
    if (!last || sent.length > 3 || last.params?.session_id !== chatId || last.params?.text_before_cursor !== TYPED)
      throw new Error(`path_complete was not debounced to the chat's final text: ${JSON.stringify(sent.map((frame) => frame.params))}`);
    const reply = requests().slice(before).findLast((frame) => frame.id === last.id && (frame.result || frame.error));
    if (!reply?.result?.entries?.some((entry) => entry.text === FILE)) throw new Error(`path_complete did not list the file in the chat cwd: ${JSON.stringify(reply ?? null)}`);
    if (await option.getAttribute("aria-selected") !== "true") throw new Error("the first path is not chosen");
    if (await field.getAttribute("aria-activedescendant") !== await option.getAttribute("id")) throw new Error("the field does not point at the chosen path");

    await field.press("Tab");
    await waitFor(async () => await field.inputValue() === `read @${FILE}`, "tab inserts the chosen path");
    await gateWait.playwright(list, "waitFor", { state: "hidden", timeout: 10_000 });
    if (!(await field.evaluate((element) => element === document.activeElement))) throw new Error("tab moved focus out of the composer");

    await field.pressSequentially(" and @gate-path", { delay: 20 });
    await gateWait.playwright(option, "waitFor", { state: "visible", timeout: 10_000 });
    await field.press("Escape");
    await gateWait.playwright(list, "waitFor", { state: "hidden", timeout: 10_000 });
    if (await field.inputValue() !== `read @${FILE} and @gate-path`) throw new Error("escape changed the draft");
    await field.fill("");
  } finally {
    await rm(file, { force: true });
  }
  console.log("path completion: hello negotiated path_completion; debounced path_complete listed a file in the chat cwd; tab inserted it; escape closed the list");
}
