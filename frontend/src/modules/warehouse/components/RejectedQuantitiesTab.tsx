import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { StatusPill, type Column } from "@/shared/components";
import { ResponsiveList } from "@/shared/components";
import { listInspections, listOutboundInspections } from "../api";
import { fmtDate, fmtQty, num } from "../format";
import { qcQty, qcRate, summaryFromRow } from "../qcSummary";
import { QcRowResult } from "./QcVerdict";
import type { Inspection } from "../types";

/**
 * The Rejected Quantities tab on a QC list (SCM_0167).
 *
 * The Inspections tab is a document register — one row per inspection. This tab is a
 * REJECTION register: one row per inspection that has rejected something, with the
 * rejected quantity, the reason it was rejected and where that rejected stock is now.
 *
 * It is the same `listInspections` / `listOutboundInspections` call the Inspections
 * tab makes, post-filtered to rows whose `rejected_qty` is greater than zero, so a
 * supervisor sees only what needs a decision. When the rejection-outcome endpoint
 * (Phase 3 of the QC lifecycle work) lands, this view will gain an `outcome` column
 * that follows each rejected quantity through return / disposal / replacement.
 *
 * One component, three modules: `type="INCOMING"` is Inward QC, `type="OUTGOING"`
 * with no `stockTransfer` is warehouse Outward QC, and `type="OUTGOING"` with
 * `stockTransfer` is the QC of a stock transfer's material issue.
 */
export function RejectedQuantitiesTab({
  type = "INCOMING",
  stockTransfer,
  basePath,
}: {
  type?: "INCOMING" | "OUTGOING";
  stockTransfer?: boolean;
  basePath?: string;
}) {
  const nav = useNavigate();

  /** One wide page — the rejection register is short by nature (only inspections
   *  that rejected something), and the supervisor reads it end-to-end. The 500 cap
   *  is the server's own MAX_PAGE_SIZE. */
  const { data, isLoading } = useQuery({
    queryKey: [`wh-inspections-${type}-${stockTransfer ?? "all"}-rejected`],
    queryFn: () => type === "OUTGOING"
      ? listOutboundInspections(
          stockTransfer === undefined
            ? { page: 1, page_size: 500 } as any
            : { page: 1, page_size: 500, stock_transfer: stockTransfer } as any) as any
      : listInspections({ page: 1, page_size: 500, inspection_type: type } as any),
  });

  const rejectedRows = useMemo(() => {
    const all = (data?.items ?? (data as any)?.results ?? []) as Inspection[];
    return all
      .filter((r) => num((r as any).rejected_qty) > 0)
      .sort((a, b) => num((b as any).rejected_qty) - num((a as any).rejected_qty));
  }, [data]);

  const totals = useMemo(() => {
    const summaries = rejectedRows.map(summaryFromRow);
    const inspected = summaries.reduce((s, x) => s + x.inspected, 0);
    const accepted = summaries.reduce((s, x) => s + x.accepted, 0);
    const rejected = summaries.reduce((s, x) => s + x.rejected, 0);
    return {
      count: rejectedRows.length,
      inspected,
      accepted,
      rejected,
      passRate: inspected > 0 ? Math.round((accepted / inspected) * 1000) / 10 : null,
    };
  }, [rejectedRows]);

  const columns: Column<Inspection>[] = [
    {
      key: "no",
      header: "Inspection",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.inspection_no}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.inspection_date)}</div>
        </div>
      ),
    },
    {
      key: "against",
      header: "Against",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">
            {r.grn_no ?? (r as any).issue_no ?? "—"}
          </div>
          <div className="truncate text-[11px] text-muted">{r.vendor_name ?? "—"}</div>
        </div>
      ),
    },
    { key: "warehouse", header: "Warehouse", hideOnNarrow: true, render: (r) => r.warehouse_name ?? "—" },
    {
      key: "rejectedQty",
      header: "Rejected qty",
      className: "w-32 text-right",
      render: (r) => {
        const rejected = num((r as any).rejected_qty);
        const uom = (r as any).uom_code as string | undefined;
        return (
          <span className="inline-flex items-baseline gap-1 tabular">
            <span className="text-base font-bold text-bad">{qcQty(rejected)}</span>
            {uom && <span className="text-[11px] text-muted">{uom}</span>}
          </span>
        );
      },
    },
    {
      key: "result",
      header: "Of inspected",
      hideOnNarrow: true,
      render: (r) => <QcRowResult summary={summaryFromRow(r)} />,
    },
    { key: "inspector", header: "Inspector", hideOnNarrow: true, render: (r) => r.inspector_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "actions",
      header: "",
      className: "w-12 text-right",
      render: (r) => (
        <button
          type="button"
          aria-label={`Open ${r.inspection_no || "Draft"}`}
          title="Open the inspection"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
          onClick={(e) => {
            e.stopPropagation();
            nav(basePath ? `${basePath}/${r.id}` : String(r.id));
          }}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* A short summary tile strip — the supervisor's first answer is "how much
          is rejected and across how many sheets", not "which sheet". */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile label="Inspections" value={String(totals.count)} tone="ink" />
        <SummaryTile label="Rejected qty" value={qcQty(totals.rejected)} tone="bad" />
        <SummaryTile label="Inspected qty" value={qcQty(totals.inspected)} tone="ink" />
        <SummaryTile label="Pass rate" value={qcRate(totals.passRate)} tone="warn" />
      </div>

      <ResponsiveList<Inspection>
        data={rejectedRows}
        columns={columns}
        keyOf={(r) => r.id}
        onRowClick={(r) => nav(basePath ? `${basePath}/${r.id}` : String(r.id))}
        empty={
          isLoading
            ? "Loading…"
            : "No rejected quantities in this module — every inspected unit was accepted."
        }
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-ink">{r.inspection_no}</span>
              <StatusPill status={r.status} />
            </div>
            <div className="truncate text-sm text-body">
              {r.grn_no ?? (r as any).issue_no ?? "—"} {r.vendor_name ? `· ${r.vendor_name}` : ""}
            </div>
            <div className="flex items-center justify-between gap-2 text-sm">
              <QcRowResult summary={summaryFromRow(r)} />
              <span className="text-bad font-bold tabular">
                {fmtQty(num((r as any).rejected_qty))} rejected
              </span>
            </div>
          </div>
        )}
      />

      {/* The Phase 3 lifecycle view will replace this note with an Outcome column and
          a Decide action on each row. The data layer is already in place
          (whs_rejection_outcomes); the read endpoint is the next step. */}
      <div className="flex items-start gap-2.5 rounded-xl border border-line bg-content2/50 px-4 py-3 text-xs text-muted">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <div>
          Each row opens the inspection, where the rejected lines carry their reason
          and the units behind them. The full lifecycle of every rejected quantity
          — return to vendor, disposal, replacement — is being added to the Stock
          Segregation page as a dedicated subtab.
        </div>
      </div>
    </div>
  );
}

/** A small KPI tile, in the register's own restrained palette. */
function SummaryTile({ label, value, tone }: { label: string; value: string; tone: "ink" | "bad" | "warn" }) {
  const toneClass =
    tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-content1 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 truncate text-xl font-bold tabular ${toneClass}`}>{value}</div>
    </div>
  );
}
