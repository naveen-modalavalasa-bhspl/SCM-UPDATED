import { ArrowDown, History, MinusCircle } from "lucide-react";
import { Card } from "./ui";

/**
 * Every change made to a document's quantities after it was asked for (2026-11-03) —
 * the numbers the approval history does not hold. Material requests and requisitions
 * both serve the same row shape (`/quantity-changes`), so one card draws both.
 *
 * A change can only ever LOWER a line (the asked-for quantity is a ceiling), so each
 * row reads as a cut: from → to, how much came off, what was originally asked, and
 * who did it, in which post, at which stage, and why.
 */
export interface QuantityChangeRow {
  id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  combination?: string | null;
  from_qty: number;
  to_qty: number;
  ceiling_qty?: number | null;
  stage: string;
  comments?: string | null;
  changed_by_name?: string | null;
  changed_by_position?: string | null;
  changed_at: string;
}

const STAGE: Record<string, { label: string; tone: string }> = {
  APPROVAL: { label: "At approval", tone: "bg-brand-050 text-brand" },
  CORRECTION: { label: "Raiser's correction", tone: "bg-info-bg text-info" },
  DRAFT_EDIT: { label: "Draft edit", tone: "bg-content2 text-ink-700 ring-1 ring-line" },
};

const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
const when = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso
    : at.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

export function QuantityChanges({ rows, loading }: { rows: QuantityChangeRow[]; loading?: boolean }) {
  if (loading || !rows.length) return null;
  return (
    <Card className="mt-4 p-0">
      <div className="flex items-center gap-2 px-4 pt-4 sm:px-5">
        <History className="h-4 w-4 text-brand" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">Quantity changes</h2>
        <span className="rounded-full bg-content2 px-2 py-0.5 text-[11px] font-semibold text-muted">
          {rows.length}
        </span>
        <span className="ml-auto hidden text-[11px] text-muted sm:inline">
          Quantities can only be lowered after they are asked for
        </span>
      </div>
      <ol className="mt-3 divide-y divide-line/70">
        {rows.map((r) => {
          const removed = r.to_qty === 0;
          const cut = Math.round((r.from_qty - r.to_qty) * 1000) / 1000;
          const stage = STAGE[r.stage] ?? { label: r.stage, tone: "bg-content2 text-muted" };
          const unit = r.uom_code ? ` ${r.uom_code}` : "";
          return (
            <li key={r.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-xs font-semibold text-ink">{r.item_code ?? "—"}</span>
                  <span className="truncate text-sm text-body">{r.item_name}</span>
                  {r.combination && <span className="text-[11px] text-muted">· {r.combination}</span>}
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${stage.tone}`}>{stage.label}</span>
                </div>
                <div className="mt-1 text-[12px] text-muted">
                  {r.changed_by_name ?? "Someone"}
                  {r.changed_by_position ? <span> · {r.changed_by_position}</span> : null}
                  <span> · {when(r.changed_at)}</span>
                </div>
                {r.comments && (
                  <p className="mt-1 rounded-lg bg-content2/60 px-2.5 py-1.5 text-[12px] italic text-body">
                    “{r.comments}”
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 sm:justify-end">
                <div className="flex items-center gap-1.5 tabular text-sm">
                  <span className="text-muted line-through decoration-muted/60">{qty(r.from_qty)}</span>
                  <span className="text-muted">→</span>
                  <span className={`font-semibold ${removed ? "text-bad" : "text-ink"}`}>
                    {removed ? "removed" : `${qty(r.to_qty)}${unit}`}
                  </span>
                </div>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  removed ? "bg-bad-bg text-bad" : "bg-warn-bg text-warn"}`}>
                  {removed ? <MinusCircle className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                  {qty(cut)}{unit}
                </span>
                {r.ceiling_qty != null && (
                  <span className="hidden text-[11px] text-muted md:inline">asked {qty(r.ceiling_qty)}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
