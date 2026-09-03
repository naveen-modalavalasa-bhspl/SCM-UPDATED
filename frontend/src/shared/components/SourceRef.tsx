import { Link } from "react-router-dom";

/**
 * The document a document came from, shown in the list instead of buried in the row.
 *
 * Every document in the chain points BACKWARD at the one before it — an issue at its
 * indent, a GRN at its PO, a PO at its indent — and every list showed only the row's
 * own number. So finding "the issue that served IND0011" meant either already knowing
 * the indent number to type into search, or opening each row until one matched. The
 * link was in the data the whole time; nothing drew it.
 *
 * Pass the candidates in priority order. The first one carrying a number wins — an
 * issue raised against an indent shows the indent, a return shows the issue it
 * reverses. `to` is optional: a reference whose target has no detail screen (a
 * picklist, today) still reads as text, which is the point.
 */
export type SourceRefCandidate = {
  /** What kind of document this is — "Indent", "PO", "GRN". Drawn above the number. */
  label: string;
  no?: string | null;
  /** Detail route. Omit or null for a reference with nowhere to go. */
  to?: string | null;
};

export function SourceRef({
  refs,
  empty = "—",
}: {
  refs: SourceRefCandidate[];
  empty?: string;
}) {
  const ref = refs.find((r) => r.no);
  if (!ref) return <span className="text-muted">{empty}</span>;

  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted">{ref.label}</div>
      {ref.to ? (
        <Link
          to={ref.to}
          onClick={(e) => e.stopPropagation()}
          className="truncate font-mono text-xs font-semibold text-primary hover:underline"
        >
          {ref.no}
        </Link>
      ) : (
        <span className="truncate font-mono text-xs font-semibold text-ink">{ref.no}</span>
      )}
    </div>
  );
}

/** The same reference on a narrow card, where there is no column to put it in. */
export function SourceRefLine({ refs }: { refs: SourceRefCandidate[] }) {
  const ref = refs.find((r) => r.no);
  if (!ref) return null;
  return (
    <span className="text-[11px] text-muted">
      {ref.label} <span className="font-mono text-ink">{ref.no}</span>
    </span>
  );
}
