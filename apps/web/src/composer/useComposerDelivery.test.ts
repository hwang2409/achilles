import { expect, test } from "bun:test";
import { deliverChatMessage } from "../useActiveChat";
import { chatQueues } from "./chatQueues";
import { createComposerDelivery, type ComposerDelivery } from "./useComposerDelivery";

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
      await deliverChatMessage(client as never, "session", text, id, intent.steer, track);
    },
  };
  const owner = createComposerDelivery(options);

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
  const release = async (failure?: Error) => { releases.shift()!(failure); for (let tick = 0; tick < 5; tick += 1) await Promise.resolve(); };
  return { sent, onSubmit, release };
}

const owner = (onSubmit: (text: string) => Promise<void>, extra: Partial<Parameters<typeof createComposerDelivery>[0]> = {}) => createComposerDelivery({
  state: "idle", defaultValue: "first", onDraftChange: () => {}, onDraftSubmit: () => {}, onSubmit, ...extra,
});

test("enter during a pending send delivers the next draft once, in order, after the first settles", async () => {
  const sent: string[] = [];
  let release!: (failure?: Error) => void;
  const first = new Promise<void>((resolve, reject) => { release = (failure) => failure ? reject(failure) : resolve(); });
  const owner = createComposerDelivery({
    state: "idle",
    defaultValue: "first",
    onDraftChange: () => {},
    onDraftSubmit: () => {},
    onSubmit: async (text: string) => { sent.push(text); if (sent.length === 1) await first; },
  });
  const pending = owner.submit();
  owner.edit("second");
  const second = owner.submit();
  expect(sent).toEqual(["first"]);
  release();
  await Promise.all([pending, second]);
  expect(sent).toEqual(["first", "second"]);
  expect(owner.getModel()).toMatchObject({ draft: "", sending: false, queue: [] });
});

test("enter takes the text out of the box at once: the box is always a new message, and a submitted message goes out once", async () => {
  const sends = heldSends();
  const composer = owner(sends.onSubmit, { state: "steerable" });
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

test("two enters in a row while a send is pending: both go out once, in order, each as its own send", async () => {
  const sends = heldSends();
  const composer = owner(sends.onSubmit);
  void composer.submit();
  composer.edit("second"); void composer.submit();
  composer.edit("third"); void composer.submit();
  expect(composer.getModel()).toMatchObject({ draft: "", queue: [{ text: "first" }, { text: "second" }, { text: "third" }] });
  await sends.release();
  expect(sends.sent).toEqual(["first", "second"]);
  await sends.release();
  await sends.release();
  expect(sends.sent).toEqual(["first", "second", "third"]);
  expect(composer.getModel()).toMatchObject({ draft: "", sending: false, queue: [] });
});

test("a message canceled with x or with esc is never sent", async () => {
  const sends = heldSends();
  const composer = owner(sends.onSubmit);
  void composer.submit();
  for (const text of ["second", "third", "fourth"]) { composer.edit(text); void composer.submit(); }
  const third = composer.getModel().queue.find((item) => item.text === "third")!;
  composer.cancel(third.id); // the x
  composer.cancel(); // esc in an empty box: the last one
  await sends.release();
  await sends.release();
  expect(sends.sent).toEqual(["first", "second"]);
  expect(composer.getModel().queue).toEqual([]);
});

test("a queued message that fails stays first with its error; nothing after it goes out until retry", async () => {
  const sends = heldSends();
  const composer = owner(sends.onSubmit);
  void composer.submit();
  for (const text of ["second", "third"]) { composer.edit(text); void composer.submit(); }
  await sends.release();
  await sends.release(new Error("zeta said no"));
  expect(sends.sent).toEqual(["first", "second"]);
  const [failed] = composer.getModel().queue;
  expect(composer.getModel().queue).toMatchObject([{ text: "second", failed: "zeta said no" }, { text: "third" }]);
  void composer.retry(failed.id);
  await sends.release();
  await sends.release();
  expect(sends.sent).toEqual(["first", "second", "second", "third"]);
  expect(composer.getModel().queue).toEqual([]);
});

test("a failed message stays a row and never comes back on its own; retry counts tries, and edit puts its text back in the box", async () => {
  const sends = heldSends();
  const composer = owner(sends.onSubmit);
  void composer.submit();
  composer.edit("typed meanwhile");
  await sends.release(new Error("denied"));
  expect(composer.getModel()).toMatchObject({ draft: "typed meanwhile", queue: [{ id: 1, text: "first", failed: "denied", tries: 1 }] });
  void composer.retry(1);
  await sends.release(new Error("denied again"));
  expect(composer.getModel().queue).toMatchObject([{ text: "first", failed: "denied again", tries: 2 }]);
  composer.restore(1);
  expect(composer.getModel()).toMatchObject({ draft: "first\ntyped meanwhile", queue: [] });
  expect(sends.sent).toEqual(["first", "first"]);
});

test("the first message of a new chat: the queue moves to the created chat and goes out there once, in order", async () => {
  const newChat = heldSends();
  const created = heldSends();
  const before = owner(newChat.onSubmit, { parkQueue: (queue) => chatQueues.park("new:page", queue) });
  const detach = before.attach();
  void before.submit();
  for (const text of ["second", "third"]) { before.edit(text); void before.submit(); }
  // the key changes from new:page to the session id while the first send is pending
  detach();
  const after = owner(created.onSubmit, { defaultValue: "", takeQueue: () => chatQueues.take(["new:page", "session-1"]) });
  after.attach();
  chatQueues.settleNewChats();
  expect(after.getModel()).toMatchObject({ waiting: true, queue: [{ text: "second" }, { text: "third" }] });
  expect(created.sent).toEqual([]);
  await newChat.release();
  await created.release();
  await created.release();
  expect(newChat.sent).toEqual(["first"]);
  expect(created.sent).toEqual(["second", "third"]);
});

test("a chat switch keeps the queue with its chat: nothing goes to another chat, and it goes out on return", async () => {
  const chatA = heldSends();
  const chatB = heldSends();
  const leaving = owner(chatA.onSubmit, { parkQueue: (queue) => chatQueues.park("chat-a", queue) });
  const detach = leaving.attach();
  void leaving.submit();
  leaving.edit("for a"); void leaving.submit();
  detach();
  await chatA.release();
  expect(chatA.sent).toEqual(["first"]); // the unmounted composer sends nothing more
  const other = owner(chatB.onSubmit, { defaultValue: "", takeQueue: () => chatQueues.take(["chat-b"]) });
  other.attach();
  await Promise.resolve();
  expect(chatB.sent).toEqual([]);
  const back = owner(chatA.onSubmit, { defaultValue: "", takeQueue: () => chatQueues.take(["chat-a"]) });
  back.attach();
  expect(back.getModel().queue).toMatchObject([{ text: "for a" }]);
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  await chatA.release();
  expect(chatA.sent).toEqual(["first", "for a"]);
  expect(chatB.sent).toEqual([]);
});
