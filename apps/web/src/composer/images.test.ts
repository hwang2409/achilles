import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRunStore } from "@fulcrum/core";
import { RunProvider } from "@fulcrum/react";
import { deliverChatMessage } from "../useActiveChat";
import { createChatQueues } from "./chatQueues";
import { createComposerModel, transition } from "./composer-machine";
import { MAX_IMAGE_BYTES, readImages, type ComposerImage } from "./images";
import { PlainComposer } from "./PlainComposer";
import { PATH_DEBOUNCE_MS, type CompletePaths } from "./pathCompletion";
import type { SendIntent } from "./useComposerDelivery";

afterEach(cleanup);

// a synthetic 1x1 png
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const pngFile = (name = "image.png") => new File([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], name, { type: "image/png" });
// a file whose reported size is over zeta's limit; a check that read it would see only these few bytes
const bigFile = () => Object.defineProperty(pngFile("big.png"), "size", { value: MAX_IMAGE_BYTES + 1 });
const image: ComposerImage = { name: "a.png", mime_type: "image/png", data: PNG };

test.each([
  ["a png is read as base64 with its name", [pngFile("shot.png")], [], { images: [{ name: "shot.png", mime_type: "image/png", data: PNG }] }],
  ["a clipboard image with a name zeta refuses is named by its type", [pngFile("bad/name.jpg")], [image], { images: [{ name: "image-2.png", mime_type: "image/png", data: PNG }] }],
  ["an unsupported type adds nothing", [new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })], [], { error: "images must be png, jpeg, gif, or webp." }],
  ["a non-image drop adds nothing", [new File(["text"], "notes.txt", { type: "text/plain" })], [], { error: "images must be png, jpeg, gif, or webp." }],
  ["a fifth image adds nothing", [pngFile()], [image, image, image, image], { error: "a message can carry at most 4 images." }],
  ["over 512 KiB in total adds nothing", [bigFile()], [], { error: "images can be at most 512 KiB in total." }],
])("%s", async (_name, files, held, expected) => {
  expect(await readImages(files, held)).toEqual(expected);
});

test("an image row waits for the running turn, then goes out as a new turn with its images", () => {
  const boxed = transition(createComposerModel("", "steerable"), { type: "add-images", images: [image] }).model;
  const waiting = transition(boxed, { type: "submit", turnRunning: true });
  expect(waiting.effect).toBeUndefined();
  expect(waiting.model).toMatchObject({ images: [], queue: [{ text: "", images: [image] }] });
  const sent = transition({ ...waiting.model, state: "idle" }, { type: "next", turnRunning: false });
  expect(sent.effect).toEqual({ type: "submit", attempt: 1, text: "", steer: false, images: [image] });
});

test("images go out as one send_images with a delivery id, and a refusal is not retried as a steer", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = { request: async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    if (calls.length === 1) return { accepted: true };
    throw Object.assign(new Error("a turn is already running"), { code: -32004 });
  } };
  await deliverChatMessage(client as never, "s1", "look", "d1", false, () => {}, async () => undefined, () => {}, [image]);
  expect(calls).toEqual([["send_images", { session_id: "s1", text: "look", images: [image], delivery_id: "d1" }]]);
  await expect(deliverChatMessage(client as never, "s1", "again", "d2", false, () => {}, async () => undefined, () => {}, [image])).rejects.toThrow("a turn is already running");
  expect(calls.map(([method]) => method)).toEqual(["send_images", "send_images"]);
});

let chatSeq = 0;
async function mount(images: boolean) {
  const sent: Array<[string, SendIntent]> = [];
  const view = render(React.createElement(RunProvider, { store: createRunStore() }, React.createElement(PlainComposer, {
    state: "idle", images, label: "message", chatId: `images-test-${chatSeq++}`, defaultValue: "",
    onSubmit: async (text: string, intent: SendIntent) => { sent.push([text, intent]); },
    onDraftChange: () => {}, onDraftSubmit: () => {},
  })));
  const field = view.getByLabelText("message", { selector: "textarea" });
  const paste = async (files: File[], text = "") => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? text : "", files } });
    await act(async () => { field.dispatchEvent(event); await new Promise((resolve) => setTimeout(resolve, 0)); });
    return event.defaultPrevented;
  };
  const enter = async () => act(async () => { fireEvent.keyDown(field, { key: "Enter" }); await Promise.resolve(); });
  return { ...view, field, paste, enter, sent };
}

test("a pasted image shows as a chip with a remove button and goes out with the message", async () => {
  const view = await mount(true);
  expect(await view.paste([pngFile("shot.png")])).toBe(true);
  expect(view.getByRole("img", { name: "shot.png" }).getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "remove image 1: shot.png" })); });
  expect(view.queryByRole("img", { name: "shot.png" })).toBeNull();
  expect(document.activeElement).toBe(view.field);

  await view.paste([pngFile("shot.png")]);
  await view.enter();
  expect(view.sent).toEqual([["", { steer: false, images: [{ name: "shot.png", mime_type: "image/png", data: PNG }] }]]);
  expect(view.queryByRole("img", { name: "shot.png" })).toBeNull();
});

test("a too-large image shows a plain error and is never sent", async () => {
  const view = await mount(true);
  await view.paste([bigFile()]);
  expect(view.getByRole("alert").textContent).toBe("images can be at most 512 KiB in total.");
  expect(view.queryByRole("img")).toBeNull();
  await view.enter();
  expect(view.sent).toEqual([]);
});

