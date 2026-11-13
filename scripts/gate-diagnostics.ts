const SECRET_KEYS = /token|authorization|headers|mcp_bindings|credential/i;

const scrub = (value: unknown, secrets: readonly string[]): unknown => {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
    return text.replace(/bearer\s+[^\s,}\"]+/gi, "Bearer [redacted]");
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.test(key) ? "[redacted]" : scrub(item, secrets),
      ]),
    );
  }
  return value;
};

export const diagnostic = (value: unknown, secrets: readonly string[] = []): string =>
  typeof value === "string"
    ? String(scrub(value, secrets))
    : JSON.stringify(scrub(value, secrets));

export const controlSnapshot = (text: string, secrets: readonly string[] = []): string => {
  try {
    const value = JSON.parse(text);
    const allowed = Object.fromEntries(
      ["request_count", "last_message", "schemas", "returned_tool_calls", "pid"].flatMap(
        (key) => (key in value ? [[key, value[key]]] : []),
      ),
    );
    return diagnostic(allowed, secrets);
  } catch {
    return diagnostic(text, secrets);
  }
};

export const failureMessage = (parts: unknown[], secrets: readonly string[] = []): string =>
  parts.map((part) => diagnostic(part, secrets)).join(" ");
