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
  expectedDraft: string;
  expectedError?: string;
  resendDropped?: boolean;
};

const scenarios: Scenario[] = [
  { name: "send ok", state: "idle", expectedDraft: "" },
  // zeta started the turn that carries an end-of-turn steer, so send gets -32004: one steer retry with the same delivery id
  { name: "send rejected after turn_end", state: "idle", race: "send-to-steer", expectedMethods: ["send", "steer"], statuses: [{ status: "queued" }, { status: "queued" }, { status: "delivered" }], statusReads: 3, draftWhileQueued: true, expectedDraft: "" },
  { name: "send rejected after turn_end, steer dropped", state: "idle", race: "send-to-steer", expectedMethods: ["send", "steer"], statuses: [{ status: "dropped" }], statusReads: 1, expectedDraft: "keep this exact draft", expectedError: "this message was not sent. your text is still here; press send to try again." },
  { name: "steer rejected after turn ends", state: "steerable", race: "steer-to-send", expectedMethods: ["steer", "send"], expectedDraft: "" },
  { name: "fallback is not retried", state: "idle", race: "double-rejection", expectedMethods: ["send", "steer"], expectedDraft: "keep this exact draft", expectedError: "no turn is running" },
  { name: "steer consumed", state: "steerable", statuses: [{ status: "delivered" }], statusReads: 1, expectedDraft: "" },
  {
    name: "steer dropped",
    state: "steerable",
    statuses: [{ status: "queued" }, { status: "dropped" }, { status: "delivered" }, { status: "dropped" }],
    statusReads: 4,
    expectedDraft: "keep this exact draft",
    expectedError: "this message was not sent. your text is still here; press send to try again.",
    resendDropped: true,
  },
  { name: "steer evicted after consumption", state: "steerable", statuses: [{ status: "evicted", outcome: "delivered" }], statusReads: 1, expectedDraft: "" },
  { name: "reload or remount during delivery", state: "idle", remount: true, expectedDraft: " plus new" },
  { name: "duplicate queued echo", state: "steerable", statuses: [{ status: "queued" }, { status: "delivered" }], statusReads: 2, expectedDraft: "" },
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
    onDeliveryConfirm: (sent: string) => {
      persisted = persisted.startsWith(sent) ? persisted.slice(sent.length) : persisted;
      remounted?.sync(scenario.state, persisted);
    },
    onSubmit: async (text: string, intent: { steer: boolean }, track: (id: string) => void) => {
      const id = `delivery-${deliveryIds.length + 1}`;
      deliveryIds.push(id);
      await deliverChatMessage(client as never, "session", text, id, intent.steer, track);
    },
  };
  const owner = createComposerDelivery(options);

  try {
    const pending = owner.submit();
    if (scenario.remount) {
      remounted = createComposerDelivery({ ...options, defaultValue: persisted });
      remounted.edit("keep this exact draft plus new");
      releaseSend?.();
    }
    await pending;

    expect(owner.getModel().draft).toBe(scenario.remount ? "" : scenario.expectedDraft);
    expect(persisted).toBe(scenario.expectedDraft);
    expect(owner.getModel().error?.text).toBe(scenario.expectedError);
    if (scenario.resendDropped) {
      expect(owner.getModel().error?.kind).toBe("dropped");
      await owner.submit();
      expect(deliveryIds).toEqual(["delivery-1", "delivery-2"]);
      expect(owner.getModel().draft).toBe("");
      owner.edit("keep this exact draft");
      await owner.submit();
      expect(owner.getModel().draft).toBe("keep this exact draft");
      expect(owner.getModel().error?.kind).toBe("dropped");
    }
    if (scenario.remount) expect(remounted?.getModel().draft).toBe(scenario.expectedDraft);
    if (scenario.statusReads) expect(statusReads).toBe(scenario.statusReads);
    if (scenario.draftWhileQueued) expect(draftsWhileQueued).toEqual(Array(4).fill("keep this exact draft"));
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
  state: "idle", defaultValue: "first", onDraftChange: () => {}, onDeliveryConfirm: () => {}, onSubmit, ...extra,
});

test("enter during a pending send delivers the next draft once, in order, after the first settles", async () => {
  const sent: string[] = [];
  let release!: (failure?: Error) => void;
  const first = new Promise<void>((resolve, reject) => { release = (failure) => failure ? reject(failure) : resolve(); });
  const owner = createComposerDelivery({
    state: "idle",
    defaultValue: "first",
    onDraftChange: () => {},
    onDeliveryConfirm: () => {},
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

test("two enters in a row while a send is pending: both go out once, in order, each as its own send", async () => {
  const sends = heldSends();
  const composer = owner(sends.onSubmit);
  void composer.submit();
  composer.edit("second"); void composer.submit();
  composer.edit("third"); void composer.submit();
  expect(composer.getModel()).toMatchObject({ draft: "", queue: [{ text: "second" }, { text: "third" }] });
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
  const [, third] = composer.getModel().queue;
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

test("a failed send from the box holds the queue until a send from the box succeeds", async () => {
  const sends = heldSends();
  const composer = owner(sends.onSubmit);
  void composer.submit();
  composer.edit("first\nsecond"); void composer.submit();
  await sends.release(new Error("denied"));
  expect(sends.sent).toEqual(["first"]);
  expect(composer.getModel()).toMatchObject({ draft: "first", held: true, error: { kind: "submit", text: "denied" }, queue: [{ text: "second" }] });
  void composer.submit(); // enter on the failed text sends it again, ahead of the queue
  await sends.release();
  await sends.release();
  expect(sends.sent).toEqual(["first", "first", "second"]);
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