test("a text paste stays text, and an older zeta takes no image paste", async () => {
  const view = await mount(true);
  expect(await view.paste([pngFile()], "cells from a sheet")).toBe(false);
  expect(view.queryByRole("img")).toBeNull();
  cleanup();
  const old = await mount(false);
  expect(await old.paste([pngFile()])).toBe(false);
  expect(old.queryByRole("img")).toBeNull();
});

test("an image message in flight at a page reload keeps its images and delivery id for the retry", async () => {
  const previous = globalThis.localStorage;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
  } });
  const intents: SendIntent[] = [];
  const open = (queues: ReturnType<typeof createChatQueues>, onSubmit: (text: string, intent: SendIntent, track: (id: string) => void) => Promise<void>) =>
    queues.open("images-reload", { state: "idle", defaultValue: "", onDraftChange: () => {}, onDraftSubmit: () => {}, onSubmit });
  const first = open(createChatQueues(), (_text, intent, track) => { intents.push(intent); track("d1"); return new Promise(() => {}); });
  const detach = first.attach();
  try {
    first.edit("look");
    await first.addImages([pngFile("shot.png")]);
    void first.submit();
    await Promise.resolve();
    // the page reloads: its send never answers, and a new owner reads the kept row back
    const reloaded = open(createChatQueues(), async (_text, intent) => { intents.push(intent); });
    expect(reloaded.getModel().queue).toMatchObject([{ text: "look", held: "d1", images: [{ name: "shot.png", data: PNG }] }]);
    const attached = reloaded.attach();
    await reloaded.retry(1);
    attached();
    expect(intents.at(-1)).toEqual({ steer: false, deliveryId: "d1", images: [{ name: "shot.png", mime_type: "image/png", data: PNG }] });
  } finally {
    detach();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: previous });
  }
});

test("two clipboard images get remove buttons with distinct names", async () => {
  const view = await mount(true);
  await view.paste([pngFile()]);
  await view.paste([pngFile()]);
  expect(view.getAllByRole("button", { name: /^remove image/ }).map((button) => button.getAttribute("aria-label"))).toEqual(["remove image 1: image.png", "remove image 2: image.png"]);
});

test("images in the box survive a switch to another chat and back", async () => {
  const queues = createChatQueues();
  const options = { state: "idle" as const, defaultValue: "", onDraftChange: () => {}, onDraftSubmit: () => {}, onSubmit: async () => {} };
  const first = queues.open("images-switch-a", options);
  const detach = first.attach();
  await first.addImages([pngFile("shot.png")]);
  // the user opens another chat: this composer unmounts, the page settles
  const other = queues.open("images-switch-b", options);
  const detachOther = other.attach();
  detach();
  queues.settle();
  detachOther();
  const back = queues.open("images-switch-a", options);
  const attached = back.attach();
  try {
    expect(back.getModel().images).toEqual([{ name: "shot.png", mime_type: "image/png", data: PNG }]);
  } finally { attached(); }
});

test("with path completion on, an image paste adds a chip and leaves the open path list alone; enter then sends both", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = { request: async (method: string, params: Record<string, unknown>) => { calls.push([method, params]); return { accepted: true }; } };
  const completePaths: CompletePaths = async () => ({ kind: "entries", entries: [{ text: "src/", display: "@src/", kind: "directory", startPosition: -1 }], truncated: false });
  const view = render(React.createElement(RunProvider, { store: createRunStore() }, React.createElement(PlainComposer, {
    state: "idle", images: true, completePaths, label: "message", chatId: `images-test-${chatSeq++}`, defaultValue: "",
    onSubmit: (text: string, intent: SendIntent) => deliverChatMessage(client as never, "s1", text, "d1", false, () => {}, async () => undefined, () => {}, intent.images),
    onDraftChange: () => {}, onDraftSubmit: () => {},
  })));
  const field = view.getByLabelText("message", { selector: "textarea" }) as HTMLTextAreaElement;
  const options = () => view.queryAllByRole("option").map((option) => option.textContent);
  const paste = async (files: File[], text = "") => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? text : "", files } });
    await act(async () => { field.dispatchEvent(event); await new Promise((resolve) => setTimeout(resolve, 0)); });
    return event.defaultPrevented;
  };
  await act(() => { fireEvent.change(field, { target: { value: "see @s" } }); });
  await act(() => new Promise((resolve) => setTimeout(resolve, PATH_DEBOUNCE_MS + 30)));
  expect(options()).toEqual(["@src/"]);

  expect(await paste([pngFile("shot.png")])).toBe(true);
  expect(view.getByRole("img", { name: "shot.png" })).toBeTruthy();
  expect(options()).toEqual(["@src/"]);
  expect(field.value).toBe("see @s");
  // a text paste with an @ is still the field's, list open or not
  expect(await paste([], "@docs")).toBe(false);

  await act(() => { fireEvent.keyDown(field, { key: "Escape" }); });
  expect(options()).toEqual([]);
  await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(calls).toEqual([["send_images", { session_id: "s1", text: "see @s", images: [{ name: "shot.png", mime_type: "image/png", data: PNG }], delivery_id: "d1" }]]);
});
