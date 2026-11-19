import type { ModelRow, ModelSeriesPoint, SeriesPoint, ToolRow } from "./telemetry-types";

type ErrorCounts =
  | { spans: Pick<SeriesPoint, "errors" | "spans"> }
  | { model: Pick<ModelRow, "model" | "errors" | "calls"> }
  | { tool: Pick<ToolRow, "tool_name" | "errors" | "calls"> }
  | { modelBucket: Pick<ModelSeriesPoint, "errored_model_calls" | "model_calls"> };

/** Read both counts from the same population. Bound the display even if a reply overcounts errors. */
export function errorShare(counts: ErrorCounts): number | null {
  const [errored, total] = "spans" in counts ? [counts.spans.errors, counts.spans.spans]
    : "model" in counts ? [counts.model.errors, counts.model.calls]
    : "tool" in counts ? [counts.tool.errors, counts.tool.calls]
    : [counts.modelBucket.errored_model_calls, counts.modelBucket.model_calls];
  return total > 0 ? Math.min(1, Math.max(0, errored / total)) : null;
}
