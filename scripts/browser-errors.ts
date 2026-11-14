export type BrowserErrorExpectation = { method: string; url: string; status: number; count?: number };

type ResponseLike = { request(): { method(): string }; url(): string; status(): number };
type MessageLike = { type(): string; text(): string; location(): { url: string } };
type PageLike = { on(event: "response" | "console", listener: (value: ResponseLike | MessageLike) => void): void; off(event: "response" | "console", listener: (value: ResponseLike | MessageLike) => void): void };

const sameUrl = (actual: string, expected: string) => {
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    return actualUrl.origin === expectedUrl.origin && actualUrl.pathname === expectedUrl.pathname && (!expectedUrl.search || actualUrl.search === expectedUrl.search);
  } catch {
    return false;
  }
};

export async function expectBrowserErrors(
  page: PageLike,
  expected: BrowserErrorExpectation[],
  step: () => Promise<void>,
) {
  const responses = expected.map(() => 0);
  const consoles = expected.map(() => 0);
  const violations: string[] = [];
  const observed: string[] = [];
  const response = (value: ResponseLike | MessageLike) => {
    if (!("request" in value)) return;
    const request = value.request();
    const description = `${request.method()} ${value.url()} ${value.status()}`;
    observed.push(description);
    const index = expected.findIndex((item, i) => responses[i] < (item.count ?? 1) && request.method() === item.method && sameUrl(value.url(), item.url) && value.status() === item.status);
    if (index >= 0) responses[index] += 1;
    else if (expected.some((item) => item.status === value.status())) violations.push(`unexpected browser response: ${description}`);
  };
  const consoleMessage = (value: ResponseLike | MessageLike) => {
    if (!("location" in value) || value.type() !== "error") return;
    const index = expected.findIndex((item, i) => consoles[i] < (item.count ?? 1) && sameUrl(value.location().url, item.url) && value.text().includes(String(item.status)));
    if (index >= 0) consoles[index] += 1;
    else violations.push(`unexpected browser console error at ${value.location().url}: ${value.text()}`);
  };
  page.on("response", response);
  page.on("console", consoleMessage);
  try {
    await step();
  } finally {
    page.off("response", response);
    page.off("console", consoleMessage);
  }
  const missing = expected.flatMap((item, index) => {
    const count = item.count ?? 1;
    return responses[index] < count ? [`expected browser error did not occur ${count - responses[index]} time(s): ${item.method} ${item.url} ${item.status}`] : [];
  });
  const failures = [...violations, ...missing];
  if (failures.length) throw new Error(`${failures.join("\n")}\nobserved responses:\n${observed.join("\n") || "(none)"}`);
}
