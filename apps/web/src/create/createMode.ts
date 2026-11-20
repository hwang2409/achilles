// A projection of the active page, not a second source of mode state.
export type CreateModeOwner = {
  available: boolean;
  enabled: boolean;
  pending: boolean;
  error: string | null;
  toggle(): Promise<void>;
};
