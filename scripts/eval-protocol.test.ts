import { afterEach, expect, test } from "bun:test";
import { connectEvalProtocol, REQUIRED_FEATURES } from "./eval-protocol";

const originalWebSocket = globalThis.WebSocket;

type Listener = (event: Event | MessageEvent) => void;

class FakeWebSocket {
  static controllerClaimed = true;
  static helloErrorCode = -32001;
  static helloAttempts = 0;
  static socketConstructions = 0;
  static closeCalls = 0;
  static holdOpen = false;
  static lastSocket: FakeWebSocket | undefined;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(_url: string | URL, _protocols?: string | string[]) {
    FakeWebSocket.socketConstructions += 1;
    FakeWebSocket.lastSocket = this;
    if (!FakeWebSocket.holdOpen) queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", new Event("open"));
    });
  }

  addEventListener(type: string, listener: Listener, _options?: AddEventListenerOptions) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(raw: string) {
    const request = JSON.parse(raw);
    if (request.method !== "hello") throw new Error(`unexpected request ${request.method}`);
    const attempt = ++FakeWebSocket.helloAttempts;
    const response = FakeWebSocket.controllerClaimed
      ? { jsonrpc: "2.0", id: request.id, error: { code: FakeWebSocket.helloErrorCode, message: `claim attempt ${attempt}` } }
      : { jsonrpc: "2.0", id: request.id, result: { capabilities: { features: [...REQUIRED_FEATURES] } } };
    queueMicrotask(() => this.emit("message", new MessageEvent("message", { data: JSON.stringify(response) })));
  }

  close() {
    FakeWebSocket.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", new Event("close"));
  }

  private emit(type: string, event: Event | MessageEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    const handler = type === "message" ? this.onmessage : type === "error" ? this.onerror : type === "close" ? this.onclose : null;
    handler?.(event);
  }
}

function installFakeWebSocket(errorCode = -32001) {
  FakeWebSocket.controllerClaimed = true;
  FakeWebSocket.helloErrorCode = errorCode;
  FakeWebSocket.helloAttempts = 0;
  FakeWebSocket.socketConstructions = 0;
  FakeWebSocket.closeCalls = 0;
  FakeWebSocket.holdOpen = false;
  FakeWebSocket.lastSocket = undefined;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

afterEach(() => { globalThis.WebSocket = originalWebSocket; });

const discovery = { url: "ws://eval.invalid", controller_token: "synthetic-token" };

async function resolveBeforeDeadline<T>(operation: string, promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out`)), 1_000);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function rejectBeforeDeadline(
  operation: string,
  connecting: Promise<unknown>,
  controller: AbortController,
  cleanup: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${operation} timed out`);
      controller.abort(error);
      cleanup();
      void connecting.catch(() => {});
      reject(error);
    }, 10_000);
  });
  try {
    return await Promise.race([
      connecting.then(
        () => { throw new Error(`${operation} unexpectedly resolved`); },
        error => error,
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("reconnect waits for the previous controller claim to clear", async () => {
  installFakeWebSocket();
  const delays: number[] = [];
  let protocol: Awaited<ReturnType<typeof connectEvalProtocol>> | undefined;
  let failure: unknown;
  try {
    protocol = await connectEvalProtocol(discovery, undefined, { retryCapacity: true, wait: async delay => {
      delays.push(delay);
      if (delays.length === 2) FakeWebSocket.controllerClaimed = false;
    } });
  } catch (error) { failure = error; }

  expect(failure).toBeUndefined();
  expect(protocol).toBeDefined();
  expect(FakeWebSocket.helloAttempts).toBe(3);
  expect(delays).toEqual([50, 100]);
  await protocol?.close();
});

test("reconnect stops after the capacity retry bound", async () => {
  installFakeWebSocket();
  const delays: number[] = [];
  let failure: unknown;
  try {
    await connectEvalProtocol(discovery, undefined, { retryCapacity: true, wait: async delay => { delays.push(delay); } });
  } catch (error) { failure = error; }

  expect(failure).toMatchObject({ code: -32001, message: "claim attempt 1" });
  expect(delays.reduce((total, delay) => total + delay, 0)).toBe(5_000);
  expect(FakeWebSocket.helloAttempts).toBe(delays.length + 1);
});

test("reconnect does not retry another hello error", async () => {
  installFakeWebSocket(-32002);
  const delays: number[] = [];
  await expect(connectEvalProtocol(discovery, undefined, { retryCapacity: true, wait: async delay => { delays.push(delay); } })).rejects.toMatchObject({ code: -32002 });
  expect(delays).toEqual([]);
});

test("reconnect aborts during a pending capacity backoff without another connection", async () => {
  installFakeWebSocket();
  const controller = new AbortController();
  const reason = new Error("task stopped");
  let waitResolved = false;
  let releaseWait!: () => void;
  let waitStartedResolve!: () => void;
  let waitFinishedResolve!: () => void;
  const waitStarted = new Promise<void>(resolve => { waitStartedResolve = resolve; });
  const waitFinished = new Promise<void>(resolve => { waitFinishedResolve = resolve; });
  const connecting = connectEvalProtocol(discovery, undefined, {
    retryCapacity: true,
    signal: controller.signal,
    wait: async () => {
      waitStartedResolve();
      await new Promise<void>(resolve => { releaseWait = resolve; });
      waitResolved = true;
      waitFinishedResolve();
    },
  });

  await resolveBeforeDeadline("capacity backoff start", waitStarted);
  expect(FakeWebSocket.socketConstructions).toBe(1);
  controller.abort(reason);
  expect(await rejectBeforeDeadline("capacity-backoff cancellation", connecting, controller, releaseWait)).toBe(reason);
  expect(waitResolved).toBe(false);
  releaseWait();
  await resolveBeforeDeadline("capacity backoff finish", waitFinished);
  await new Promise<void>(resolve => queueMicrotask(resolve));
  expect(FakeWebSocket.socketConstructions).toBe(1);
});

test("reconnect aborts while the socket is opening and closes it", async () => {
  installFakeWebSocket();
  FakeWebSocket.holdOpen = true;
  const controller = new AbortController();
  const reason = new Error("task stopped");
  const connecting = connectEvalProtocol(discovery, undefined, { signal: controller.signal });

  expect(FakeWebSocket.socketConstructions).toBe(1);
  controller.abort(reason);
  expect(await rejectBeforeDeadline(
    "opening-socket cancellation",
    connecting,
    controller,
    () => FakeWebSocket.lastSocket?.close(),
  )).toBe(reason);
  expect(FakeWebSocket.closeCalls).toBeGreaterThan(0);
  expect(FakeWebSocket.socketConstructions).toBe(1);
});
