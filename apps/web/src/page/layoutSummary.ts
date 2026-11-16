// A short detail that tells near-identical layout versions apart in the history list: the first block's
// label (its title, or text) leads so it survives truncation at 390, then how many blocks the version has.
export function layoutSummary(blockCount: number, label: string | null): string {
  const count = `${blockCount} ${blockCount === 1 ? "block" : "blocks"}`;
  return label ? `${label} · ${count}` : count;
}
