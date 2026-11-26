import { expect, test } from "bun:test";
import { draftStore } from "../draftStore";
import { deliverChatMessage } from "../useActiveChat";
import { createChatQueues, NOT_SENT } from "./chatQueues";
import { inFlight, MAYBE_SENT } from "./composer-machine";
import { createComposerDelivery, type ComposerDelivery, type SendIntent } from "./useComposerDelivery";

type Scenario = {
  name: string;
  state: "idle" | "steerable";
  statuses?: Array<{ status: string; outcome?: string }>;
  statusReads?: number;
  draftWhileQueued?: boolean;
  remount?: boolean;
  race?: "send-to-steer" | "steer-to-send" | "double-rejection";
  expectedMethods?: Array<"send" | "steer">;
  /** a failed message stays as a row with this error; the box stays empty */
  expectedFailure?: string;
  retryDropped?: boolean;
};

const dropped = "zeta dropped this message before reading it.";
const scenarios: Scenario[] = [
  { name: "send ok", state: "idle" },
  // zeta started the turn that carries an end-of-turn steer, so send gets -32004: one steer retry with the same delivery id
  { name: "send rejected after turn_end", state: "idle", race: "send-to-steer", expectedMethods: ["send", "steer"], statuses: [{ status: "queued" }, { status: "queued" }, { status: "delivered" }], statusReads: 3, draftWhileQueued: true },
  { name: "send rejected after turn_end, steer dropped", state: "idle", race: "send-to-steer", expectedMethods: ["send", "steer"], statuses: [{ status: "dropped" }], statusReads: 1, expectedFailure: dropped },
  { name: "steer rejected after turn ends", state: "steerable", race: "steer-to-send", expectedMethods: ["steer", "send"] },
  { name: "fallback is not retried", state: "idle", race: "double-rejection", expectedMethods: ["send", "steer"], expectedFailure: "no turn is running" },
  { name: "steer consumed", state: "steerable", statuses: [{ status: "delivered" }], statusReads: 1 },
  {
    name: "steer dropped",
    state: "steerable",
    statuses: [{ status: "queued" }, { status: "dropped" }, { status: "delivered" }, { status: "dropped" }],
    statusReads: 4,
    expectedFailure: dropped,
    retryDropped: true,
  },
  { name: "steer evicted after consumption", state: "steerable", statuses: [{ status: "evicted", outcome: "delivered" }], statusReads: 1 },
  { name: "reload or remount during delivery", state: "idle", remount: true },
  { name: "duplicate queued echo", state: "steerable", statuses: [{ status: "queued" }, { status: "delivered" }], statusReads: 2 },
];

