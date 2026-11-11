import { useMemo, useState } from "react";
import { CalendarClock, ChevronDown, MapPin } from "lucide-react";
import { fmtQty, num } from "../format";
import { expiryLabel, expiryTone } from "./SourcePicker";
import type { IssueStockSource } from "../types";

/**
 * The shelf for ONE item, on its own issue row (2026-11-03) — replacing the separate
 * "Stock on the shelf" panel that sat above the grid and repeated the same rows.
 *
 * It answers, item-wise and in this order, the questions a storekeeper actually asks:
 *   how much is here → how much of it is FREE (nobody's) → how much is held for THIS
 *   document → how much other documents have reserved → so how much can this issue
 *   take, and what is left once it goes.
 * One coloured bar shows the split at a glance; "Where it is" opens the same split per
 * batch and storage location, earliest expiry first.
 *
 * Every figure is SERVED (`stock-sources`), never summed out of the pickers: a location
 * another document has reserved outright is not offered as a source, so adding the
 * offered rows up would report a stocked shelf as short.
 */
export function ItemStockCard({
  total, free, mine, others, drawable, issued, asked, direct, uom, rows,
}: {
  total: number;
  free: number;
  mine: number;
  others: number;
  /** What this issue may draw on altogether (free + its own hold). */
  drawable: number | null;
  issued: number;
  asked: number;
  /** A direct issue holds its own stock; an indent-backed one draws on the indent's. */
  direct: boolean;
  uom?: string | null;
  rows: IssueStockSource[];
}) {
  const [open, setOpen] = useState(false);
  const mineLabel = direct ? "Held for this issue" : "Reserved for this indent";
  const pct = (v: number) => (total > 0 ? `${Math.max(0, Math.min(100, (v / total) * 100))}%` : "0%");
  const after = Math.round((total - issued) * 1000) / 1000;
  const canTake = drawable ?? Math.round((free + mine) * 1000) / 1000;
  const short = asked > 0 && canTake < asked;
  const unit = uom ? ` ${uom}` : "";

  const batches = useMemo(() => {
    const by = new Map<string, { batchNo: string | null; expiry: string | null;
      total: number; free: number; locations: IssueStockSource[] }>();
    for (const row of rows) {
      const key = String(row.batch_id ?? 0);
      const batch = by.get(key) ?? { batchNo: row.batch_no ?? null, expiry: row.expiry_date ?? null,
        total: num(row.batch_total_qty), free: num(row.batch_available_qty), locations: [] };
      batch.locations.push(row);
      by.set(key, batch);
    }
    return [...by.values()];
  }, [rows]);

  return (
    <div className="mt-2.5 overflow-hidden rounded-xl border border-line/70 bg-content1">
      <div className="px-3 pt-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">In this warehouse</span>
          <span className="tabular text-sm font-semibold text-ink">{fmtQty(total)}<span className="text-[11px] font-normal text-muted">{unit}</span></span>
        </div>

        {/* The split, at a glance. */}
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-content2" aria-hidden>
          <span className="bg-ok" style={{ width: pct(free) }} />
          <span className="bg-brand" style={{ width: pct(mine) }} />
          <span className="bg-warn" style={{ width: pct(others) }} />
        </div>

        <dl className="mt-2 space-y-1 text-[12px]">
          <Part dot="bg-ok" label="Free — reserved by nobody" value={free} strong />
          <Part dot="bg-brand" label={mineLabel} value={mine} />
          <Part dot="bg-warn" label="Reserved by other documents" value={others} />
        </dl>
      </div>

      <div className={`mt-2.5 grid grid-cols-2 border-t border-line/70 text-[11px] ${short ? "bg-warn-bg/40" : "bg-content2/40"}`}>
        <div className="border-r border-line/70 px-3 py-2">
          <div className="text-muted">This issue can take</div>
          <div className={`tabular text-sm font-semibold ${short ? "text-warn" : "text-ok"}`}>{fmtQty(canTake)}</div>
          {short && <div className="text-[10px] text-warn">less than the {fmtQty(asked)} asked</div>}
        </div>
        <div className="px-3 py-2">
          <div className="text-muted">Left after this issue</div>
          <div className={`tabular text-sm font-semibold ${after <= 0 ? "text-warn" : "text-ink"}`}>{fmtQty(after)}</div>
        </div>
      </div>

      {batches.length > 0 && (
        <>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
                  className="flex min-h-11 w-full items-center justify-between border-t border-line/70 px-3 text-[11px] font-semibold text-brand hover:bg-brand-050">
            Where it is · {batches.length} batch{batches.length === 1 ? "" : "es"}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          {open && (
            <ul className="space-y-2 border-t border-line/70 bg-content2/30 px-3 py-2.5">
              {batches.map((b) => (
                <li key={`${b.batchNo}-${b.expiry}`}>
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px]">
                    <span className="font-mono font-semibold text-ink">{b.batchNo ?? "No batch"}</span>
                    {b.expiry && (
                      <span className="inline-flex items-center gap-1 text-muted">
                        <CalendarClock className="h-3 w-3" /> {expiryLabel(b.expiry)}
                        <span className={expiryTone(b.expiry).tone}>· {expiryTone(b.expiry).label}</span>
                      </span>
                    )}
                    <span className="ml-auto tabular text-muted">
                      <b className="text-ink">{fmtQty(b.free)}</b> free of {fmtQty(b.total)}
                    </span>
                  </div>
                  <ul className="mt-1 space-y-1">
                    {b.locations.map((row) => {
                      const here = num(row.total_qty);
                      const rowFree = num(row.available_qty);
                      const rowMine = num(row.own_reserved_qty) + num(row.issue_hold_qty ?? 0);
                      const rowOthers = Math.max(Math.round((here - rowFree - rowMine) * 1000) / 1000, 0);
                      return (
                        <li key={`${row.batch_id}-${row.bin_id}`}
                            className="rounded-lg border border-line/60 bg-content1 px-2 py-1.5 text-[11px]">
                          <div className="flex items-center gap-1.5">
                            <MapPin className="h-3 w-3 shrink-0 text-muted" />
                            <span className="truncate font-mono font-semibold text-ink" title={row.bin_path ?? row.bin_code ?? ""}>
                              {row.bin_code ?? "No location"}
                            </span>
                            <span className="ml-auto tabular text-muted">{fmtQty(here)} here</span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Chip tone="bg-ok-bg text-ok" label="free" value={rowFree} />
                            {rowMine > 0 && <Chip tone="bg-brand-050 text-brand" label={direct ? "this issue" : "this indent"} value={rowMine} />}
                            {rowOthers > 0 && <Chip tone="bg-warn-bg text-warn" label="others" value={rowOthers} />}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Part({ dot, label, value, strong }: { dot: string; label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <dt className="flex-1 text-body">{label}</dt>
      <dd className={`tabular ${strong ? "font-semibold text-ink" : "text-ink"}`}>{fmtQty(value)}</dd>
    </div>
  );
}

function Chip({ tone, label, value }: { tone: string; label: string; value: number }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>
      <span className="tabular">{fmtQty(value)}</span> {label}
    </span>
  );
}
