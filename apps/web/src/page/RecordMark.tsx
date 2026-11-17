export function RecordMark({ status }: { status: string }) {
  const normalized = status.toLowerCase().replace(/\s+/g, "-");
  return <span className={`record-mark record-mark-${normalized}`} aria-hidden="true" />;
}
