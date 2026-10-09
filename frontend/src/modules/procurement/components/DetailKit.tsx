import type { ReactNode } from "react";
import { Card } from "@/shared/components";

/**
 * The shape every procurement DOCUMENT page holds.
 *
 * Requisition, Consolidation, RFQ and Purchase Order were four different layouts
 * for one thing — a document, its lines, and where it is in approval. Each had
 * grown its own header block, its own facts grid and its own idea of where the
 * approval panel goes (all four had it stranded at the very bottom, under the
 * lines, which is the last place somebody looks for who is holding the document).
 *
 * One shell now: the document reads down the left, and the things you glance at —
 * status, money, who has it — sit in a sticky rail on the right where they stay
 * on screen while you scroll a hundred lines. Nothing here fetches or decides;
 * every page keeps its own gating, so no `<Can>` and no approval check moved.
 */

/** Document left, glanceables right. The rail drops below the body on a phone. */
export function DetailShell({ main, rail }: { main: ReactNode; rail: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">{main}</div>
      <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">{rail}</div>
    </div>
  );
}

export function SectionCard({
  title, action, children, className = "",
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`p-4 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && (
            <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{title}</h2>
          )}
          {action}
        </div>
      )}
      {children}
    </Card>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
  /** Renders across the full row — for a long name or a sentence. */
  wide?: boolean;
}

/**
 * The document's own fields. Every one of them: a buying document is a record, and
 * a field dropped from the screen is a field somebody has to open the database to
 * read. Empty ones show an em dash rather than vanishing, so the grid keeps its
 * shape between two documents of the same type.
 */
export function FactGrid({ facts, cols = 4 }: { facts: Fact[]; cols?: 2 | 3 | 4 }) {
  const grid = cols === 2 ? "sm:grid-cols-2" : cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4";
  return (
    <dl className={`grid grid-cols-2 gap-x-4 gap-y-4 ${grid}`}>
      {facts.map((fact) => (
        <div key={fact.label} className={`min-w-0 ${fact.wide ? "col-span-2 sm:col-span-full" : ""}`}>
          <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
            {fact.label}
          </dt>
          <dd className="mt-1 truncate text-sm font-medium text-ink" title={
            typeof fact.value === "string" ? fact.value : undefined
          }>
            {fact.value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A headline figure for the rail — the money, the count, the total. */
export function RailStat({
  label, value, tone = "text-ink", sub,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  sub?: ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className={`mt-0.5 font-display text-2xl font-bold leading-tight ${tone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** A document number pointing at another document. Monospace because that is how
 *  every number in this system is written, and clickable when it can be reached. */
export function DocRef({
  no, onOpen, label,
}: {
  no?: string | null;
  onOpen?: () => void;
  label?: string;
}) {
  if (!no) return <span className="text-sm text-muted">—</span>;
  const body = <span className="font-mono text-[13px]">{no}</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {label && <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>}
      {onOpen
        ? (
          <button
            type="button"
            onClick={onOpen}
            className="rounded-md text-brand underline-offset-2 transition-colors hover:text-brand-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {body}
          </button>
        )
        : <span className="text-body">{body}</span>}
    </span>
  );
}

/** A row of small document references — "rolled up from", "source material requests". */
export function RefChips({ items }: { items: { no: string; onOpen?: () => void }[] }) {
  if (!items.length) return <span className="text-sm text-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((ref) => (
        <button
          key={ref.no}
          type="button"
          disabled={!ref.onOpen}
          onClick={ref.onOpen}
          className={`rounded-lg border border-line bg-content2/60 px-2 py-1 font-mono text-[11px] text-body transition-colors ${
            ref.onOpen
              ? "hover:border-brand/40 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              : "cursor-default"
          }`}
        >
          {ref.no}
        </button>
      ))}
    </div>
  );
}