test.each(scenarios)("delivery owner: $name", async (scenario) => {
  let persisted = "keep this exact draft";
  let remounted: ComposerDelivery | undefined;
  let releaseSend: (() => void) | undefined;
  const heldSend = new Promise<void>((resolve) => { releaseSend = resolve; });
  const statuses = [...(scenario.statuses ?? [])];
  let statusReads = 0;
  const deliveryIds: string[] = [];
  const methods: Array<{ method: "send" | "steer"; deliveryId: string }> = [];
  const draftsWhileQueued: string[] = [];

  const client = {
    request: async (method: string, params?: { delivery_id?: string }) => {
      if (method === "send" || method === "steer") {
        methods.push({ method, deliveryId: params?.delivery_id ?? "" });
        if (scenario.remount && method === "send") await heldSend;
        const firstRace = methods.length === 1 && (
          (scenario.race === "send-to-steer" && method === "send") ||
          ((scenario.race === "steer-to-send" || scenario.race === "double-rejection") && method === "steer") ||
          (scenario.race === "double-rejection" && method === "send")
        );
        if (firstRace || (scenario.race === "double-rejection" && methods.length === 2)) {
          const error = new Error(method === "send" ? "a turn is already running" : "no turn is running") as Error & { code: number };
          error.code = method === "send" ? -32004 : -32005;
          throw error;
        }
        return { accepted: true };
      }
      if (method !== "delivery_status") throw new Error(`unexpected ${method}`);
      statusReads += 1;
      const status = statuses.shift() ?? { status: "queued" };
      if (scenario.draftWhileQueued && status.status === "queued") draftsWhileQueued.push(owner.getModel().draft, persisted);
      return status;
    },
  };

  const options = {
    state: scenario.state,
    defaultValue: persisted,
    onDraftChange: (text: string) => { persisted = text; },
    onDraftSubmit: (sent: string) => { persisted = persisted.startsWith(sent) ? persisted.slice(sent.length) : persisted; },
    onSubmit: async (text: string, intent: { steer: boolean }, track: (id: string) => void) => {
      const id = `delivery-${deliveryIds.length + 1}`;
      deliveryIds.push(id);
      await deliverChatMessage(client as never, "session", text, id, intent.steer, track, async () => undefined);
    },
  };
  const owner = createComposerDelivery(options);
  const detach = owner.attach();

  try {
    const pending = owner.submit();
    // enter took the text out of the box and out of the stored draft at once
    expect(owner.getModel().draft).toBe("");
    expect(persisted).toBe("");
    if (scenario.remount) {
      remounted = createComposerDelivery({ ...options, defaultValue: persisted });
      remounted.edit(" plus new");
      releaseSend?.();
    }
    await pending;

    expect(owner.getModel().draft).toBe("");
    expect(persisted).toBe(scenario.remount ? " plus new" : "");
    // zeta refused it: the failed row holds nothing on zeta's side, so it is not held and edit stays
    expect(owner.getModel().queue).toEqual(scenario.expectedFailure ? [{ id: 1, text: "keep this exact draft", failed: scenario.expectedFailure, tries: 1 }] : []);
    if (scenario.retryDropped) {
      await owner.retry(1);
      expect(deliveryIds).toEqual(["delivery-1", "delivery-2"]);
      expect(owner.getModel().queue).toEqual([]);
      owner.edit("keep this exact draft");
      await owner.submit();
      expect(owner.getModel()).toMatchObject({ draft: "", queue: [{ text: "keep this exact draft", failed: dropped }] });
    }
    if (scenario.remount) expect(remounted?.getModel().draft).toBe(" plus new");
    if (scenario.statusReads) expect(statusReads).toBe(scenario.statusReads);
    if (scenario.draftWhileQueued) expect(draftsWhileQueued).toEqual(Array(4).fill(""));
    if (scenario.expectedMethods) {
      expect(methods.map(({ method }) => method)).toEqual(scenario.expectedMethods);
      expect(new Set(methods.map(({ deliveryId }) => deliveryId)).size).toBe(1);
    }
  } finally {
    detach();
    releaseSend?.();
  }
});

// a send the test releases by hand; `sent` lists every text in call order
function heldSends() {
  const sent: string[] = [];
  const releases: Array<(failure?: Error) => void> = [];
  const onSubmit = (text: string) => {
    sent.push(text);
    return new Promise<void>((resolve, reject) => { releases.push((failure) => failure ? reject(failure) : resolve()); });
  };
  const release = async (failure?: Error) => { releases.shift()!(failure); await ticks(); };
  return { sent, onSubmit, release };
}
const ticks = async () => { for (let tick = 0; tick < 5; tick += 1) await Promise.resolve(); };

const owner = (onSubmit: (text: string) => Promise<void>, extra: Partial<Parameters<typeof createComposerDelivery>[0]> = {}) => createComposerDelivery({
  state: "idle", defaultValue: "first", onDraftChange: () => {}, onDraftSubmit: () => {}, onSubmit, ...extra,
});

test("enter takes the text out of the box at once: the box is always a new message, and a submitted message goes out once", async () => {
  const sends = heldSends();
  const composer = owner(sends.onSubmit, { state: "steerable" });
  composer.attach();
  void composer.submit();
  expect(sends.sent).toEqual(["first"]);
  expect(composer.getModel().draft).toBe("");
  // the in-flight message is the first row of the list
  expect(composer.getModel().queue).toMatchObject([{ text: "first" }]);
  composer.edit("firsx"); // typing now never edits the message already submitted
  void composer.submit();
  await sends.release();
  await sends.release();
  expect(sends.sent).toEqual(["first", "firsx"]);
  expect(composer.getModel()).toMatchObject({ draft: "", queue: [] });
});

