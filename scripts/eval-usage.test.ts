import { expect, test } from "bun:test";
import { PINNED_OUTPUT_UNAVAILABLE, transcriptUsage } from "./eval-usage";

const row = (usage?: Record<string, number>) => JSON.stringify({
  type: "message",
  data: { message: { role: "assistant", metadata: usage ? { provider_usage: usage } : {} } },
});

test("transcript usage sums every persisted token field across sessions", () => {
  expect(transcriptUsage([
    `${row({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })}\n${row()}\n`,
    `${row({ prompt_tokens: 5, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 })}\n`,
  ])).toEqual({ turns_with_usage: 2, input_tokens: 15, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 4 });
});

test("transcript usage distinguishes a missing metric from no usage", () => {
  expect(transcriptUsage([`${row({ input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })}\n`])).toEqual({
    turns_with_usage: 1,
    input_tokens: 10,
    output_tokens: PINNED_OUTPUT_UNAVAILABLE,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  expect(transcriptUsage([`${row()}\n`])).toBe("unavailable");
});
