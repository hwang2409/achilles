const SECRET_KEYS = /token|authorization|headers|mcp_bindings|credential/i;

type FrameSummary = { direction: "received" | "sent"; method?: string; delivery_id?: string; error_code?: number | string };

export function createFrameRing(limit = 20) {
  const frames: FrameSummary[] = [];
  const pending = new Map<string, { delivery_id?: string; method?: string }>();
  return {
    record(socket: number, direction: FrameSummary["direction"], payload: string) {
      try {
        const frame = JSON.parse(payload) as { error?: { code?: number | string }; id?: number | string; method?: string; params?: { delivery_id?: string } };
        const key = frame.id === undefined ? undefined : `${socket}:${frame.id}`;
        const request = key === undefined ? undefined : pending.get(key);
        const summary: FrameSummary = {
          direction,
          method: frame.method ?? request?.method,
          delivery_id: frame.params?.delivery_id ?? request?.delivery_id,
          error_code: frame.error?.code,
        };
        frames.push(Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined)) as FrameSummary);
        if (frames.length > limit) frames.shift();
        if (direction === "sent" && key !== undefined && frame.method)
          pending.set(key, { method: frame.method, delivery_id: frame.params?.delivery_id });
        if (direction === "received" && key !== undefined) pending.delete(key);
      } catch { /* non-JSON frames have no safe diagnostic fields */ }
    },
    snapshot: () => frames,
  };
}

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