// What the user does, and what the test checks, against the chat queue owner (`chatQueues`):
// enter (type the text, press Enter), ok / fail / refuse (the oldest send: zeta takes it / zeta took it but the socket
// closed before its answer / zeta refuses it with an error code), x / esc / retry / edit (row buttons and keys),
// remount (the chat's composer remounts), switch (another chat's composer replaces it), created (the first message of
// the page's new chat created chat `s1`: the composer key changes from new:<page> to s1), unsent (an older chat of the page
// that never got its first message opens; App offers it the new-chat owner like any unsent chat), made (that create
// happens while another chat shows), reload (the page loads again: memory and sends in flight are gone, browser storage
// stays), transcript (zeta's transcript shows the user message sent with that text's delivery id), full (browser storage
// refuses every write from now on), old (#155 kept this text as the page's first message under its old key),
// offline / online (from now on a send fails before it reaches zeta, like "zeta is not connected" or page tools refreshing,
// or works again), evict (the oldest send: zeta answers its reused id as taken and then forgotten, -32010 delivered),
// legacy (storage holds the rows as a page from before `held` wrote them: the id as `deliveryId`, with this failed text),
// rows / box / sent (checks; `sent` lists the sends zeta took: a send with a delivery id zeta already has is dropped).
// a rows entry is "held" for a failed row zeta may hold (no edit, retry reuses its id), "failed" for one it does not.
type Step =
  | ["enter" | "type" | "x" | "retry" | "edit" | "switch" | "unsent" | "fail" | "refuse" | "transcript" | "old" | "drop" | "legacy", string]
  | ["ok" | "esc" | "remount" | "created" | "made" | "reload" | "full" | "offline" | "online" | "evict"]
  | ["turn", "running" | "idle"]
  | ["rows", string[]]
  | ["box", string]
  | ["sent", string[]];
type QueueCase = { name: string; steps: Step[]; sent: string[]; rows?: string[] };

