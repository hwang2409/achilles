import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PINNED_OUTPUT_UNAVAILABLE = "unavailable at this zeta pin" as const;
export type TranscriptUsage = {
  turns_with_usage: number;
  input_tokens: number | "unavailable";
  output_tokens: number | typeof PINNED_OUTPUT_UNAVAILABLE;
  reasoning_output_tokens: number | typeof PINNED_OUTPUT_UNAVAILABLE;
  cache_read_input_tokens: number | "unavailable";
  cache_creation_input_tokens: number | "unavailable";
};

const tokenKeys = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

export function transcriptUsage(contents: string[]): TranscriptUsage | "unavailable" {
  const usageRows: Record<string, unknown>[] = [];
  for (const content of contents) for (const line of content.split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as Record<string, any>;
    const usage = row.data?.message?.metadata?.provider_usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) usageRows.push(usage);
  }
  if (!usageRows.length) return "unavailable";
  const total = (key: typeof tokenKeys[number], alias?: string) => {
    const values = usageRows.map(row => row[key] ?? (alias ? row[alias] : undefined)).filter((value): value is number => Number.isInteger(value) && value >= 0);
    return values.length === usageRows.length ? values.reduce((sum, value) => sum + value, 0) : "unavailable";
  };
  const output = total("output_tokens");
  const reasoning = total("reasoning_output_tokens");
  return {
    turns_with_usage: usageRows.length,
    input_tokens: total("input_tokens", "prompt_tokens"),
    output_tokens: output === "unavailable" ? PINNED_OUTPUT_UNAVAILABLE : output,
    reasoning_output_tokens: reasoning === "unavailable" ? PINNED_OUTPUT_UNAVAILABLE : reasoning,
    cache_read_input_tokens: total("cache_read_input_tokens"),
    cache_creation_input_tokens: total("cache_creation_input_tokens"),
  };
}

export async function readTranscriptUsage(zetaHome: string, sessionIds: string[]) {
  const contents = await Promise.all(sessionIds.map(id => readFile(join(zetaHome, "sessions", id, "conversation.jsonl"), "utf8")));
  return transcriptUsage(contents);
}
