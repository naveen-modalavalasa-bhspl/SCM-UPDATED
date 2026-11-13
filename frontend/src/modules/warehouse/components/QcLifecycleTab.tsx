import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Button, Can, ConfirmModal, ErrorBanner, ResponsiveList, type Column } from "@/shared/components";
import { alerts } from "@/modules/alerts";
import {
  decideRejectionOutcome,
  getRejectionSummary,
  listRejectionOutcomes,
} from "../api";
import { fmtDate, fmtQty, num } from "../format";
import type {
  RejectionDirection, RejectionOutcome, RejectionOutcomeState,
} from "../types";

/**
 * The Combined QC Lifecycle subtab on Stock Segregation (SCM_0168).
 *
 * One register, three doors. Every line any QC sheet — Inward, Outward, Stock
 * Transfer — turned away lands here as one row, PENDING a decision. The supervisor
 * follows each rejected quantity from the inspection that found it to the document
 * that carried it out: a purchase return (RETURNED_TO_VENDOR), a disposal note
 * (DISPOSED), a put-back (RETURNED_TO_STOCK), or a fresh GRN (REPLACED).
 *
 * Grouped by item and inspection number, because that is the question a supervisor
 * asks across the dock — "where did THIS rejection go?" — and the inspection that
 * found it is the only honest segregation.
 */

const DIRECTION_LABEL: Record<RejectionDirection, string> = {
  INWARD: "Inward QC",
  OUTWARD: "Outward QC",
  STOCK_TRANSFER: "Stock transfer QC",
};

const OUTCOME_LABEL: Record<RejectionOutcomeState, string> = {
  PENDING: "Pending",
  DISPOSED: "Disposed",
  RETURNED_TO_VENDOR: "Returned to vendor",
  RETURNED_TO_STOCK: "Returned to stock",
  REPLACED: "Replaced",
};

const OUTCOME_TONE: Record<RejectionOutcomeState, "warn" | "ok" | "bad" | "idle"> = {
  PENDING: "warn",
  DISPOSED: "bad",
  RETURNED_TO_VENDOR: "ok",
  RETURNED_TO_STOCK: "ok",
  REPLACED: "ok",
};

const OUTCOME_OPTIONS: { value: Exclude<RejectionOutcomeState, "PENDING">; label: string }[] = [
  { value: "RETURNED_TO_VENDOR", label: "Return to vendor" },
  { value: "RETURNED_TO_STOCK", label: "Return to stock" },
  { value: "DISPOSED", label: "Dispose" },
  { value: "REPLACED", label: "Mark replaced" },
];

