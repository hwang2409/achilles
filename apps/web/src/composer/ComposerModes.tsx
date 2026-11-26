import { WRITE_SURFACE, type WriteSurfaceId } from "../writeSurfaces";

/** A chat mode the composer shows as a switch. `reason` or `busy` holds it still; no `toggle` means nothing to change. */
export type ComposerMode = { on: boolean; toggle?: () => void; reason?: string; busy?: string; error?: string | null };

/** The chat's modes and model, one row in the composer bar of both the plain and the vim composer. */
export function ComposerModes({ create, approval, model }: { create?: ComposerMode; approval?: ComposerMode; model?: string | null }) {
  const switches: [ComposerMode | undefined, WriteSurfaceId, string, string, string][] = [
    [create, WRITE_SURFACE.composerCreateMode, "create", "create mode on: this chat can change the page layout", "create mode off: this chat changes page data only"],
    [approval, WRITE_SURFACE.composerAutoApprove, "auto-approve", "tools run without asking", "ask before running tools"],
  ];
  return <div data-part="composer-modes">
    {switches.map(([mode, surface, label, on, off]) => mode && <span key={surface} data-part="composer-mode-item">
      <button type="button" role="switch" data-part="composer-mode" data-write-surface={surface} aria-checked={mode.on}
        aria-disabled={!mode.toggle || Boolean(mode.reason || mode.busy) || undefined} aria-busy={Boolean(mode.busy) || undefined}
        title={mode.reason ?? mode.busy ?? (mode.on ? on : off)}
        onClick={() => { if (mode.toggle && !mode.reason && !mode.busy) mode.toggle(); }}>
        <span data-part="composer-mode-dot" aria-hidden="true" />{label}
      </button>
      {mode.busy && <span data-part="composer-mode-note" role="status">{mode.busy}</span>}
      {mode.error && <span data-part="composer-mode-note" data-tone="danger" role="alert">{mode.error}</span>}
    </span>)}
    {model && <span data-part="composer-model" title={`model: ${model}`}>{model}</span>}
  </div>;
}
