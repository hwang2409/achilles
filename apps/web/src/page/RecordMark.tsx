export function RecordMark({ status }: { status: string }) {
  const normalized = status.toLowerCase().replace(/\s+/g, "-");
  return <span data-record-mark={normalized} className="mt-1 me-0.5 inline-block size-1.5 shrink-0 align-[1px] outline outline-offset-[-1px] outline-muted-foreground data-[record-mark=reading]:bg-[linear-gradient(90deg,var(--ring)_50%,transparent_50%)] data-[record-mark=in-progress]:bg-[linear-gradient(90deg,var(--ring)_50%,transparent_50%)] data-[record-mark=done]:bg-success data-[record-mark=sent]:bg-success data-[record-mark=paid]:bg-success" aria-hidden="true" />;
}
