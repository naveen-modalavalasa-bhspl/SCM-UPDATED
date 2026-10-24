import { useEffect, useMemo, useState } from "react";
import {
  Barcode, CalendarClock, ChevronDown, MapPin, RefreshCw, Warehouse,
} from "lucide-react";
import { fmtQty, num } from "../format";
import { expiryLabel, expiryTone } from "./SourcePicker";
import type { IssueItemWrite, IssueStockSource } from "../types";

/**
 * What the shelf holds RIGHT NOW for every item on this issue, at the three widths a
 * storekeeper decides on: the warehouse, each batch, and each storage location inside
 * that batch.
 *
 * Read off the same `stock-sources` rows the pickers and the save use, refreshed on a
 * timer and whenever the window regains focus, so a bay another storekeeper emptied a
 * minute ago is not still being offered here. Every figure carries the word for which
 * width it is — a bare "40" beside "10" is the number that gets read as the wrong one.
 */
export function LiveStockPanel({
  lines, sources, updatedAt, fetching, onRefresh,
}: {
  lines: IssueItemWrite[];
  sources: IssueStockSource[];
  /** `dataUpdatedAt` of the query — when the shelf was last read. */
  updatedAt: number;
  fetching: boolean;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const items = useMemo(() => {
    const seen = new Map<number, { id: number; code?: string | null; name?: string | null;
      asked: number }>();
    for (const line of lines) {
      if (!line.item_id) continue;
      const row = seen.get(line.item_id)
        ?? { id: line.item_id, code: line.item_code, name: line.item_name, asked: 0 };
      row.asked += num(line.requested_qty);
      row.code ??= line.item_code;
      row.name ??= line.item_name;
      seen.set(line.item_id, row);
    }
    return [...seen.values()];
  }, [lines]);

  if (!items.length) return null;
  const age = updatedAt ? Math.max(0, Math.round((now - updatedAt) / 1000)) : null;

  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-line bg-content1">
      <header className="flex flex-wrap items-center gap-3 border-b border-line/70 px-4 py-3">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
                className="flex min-h-11 items-center gap-2 text-left">
          <Warehouse className="h-4 w-4 text-brand" />
          <span className="text-sm font-semibold text-ink">Stock on the shelf</span>
          <ChevronDown className={`h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-bg px-2.5 py-1 text-[11px] font-semibold text-ok">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
          </span>
          Live
        </span>
        <span className="text-xs text-muted">
          {fetching ? "Refreshing…" : age === null ? "Reading the shelf…"
            : age < 5 ? "Updated just now" : `Updated ${age}s ago`}
        </span>
        <button type="button" onClick={onRefresh} disabled={fetching}
                className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-brand hover:bg-brand-050 disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${fetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      {open && (
        <div className="divide-y divide-line/70">
          {items.map((item) => (
            <ItemStock key={item.id} item={item}
                       rows={sources.filter((row) => row.item_id === item.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function ItemStock({ item, rows }: {
  item: { id: number; code?: string | null; name?: string | null; asked: number };
  rows: IssueStockSource[];
}) {
  const first = rows[0];
  const drawable = rows.reduce((sum, row) => sum + num(row.drawable_qty), 0);
  const batches = useMemo(() => {
    const by = new Map<number, { batchNo: string | null; expiry: string | null;
      total: number; free: number; coded: boolean; rows: IssueStockSource[] }>();
    for (const row of rows) {
      const key = row.batch_id ?? 0;
      const batch = by.get(key) ?? { batchNo: row.batch_no ?? null,
        expiry: row.expiry_date ?? null, total: num(row.batch_total_qty),
        free: num(row.batch_available_qty), coded: false, rows: [] };
      batch.rows.push(row);
      if (row.has_unit_codes) batch.coded = true;
      by.set(key, batch);
    }
    return [...by.values()];
  }, [rows]);
  const short = drawable < item.asked;

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs font-semibold text-ink">{item.code ?? `#${item.id}`}</span>
        <span className="text-sm text-body">{item.name}</span>
        {first?.codes_required && (
          <span className="inline-flex items-center gap-1 rounded bg-info-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-info">
            <Barcode className="h-3 w-3" /> Issued with codes
          </span>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Figure label="Whole warehouse" value={first ? num(first.item_total_qty) : 0}
                hint="every batch, every location" />
        <Figure label="Free in warehouse" value={first ? num(first.item_available_qty) : 0}
                hint="not held by any document" />
        <Figure label="This issue can draw" value={drawable}
                hint="free + held for this issue" tone={short ? "warn" : "ok"} />
        <Figure label="Asked on this issue" value={item.asked}
                hint={short ? `${fmtQty(item.asked - drawable)} short here` : "covered"}
                tone={short ? "warn" : undefined} />
      </div>

      {batches.length === 0 ? (
        <p className="mt-2 text-xs text-warn">
          Nothing of this item can be drawn at this point right now.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {batches.map((batch) => {
            const tone = expiryTone(batch.expiry);
            return (
              <div key={batch.batchNo ?? "none"} className="rounded-xl border border-line/70 bg-content2/40 p-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-xs font-semibold text-ink">
                    {batch.batchNo ?? "Unbatched stock"}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                    <CalendarClock className="h-3 w-3" /> {expiryLabel(batch.expiry)}
                    <span className={tone.tone}>· {tone.label}</span>
                  </span>
                  {batch.coded && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-info-bg px-1 py-px text-[9px] font-semibold uppercase text-info">
                      <Barcode className="h-2.5 w-2.5" /> Codes
                    </span>
                  )}
                  <span className="ml-auto text-[11px] tabular-nums text-muted">
                    <b className="text-ink">{fmtQty(batch.total)}</b> in this batch ·{" "}
                    <b className="text-ink">{fmtQty(batch.free)}</b> free
                  </span>
                </div>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {batch.rows.map((row) => (
                    <li key={`${row.bin_id ?? 0}`}
                        title={row.bin_path ?? row.bin_code ?? undefined}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-content1 px-2 py-1 text-[11px]">
                      <MapPin className="h-3 w-3 text-muted" />
                      <span className="font-mono font-semibold text-ink">
                        {row.bin_code ?? "No location"}
                      </span>
                      <span className="tabular-nums text-muted">
                        {fmtQty(num(row.total_qty))} at this location ·{" "}
                        <b className="text-ok">{fmtQty(num(row.drawable_qty))}</b> can give
                      </span>
                      {num(row.reserved_qty) - num(row.own_reserved_qty) - num(row.issue_hold_qty ?? 0) > 0 && (
                        <span className="text-warn">
                          · {fmtQty(num(row.reserved_qty) - num(row.own_reserved_qty)
                            - num(row.issue_hold_qty ?? 0))} held by others
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, hint, tone }: {
  label: string; value: number; hint: string; tone?: "ok" | "warn";
}) {
  const color = tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="rounded-xl border border-line/70 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color}`}>{fmtQty(value)}</div>
      <div className="text-[11px] text-muted">{hint}</div>
    </div>
  );
}