const queueCases: QueueCase[] = [
  { name: "success", steps: [["enter", "first"], ["rows", ["sending first"]], ["ok"]], sent: ["a:first"] },
  {
    name: "two enters in a row: both queue in order, none lost, each goes out once",
    steps: [["enter", "first"], ["enter", "second"], ["enter", "third"], ["box", ""], ["rows", ["sending first", "queued second", "queued third"]], ["ok"], ["sent", ["a:first", "a:second"]], ["ok"], ["ok"]],
    sent: ["a:first", "a:second", "a:third"],
  },
  {
    name: "cancel with x and with esc (the last queued): never sent; esc never cancels the message in flight",
    steps: [["enter", "first"], ["enter", "second"], ["enter", "third"], ["enter", "fourth"], ["x", "third"], ["esc"], ["rows", ["sending first", "queued second"]], ["esc"], ["esc"], ["rows", ["sending first"]], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "failure: the row stays failed, nothing behind it goes out, and it is never sent again on its own",
    steps: [["enter", "first"], ["refuse", "zeta said no"], ["enter", "second"], ["box", ""]],
    sent: ["a:first"], rows: ["failed first: zeta said no", "queued second"],
  },
  {
    name: "retry goes out exactly once, also on a double click, then the rest follow",
    steps: [["enter", "first"], ["enter", "second"], ["refuse", "denied"], ["retry", "first"], ["retry", "first"], ["rows", ["sending first", "queued second"]], ["refuse", "denied again"], ["rows", ["failed first: denied again (2 tries)", "queued second"]], ["retry", "first"], ["ok"], ["ok"]],
    sent: ["a:first", "a:first", "a:first", "a:second"],
  },
  {
    name: "edit puts a failed message back in the box and removes its row; it is not sent",
    steps: [["enter", "first"], ["refuse", "denied"], ["edit", "first"], ["box", "first"]],
    sent: ["a:first"],
  },
  {
    name: "edit of a failed first message holds the rows behind it until the edited text is sent; it goes first",
    steps: [["enter", "first"], ["enter", "second"], ["refuse", "denied"], ["edit", "first"], ["rows", ["queued second"]], ["sent", ["a:first"]], ["enter", "first fixed"], ["ok"], ["ok"]],
    sent: ["a:first", "a:first fixed", "a:second"],
  },
  {
    name: "clearing the edited text of a failed first message sends nothing; the held rows wait for the next enter",
    steps: [["enter", "first"], ["enter", "second"], ["refuse", "denied"], ["edit", "first"], ["type", ""], ["sent", ["a:first"]], ["rows", ["queued second"]], ["enter", "first again"], ["ok"], ["ok"]],
    sent: ["a:first", "a:first again", "a:second"],
  },
  {
    name: "enter on an empty box after an edit lets the held rows go",
    steps: [["enter", "first"], ["enter", "second"], ["refuse", "denied"], ["edit", "first"], ["type", ""], ["enter", ""], ["ok"]],
    sent: ["a:first", "a:second"],
  },
  {
    name: "remount while sending: the send settles once, the row goes away",
    steps: [["enter", "first"], ["remount"], ["rows", ["sending first"]], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "chat switch while sending: the send settles while away, nothing more goes out",
    steps: [["enter", "first"], ["switch", "b"], ["ok"], ["switch", "a"]],
    sent: ["a:first"],
  },
  {
    name: "chat switch while queued: nothing goes out while away, the queue goes out on return, once, in order",
    steps: [["enter", "first"], ["enter", "second"], ["switch", "b"], ["ok"], ["sent", ["a:first"]], ["switch", "a"], ["rows", ["sending second"]], ["ok"]],
    sent: ["a:first", "a:second"],
  },
  {
    name: "remount with a failed row: the row stays failed and is not sent again",
    steps: [["enter", "first"], ["fail", "closed"], ["remount"]],
    sent: ["a:first"], rows: [`held first: ${MAYBE_SENT}`],
  },
  {
    name: "chat switch with a failed row: the row stays failed and is not sent again",
    steps: [["enter", "first"], ["fail", "closed"], ["switch", "b"], ["switch", "a"]],
    sent: ["a:first"], rows: [`held first: ${MAYBE_SENT}`],
  },
  {
    name: "a send that fails while away shows as failed on return and is not sent again",
    steps: [["enter", "first"], ["enter", "second"], ["switch", "b"], ["fail", "closed"], ["switch", "a"]],
    sent: ["a:first"], rows: [`held first: ${MAYBE_SENT}`, "queued second"],
  },
  {
    name: "new chat: the key changes during the first send; the rest goes to the created chat, once, after it",
    steps: [["switch", "new"], ["enter", "first"], ["enter", "second"], ["created"], ["rows", ["sending first", "queued second"]], ["sent", ["new:first"]], ["ok"], ["ok"]],
    sent: ["new:first", "s1:second"],
  },
  {
    name: "new chat: the first send fails after the key changed; it shows failed in the created chat",
    steps: [["switch", "new"], ["enter", "first"], ["enter", "second"], ["created"], ["fail", "closed"]],
    sent: ["new:first"], rows: [`held first: ${MAYBE_SENT}`, "queued second"],
  },
  {
    name: "new chat left while its first send runs: the rest go to the created chat when it opens, once",
    steps: [["switch", "new"], ["enter", "first"], ["enter", "second"], ["made"], ["switch", "b"], ["ok"], ["sent", ["new:first"]], ["switch", "s1"], ["rows", ["sending second"]], ["ok"]],
    sent: ["new:first", "s1:second"],
  },
  // a page load keeps every unsent row, as its own failed row: shown, never sent before the user acts, never merged into the box
  {
    name: "send fails after zeta took it, then a reload: the row is back as maybe sent; retry reuses its id, so zeta keeps one copy",
    steps: [["enter", "first"], ["fail", "closed"], ["reload"], ["rows", [`held first: ${MAYBE_SENT}`]], ["box", ""], ["sent", ["a:first"]], ["retry", "first"], ["ok"]],
    sent: ["a:first"],
  },
  // a send zeta took whose answer never came (the socket closed): the row keeps the delivery id, so a retry cannot make a second copy
  {
    name: "zeta took it, then the socket closed before its answer: the row says it may not have been sent; the transcript clears it",
    steps: [["enter", "first"], ["fail", "closed"], ["rows", [`held first: ${MAYBE_SENT}`]], ["transcript", "first"]],
    sent: ["a:first"],
  },
  {
    name: "zeta took it, then the socket closed before its answer, then retry: the retry has the same delivery id, so zeta keeps one copy",
    steps: [["enter", "first"], ["fail", "closed"], ["retry", "first"], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "reload while sending, zeta took it: no row",
    steps: [["enter", "first"], ["reload"], ["rows", [`held first: ${MAYBE_SENT}`]], ["transcript", "first"]],
    sent: ["a:first"],
  },
  {
    name: "reload while sending, zeta took it, a second reload before the transcript shows it: the row still clears",
    steps: [["enter", "first"], ["reload"], ["type", "x"], ["reload"], ["rows", [`held first: ${MAYBE_SENT}`]], ["transcript", "first"]],
    sent: ["a:first"],
  },
  {
    name: "reload while sending, zeta took it, then retry: the retry has the same delivery id, so zeta drops the copy",
    steps: [["enter", "first"], ["reload"], ["retry", "first"], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "reload while sending, zeta took it, then dropped it (abort), retry: zeta answers the old id as dropped, so it goes out once more with a new id",
    steps: [["enter", "first"], ["reload"], ["drop", "first"], ["retry", "first"], ["sent", ["a:first (dropped)", "a:first"]], ["rows", ["sending first"]], ["ok"]],
    sent: ["a:first (dropped)", "a:first"],
  },
  {
    name: "maybe sent, retried while a turn runs (it waits, not in flight), then a reload: still maybe sent with its id, no edit, so it goes out once",
    steps: [["enter", "first"], ["fail", "closed"], ["turn", "running"], ["retry", "first"], ["rows", ["queued first"]], ["reload"], ["rows", [`held first: ${MAYBE_SENT}`]], ["edit", "first"], ["box", ""], ["turn", "idle"], ["retry", "first"], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "storage refuses writes: a failed row stays in memory across a chat switch",
    steps: [["full"], ["enter", "first"], ["fail", "closed"], ["switch", "b"], ["switch", "a"]],
    sent: ["a:first"], rows: [`held first: ${MAYBE_SENT}`],
  },
  {
    name: "#155 kept a first message under its old key: a page load shows it once as an unsent row of the new-chat box",
    steps: [["old", "first"], ["reload"], ["reload"], ["switch", "new"], ["rows", [`failed first: ${NOT_SENT}`]]],
    sent: [], rows: [`failed first: ${NOT_SENT}`],
  },
  {
    name: "reload while sending, zeta did not take it: a failed row says it may not have been sent; the queued row behind it is failed too",
    steps: [["enter", "first"], ["enter", "second"], ["reload"], ["sent", ["a:first"]]],
    sent: ["a:first"], rows: [`held first: ${MAYBE_SENT}`, `failed second: ${NOT_SENT}`],
  },
  {
    name: "edit, then a reload: the text is in the box once, with no row",
    steps: [["enter", "first"], ["refuse", "denied"], ["edit", "first"], ["reload"], ["box", "first"]],
    sent: ["a:first"],
  },
  {
    name: "x, then a reload: gone",
    steps: [["enter", "first"], ["fail", "closed"], ["x", "first"], ["reload"], ["box", ""]],
    sent: ["a:first"],
  },
  {
    name: "the box holds a longer text that contains the row's text: both stay, nothing merged or lost",
    steps: [["enter", "hi"], ["fail", "closed"], ["type", "the hi draft"], ["reload"], ["box", "the hi draft"], ["retry", "hi"], ["ok"]],
    sent: ["a:hi"],
  },
  {
    name: "the row holds a longer text that contains the box text: both stay, nothing merged or lost",
    steps: [["enter", "the hi draft"], ["fail", "closed"], ["type", "hi"], ["reload"], ["box", "hi"]],
    sent: ["a:the hi draft"], rows: [`held the hi draft: ${MAYBE_SENT}`],
  },
  {
    name: "the same text twice stays two rows; each goes out once on its own retry",
    steps: [["enter", "same"], ["enter", "same"], ["fail", "closed"], ["reload"], ["rows", [`held same: ${MAYBE_SENT}`, `failed same: ${NOT_SENT}`]], ["retry", "same"], ["ok"], ["rows", [`failed same: ${NOT_SENT}`]], ["sent", ["a:same"]], ["retry", "same"], ["ok"]],
    sent: ["a:same", "a:same"],
  },
  {
    name: "two chats with the same text: x in one keeps the other's row",
    steps: [["switch", "b"], ["enter", "same"], ["fail", "closed"], ["switch", "a"], ["enter", "same"], ["fail", "closed"], ["x", "same"], ["reload"], ["rows", []], ["switch", "b"]],
    sent: ["b:same", "a:same"], rows: [`held same: ${MAYBE_SENT}`],
  },
  {
    name: "a refused new chat, then a reload: the row waits in the new-chat box; the chat created later takes it and retry sends it there once",
    steps: [["switch", "new"], ["enter", "first"], ["refuse", "another chat is still running"], ["reload"], ["rows", ["failed first: another chat is still running"]], ["created"], ["rows", ["failed first: another chat is still running"]], ["sent", ["new:first"]], ["retry", "first"], ["ok"]],
    sent: ["new:first", "s1:first"],
  },
  {
    name: "a refused new chat, then a reload that opens another chat: a chat created later takes the row from storage",
    steps: [["switch", "new"], ["enter", "first"], ["refuse", "busy"], ["reload"], ["switch", "b"], ["made"], ["switch", "s1"], ["rows", ["failed first: busy"]], ["sent", ["new:first"]], ["retry", "first"], ["ok"]],
    sent: ["new:first", "s1:first"],
  },
  {
    name: "a create that opens a chat with rows of its own (a stale create maps the home chat): both sets of rows stay",
    steps: [["switch", "s1"], ["enter", "older"], ["fail", "closed"], ["switch", "new"], ["enter", "first"], ["refuse", "busy"], ["made"], ["reload"], ["rows", ["failed first: busy"]], ["switch", "s1"]],
    sent: ["s1:older", "new:first"], rows: [`held older: ${MAYBE_SENT}`],
  },
  {
    name: "the first send of a new chat fails after its chat was created, then a reload: the row is in that chat",
    steps: [["switch", "new"], ["enter", "first"], ["created"], ["fail", "closed"], ["reload"]],
    sent: ["new:first"], rows: [`held first: ${MAYBE_SENT}`],
  },
  // one field says zeta may hold a row's text (`held`): set when its send may reach zeta, cleared only by zeta's answer
  // about that id. every failure below that is not that answer keeps it, so edit never offers held text for a new id.
  {
    name: "maybe sent, then a retry fails before zeta is asked (not connected): still held, no edit; the next retry goes once",
    steps: [["enter", "first"], ["fail", "closed"], ["offline"], ["retry", "first"], ["edit", "first"], ["box", ""], ["rows", ["held first: zeta is not connected (2 tries)"]], ["online"], ["retry", "first"], ["retry", "first"], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "maybe sent, a retry fails before zeta is asked, then a reload: still held, no edit",
    steps: [["enter", "first"], ["fail", "closed"], ["offline"], ["retry", "first"], ["reload"], ["rows", ["held first: zeta is not connected (2 tries)"]], ["edit", "first"], ["box", ""], ["online"], ["retry", "first"], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "a new message fails before zeta is asked: zeta has nothing, so edit puts it back in the box",
    steps: [["offline"], ["enter", "first"], ["rows", ["failed first: zeta is not connected"]], ["edit", "first"], ["box", "first"]],
    sent: [],
  },
  {
    name: "maybe sent, a retry zeta refuses before it checks the id (no active session): still held, no edit",
    steps: [["enter", "first"], ["fail", "closed"], ["retry", "first"], ["refuse", "no active session"], ["edit", "first"], ["box", ""], ["rows", ["held first: no active session (2 tries)"]], ["retry", "first"], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "maybe sent, a retry zeta answers as taken then forgotten (-32010 delivered): the row goes, nothing more is sent",
    steps: [["enter", "first"], ["reload"], ["retry", "first"], ["evict"], ["rows", []]],
    sent: ["a:first"],
  },
  {
    name: "zeta dropped it, the one resend with a fresh id gets no answer: held under the fresh id, also after a reload",
    steps: [["enter", "first"], ["reload"], ["drop", "first"], ["retry", "first"], ["fail", "closed"], ["reload"], ["rows", [`held first: ${MAYBE_SENT}`]], ["edit", "first"], ["box", ""], ["retry", "first"], ["ok"]],
    sent: ["a:first (dropped)", "a:first"],
  },
  {
    name: "zeta dropped it, then refused the one resend with a fresh id: it holds nothing, so edit is back",
    steps: [["enter", "first"], ["reload"], ["drop", "first"], ["retry", "first"], ["refuse", "denied"], ["rows", ["failed first: denied"]], ["edit", "first"], ["box", "first"]],
    sent: ["a:first (dropped)", "a:first"],
  },
  {
    name: "a maybe-sent row a page from before `held` kept: held, no edit; retry goes once",
    steps: [["enter", "first"], ["fail", "closed"], ["legacy", MAYBE_SENT], ["reload"], ["rows", [`held first: ${MAYBE_SENT}`]], ["edit", "first"], ["box", ""], ["retry", "first"], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "a not-sent row with an id a page from before `held` kept: held, no edit; retry goes once",
    steps: [["enter", "first"], ["fail", "closed"], ["legacy", NOT_SENT], ["reload"], ["rows", [`held first: ${NOT_SENT}`]], ["edit", "first"], ["box", ""], ["retry", "first"], ["ok"]],
    sent: ["a:first"],
  },
  {
    name: "unsent other chat opened while a new chat is created: the new-chat queue does not move",
    steps: [["switch", "new"], ["enter", "first"], ["enter", "second"], ["unsent", "s0"], ["rows", []], ["ok"]],
    sent: ["new:first"],
  },
];

test.each(queueCases)("chat queue owner: $name", async ({ name, steps, sent: expectedSent, rows: expectedRows = [] }) => {
  let sends = heldSends();
  const sent: string[] = [];
  const deliveries = new Map<string, string>();
  const previousStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  let full = false;
  let turn: "running" | "idle" = "idle";
  let offline = false;
  const refuse = () => { if (full) throw new Error("quota exceeded"); };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { refuse(); values.set(key, value); }, removeItem: (key: string) => { refuse(); values.delete(key); },
  } });
  const taken = new Set<string>();
  const dropped = new Set<string>();
  let nextDelivery = 0;
  // one page load's owners; a reload starts new ones over the same storage
  let queues = createChatQueues();
  // chat ids are unique to this case; drafts are kept by the module's draft store, like the browser keeps them
  const key = (chat: string) => chat === "new" ? `new:${name}` : `${name}/${chat}`;
  const mount = (chat: string, fromNewChat?: string) => {
    const pageSends = sends;
    const owner = queues.open(key(chat), {
      state: turn,
      defaultValue: draftStore.get(key(chat)),
      onDraftChange: (text) => draftStore.set(key(chat), text),
      onDraftSubmit: (text) => draftStore.confirm(key(chat), text),
      // the real delivery code over a fake zeta that answers a reused id like delivery.py `_duplicate`
      onSubmit: async (text, intent, track) => {
        if (offline) throw new Error("zeta is not connected");
        const zeta = { request: async (_method: string, params: { delivery_id: string }) => {
          const deliveryId = params.delivery_id;
          if (dropped.has(deliveryId)) return { accepted: false, duplicate: true, status: "dropped" };
          const duplicate = taken.has(deliveryId);
          if (!duplicate) sent.push(`${chat}:${text}`);
          taken.add(deliveryId);
          // zeta's own error (a refusal) records no new delivery, so a new id is free again (a reused one stays as zeta took it
          // first); a closed socket keeps what zeta took, and -32010 is zeta's answer that it took the id
          await pageSends.onSubmit(text).catch((failure: { code?: unknown }) => { if (typeof failure.code === "number" && failure.code !== -32010 && !duplicate) taken.delete(deliveryId); throw failure; });
          return { accepted: true, ...(duplicate ? { duplicate } : {}) };
        } };
        const track_ = (deliveryId: string) => { deliveries.set(text, deliveryId); track(deliveryId); };
        await deliverChatMessage(zeta as never, key(chat), text, (intent as SendIntent).deliveryId ?? `delivery ${++nextDelivery}`, false, track_, async () => undefined);
      },
    }, fromNewChat && key(fromNewChat));
    return { chat, owner, mounted: () => { const detach = owner.attach(); owner.sync(turn, draftStore.get(key(chat))); return detach; } };
  };
  // like a React commit: the next composer renders (and opens its owner), the old one detaches, the next attaches, then settle
  let view = mount("a");
  let detach = view.mounted();
  const replace = (chat: string, fromNewChat?: string) => {
    const next = mount(chat, fromNewChat);
    detach();
    detach = next.mounted();
    view = next;
    queues.settle();
  };
  const rowOf = (text: string) => view.owner.getModel().queue.find((item) => item.text === text)!.id;
  const rows = () => {
    const model = view.owner.getModel();
    return model.queue.map((item) => item.failed ? `${item.held ? "held" : "failed"} ${item.text}: ${item.failed}${(item.tries ?? 1) > 1 ? ` (${item.tries} tries)` : ""}` : `${item === inFlight(model) ? "sending" : "queued"} ${item.text}`);
  };
  try {
    for (const step of steps) {
      switch (step[0]) {
        case "enter": view.owner.edit(step[1]); void view.owner.submit(); break;
        case "type": view.owner.edit(step[1]); break;
        case "ok": await sends.release(); break;
        case "fail": await sends.release(new Error(step[1])); break;
        case "refuse": await sends.release(Object.assign(new Error(step[1]), { code: -32003 })); break;
        case "x": view.owner.cancel(rowOf(step[1])); break;
        case "esc": view.owner.cancel(); break;
        case "retry": void view.owner.retry(rowOf(step[1])); break;
        case "edit": view.owner.restore(rowOf(step[1])); break;
        case "remount": replace(view.chat); break;
        case "switch": replace(step[1]); break;
        case "unsent": replace(step[1], "new"); break;
        case "created": queues.created(key("new"), key("s1")); replace("s1", "new"); break;
        case "made": queues.created(key("new"), key("s1")); break;
        // the old page's sends never answer, and its owners are gone
        case "reload": detach(); sends = heldSends(); queues = createChatQueues(); view = mount(view.chat); detach = view.mounted(); break;
        case "transcript": view.owner.echo(deliveries.get(step[1])!); break;
        // zeta dropped what it took (a steer at abort): it holds nothing, and a reused id is answered as dropped
        case "drop": { const at = sent.lastIndexOf(`${view.chat}:${step[1]}`); sent[at] += " (dropped)"; dropped.add(deliveries.get(step[1])!); break; }
        case "full": full = true; break;
        case "offline": offline = true; break;
        case "online": offline = false; break;
        case "evict": await sends.release(Object.assign(new Error("delivery id already used"), { code: -32010, data: { outcome: "delivered" } })); break;
        case "legacy": for (const [stored, value] of values) {
          if (!stored.endsWith(key(view.chat))) continue;
          const { rows: kept } = JSON.parse(value) as { rows: Array<{ held?: string }> };
          values.set(stored, JSON.stringify({ rows: kept.map(({ held, ...row }) => ({ ...row, failed: step[1], deliveryId: held })) }));
        } break;
        case "turn": turn = step[1]; replace(view.chat); break;
        case "old": values.set("achilles-pending-create-texts", JSON.stringify({ [name]: step[1] })); break;
        case "rows": expect(rows()).toEqual(step[1]); break;
        case "box": expect(view.owner.getModel().draft).toBe(step[1]); break;
        case "sent": expect(sent).toEqual(step[1]); break;
      }
      await ticks();
    }
    expect(sent).toEqual(expectedSent);
    expect(rows()).toEqual(expectedRows);
  } finally {
    detach();
    queues.settle();
    for (const chat of ["a", "b", "new", "s0", "s1"]) draftStore.set(key(chat), "");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: previousStorage });
  }
});
