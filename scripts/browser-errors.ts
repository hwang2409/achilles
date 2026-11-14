export type BrowserErrorExpectation = { method: string; url: string; status: number };

type ResponseLike = { request(): { method(): string }; url(): string; status(): number };
type MessageLike = { type(): string; text(): string; location(): { url: string } };
type PageLike = { on(event: "response" | "console", listener: (value: ResponseLike | MessageLike) => void): void; off(event: "response" | "console", listener: (value: ResponseLike | MessageLike) => void): void };

export async function expectBrowserErrors(
  page: PageLike,
  expected: BrowserErrorExpectation[],
  step: () => Promise<void>,
) {
  const responses = expected.map(() => false);
  const consoles = expected.map(() => false);
  const response = (value: ResponseLike | MessageLike) => {
    if (!("request" in value)) return;
    const request = value.request();
    const index = expected.findIndex((item, i) => !responses[i] && request.method() === item.method && (!item.url || value.url() === item.url) && value.status() === item.status);
    if (index >= 0 && !expected[index].url) expected[index].url = value.url();
    if (index >= 0) responses[index] = true;
    else if (expected.some((item) => item.status === value.status())) throw new Error(`unexpected browser response: ${request.method()} ${value.url()} ${value.status()}`);
  };
  const consoleMessage = (value: ResponseLike | MessageLike) => {
    if (!("location" in value) || value.type() !== "error") return;
    const index = expected.findIndex((item, i) => responses[i] && !consoles[i] && value.location().url === item.url && value.text().includes(String(item.status)));
    if (index >= 0) { consoles[index] = true; return; }
    throw new Error(`unexpected browser console error at ${value.location().url}: ${value.text()}`);
  };
  page.on("response", response);
  page.on("console", consoleMessage);
  try {
    await step();
  } finally {
    page.off("response", response);
    page.off("console", consoleMessage);
  }
  expected.forEach((item, index) => {
    if (!responses[index]) throw new Error(`expected browser error did not occur: ${item.method} ${item.url} ${item.status}`);
  });
}