/** The pill on each row — the outcome as a sentence, with its tone. */
function OutcomePill({ outcome }: { outcome: RejectionOutcomeState }) {
  const tone = OUTCOME_TONE[outcome];
  const cls =
    tone === "warn" ? "bg-warn-bg text-warn border-warn/30"
    : tone === "ok" ? "bg-ok-bg text-ok border-ok/25"
    : tone === "bad" ? "bg-bad-bg text-bad border-bad/25"
    : "bg-surface-2 text-muted border-line";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

/** The named units a rejection turned away, in one short line. */
const unitCodeLine = (codes: RejectionOutcome["unit_codes"]): string => {
  if (!codes || codes.length === 0) return "";
  const samples = codes.slice(0, 3).map((c) => c.code);
  const more = codes.length > 3 ? ` +${codes.length - 3} more` : "";
  return samples.join(", ") + more;
};

export function QcLifecycleTab() {
  const qc = useQueryClient();
  const [deciding, setDeciding] = useState<RejectionOutcome | null>(null);
  const [action, setAction] = useState<Exclude<RejectionOutcomeState, "PENDING"> | "">("");
  const [docNo, setDocNo] = useState("");
  const [remarks, setRemarks] = useState("");

  const outcomesQuery = useQuery({
    queryKey: ["wh-rejection-outcomes"],
    queryFn: () => listRejectionOutcomes(),
  });
  const summaryQuery = useQuery({
    queryKey: ["wh-rejection-outcomes-summary"],
    queryFn: () => getRejectionSummary(),
  });

  /** A flattened, sorted view for the table — grouped rows are clearer as a list of
   *  rejections, with the item code as the first column acting as the grouping. */
  const flatRows = useMemo(() => {
    const rows = outcomesQuery.data ?? [];
    return [...rows].sort((a, b) => {
      const itemCmp = (a.item_code ?? "").localeCompare(b.item_code ?? "");
      if (itemCmp !== 0) return itemCmp;
      return (a.inspection_no ?? "").localeCompare(b.inspection_no ?? "");
    });
  }, [outcomesQuery.data]);

  const decide = useMutation({
    mutationFn: () => {
      if (!deciding || !action) throw new Error("Choose a decision");
      return decideRejectionOutcome(deciding.id, {
        action: action as Exclude<RejectionOutcomeState, "PENDING">,
        remarks: remarks || null,
        doc_no: docNo || null,
      });
    },
    onSuccess: () => {
      void alerts.success("rejection.decided", { action: OUTCOME_LABEL[action as RejectionOutcomeState] });
      qc.invalidateQueries({ queryKey: ["wh-rejection-outcomes"] });
      qc.invalidateQueries({ queryKey: ["wh-rejection-outcomes-summary"] });
      setDeciding(null);
      setAction("");
      setDocNo("");
      setRemarks("");
    },
  });

  const columns: Column<RejectionOutcome>[] = [
    {
      key: "inspection",
      header: "Inspection",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.inspection_no ?? "—"}</div>
          <div className="text-[11px] text-muted">{fmtDate(r.created_at)}</div>
        </div>
      ),
    },
    {
      key: "direction",
      header: "Source QC",
      render: (r) => (
        <span className="inline-flex rounded-md border border-line bg-content2/60 px-1.5 py-0.5 text-[11px] font-semibold text-body">
          {DIRECTION_LABEL[r.direction]}
        </span>
      ),
    },
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold text-ink">{r.item_code ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{r.item_name ?? "—"}</div>
          {r.batch_no && <div className="text-[11px] text-muted">batch {r.batch_no}</div>}
        </div>
      ),
    },
    {
      key: "rejectedQty",
      header: "Rejected",
      className: "w-28 text-right tabular",
      render: (r) => (
        <span className="inline-flex items-baseline gap-1 tabular">
          <span className="text-base font-bold text-bad">{fmtQty(num(r.rejected_qty))}</span>
          {r.uom_code && <span className="text-[11px] text-muted">{r.uom_code}</span>}
        </span>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      hideOnNarrow: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-body">{r.rejection_reason ?? "—"}</div>
          {r.unit_codes?.length ? (
            <div className="truncate text-[11px] font-mono text-muted">{unitCodeLine(r.unit_codes)}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: "outcome",
      header: "Outcome",
      render: (r) => <OutcomePill outcome={r.outcome} />,
    },
    {
      key: "trail",
      header: "Decision",
      hideOnNarrow: true,
      render: (r) => r.outcome === "PENDING" ? (
        <span className="text-[11px] text-muted">Awaiting decision</span>
      ) : (
        <div className="min-w-0">
          <div className="truncate text-[11px] text-muted">{r.outcome_by_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{fmtDate(r.outcome_at)}</div>
          {r.outcome_doc_no && (
            <div className="truncate text-[11px] font-mono text-body">doc {r.outcome_doc_no}</div>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "w-12 text-right",
      render: (r) => (
        <Can do="stock.rejection.manage">
          {r.outcome === "PENDING" ? (
            <Button variant="soft" onClick={(e: any) => { e.stopPropagation(); setDeciding(r); }}>
              Decide <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <span className="text-[11px] text-muted">closed</span>
          )}
        </Can>
      ),
    },
  ];

  const summary = summaryQuery.data;
  const pending = summary?.by_outcome?.PENDING ?? 0;
  const pendingQty = summary?.qty_by_outcome?.PENDING ?? 0;

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* KPI strip — the supervisor's first answer is "how much is still pending a
          decision", across all three QC doors. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile label="Pending decisions" value={String(pending)} tone="warn" />
        <SummaryTile label="Pending qty" value={fmtQty(pendingQty)} tone="warn" />
        <SummaryTile label="Total rejected qty" value={fmtQty(summary?.total_qty ?? 0)} tone="bad" />
        <SummaryTile label="Closed decisions"
          value={String(
            Object.entries(summary?.by_outcome ?? {})
              .filter(([k]) => k !== "PENDING")
              .reduce((s, [, v]) => s + v, 0)
          )}
          tone="ok" />
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Every line a QC sheet — inward, outward, or stock transfer — turned away.
          Each row is one rejected line; <span className="text-ink font-semibold">Decide</span> closes it.
        </p>
        <Button variant="ghost" onClick={() => {
          qc.invalidateQueries({ queryKey: ["wh-rejection-outcomes"] });
          qc.invalidateQueries({ queryKey: ["wh-rejection-outcomes-summary"] });
        }}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <ErrorBanner error={outcomesQuery.error ?? decide.error} />

      <div className="bg-content1 rounded-xl shadow-sm border border-line/50 overflow-hidden">
        <ResponsiveList<RejectionOutcome>
          data={flatRows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={outcomesQuery.isLoading}
          empty="No rejections on the register — every QC door's accepted quantity went straight in."
          renderCard={(r) => (
            <div className="space-y-1 p-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.inspection_no}</span>
                <OutcomePill outcome={r.outcome} />
              </div>
              <div className="truncate text-sm font-medium text-body">{r.item_name ?? r.item_code}</div>
              <div className="text-[11px] text-muted flex items-center gap-2">
                <span className="bg-content2 px-1.5 py-0.5 rounded text-bad font-bold tabular">
                  {fmtQty(num(r.rejected_qty))} rejected
                </span>
                <span>·</span>
                <span>{DIRECTION_LABEL[r.direction]}</span>
              </div>
            </div>
          )}
        />
      </div>

      {/* The decision modal — a terminal close on one rejection. */}
      <ConfirmModal
        isOpen={!!deciding}
        title={deciding ? `Decide on ${deciding.inspection_no ?? "this rejection"} — ${deciding.item_code ?? ""}` : ""}
        message={
          deciding ? (
            <div className="space-y-3">
              <p className="text-sm text-body">
                <span className="font-bold text-bad tabular">{fmtQty(num(deciding.rejected_qty))}</span>{" "}
                {deciding.uom_code ?? "units"} of{" "}
                <span className="font-semibold text-ink">{deciding.item_name ?? deciding.item_code}</span>
                {deciding.batch_no ? ` (batch ${deciding.batch_no})` : ""} rejected by{" "}
                <span className="font-semibold">{DIRECTION_LABEL[deciding.direction]}</span>
                {deciding.rejection_reason ? ` — ${deciding.rejection_reason}` : ""}.
              </p>
              <div className="space-y-2">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Decision</span>
                  <select
                    className="mt-1 w-full rounded-lg border border-line bg-content1 px-3 py-2 text-sm"
                    value={action}
                    onChange={(e) => setAction(e.target.value as Exclude<RejectionOutcomeState, "PENDING">)}
                  >
                    <option value="">Choose an outcome…</option>
                    {OUTCOME_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Carrier document no.</span>
                  <input
                    type="text"
                    className="mt-1 w-full rounded-lg border border-line bg-content1 px-3 py-2 text-sm font-mono"
                    placeholder="e.g. PR-2026-0014 / GRN-2026-0089"
                    value={docNo}
                    onChange={(e) => setDocNo(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Remarks</span>
                  <textarea
                    className="mt-1 w-full rounded-lg border border-line bg-content1 px-3 py-2 text-sm"
                    rows={2}
                    placeholder="Optional — what backed this decision"
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                  />
                </label>
              </div>
              <p className="text-xs text-muted">
                A rejection is closed once. The outcome and the carrier document number
                are written here and on the audit trail.
              </p>
            </div>
          ) : null
        }
        confirmLabel="Close this rejection"
        busy={decide.isPending}
        danger={action === "DISPOSED"}
        onConfirm={() => decide.mutate()}
        onClose={() => { setDeciding(null); setAction(""); setDocNo(""); setRemarks(""); }}
      />
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: string; tone: "ink" | "bad" | "warn" | "ok" }) {
  const toneClass =
    tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-content1 px-4 py-3 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 truncate text-xl font-bold tabular ${toneClass}`}>{value}</div>
    </div>
  );
}
