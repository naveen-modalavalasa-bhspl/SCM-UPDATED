import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Snowflake } from "lucide-react";
import {
  Card, ErrorBanner, PageHeader, Select, StatusPill, useToast,
} from "@/shared/components";
import { Button } from "../components/ActionButton";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import { errorMessage } from "@/shared/api/errors";
import { poApi, rfqApi } from "../api";
import type { RFQListRow } from "../types";
import { QuotationComparison } from "../components/QuotationComparison";
import { money } from "./RequisitionListPage";

const SIZE = 50;

/** The verdict band, above the sheet. Everything on it is SERVED by
 *  `GET /api/rfqs/{id}/comparison` — the screen ranks nothing and decides
 *  nothing; it only states what the arithmetic already said. */
function VerdictBand({ comparison, frozen }: {
  comparison: NonNullable<ReturnType<typeof useVerdict>["data"]>;
  frozen: boolean;
}) {
  const best = (comparison.totals ?? []).find((t) => t.is_recommended);
  const next = (comparison.totals ?? [])
    .filter((t) => !t.is_recommended)
    .sort((a, b) => a.grand_total - b.grand_total)[0];
  const deltaPct = best && next && best.grand_total > 0
    ? ((next.grand_total - best.grand_total) / best.grand_total) * 100
    : null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {frozen && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">
          <Snowflake className="h-3.5 w-3.5" />
          Prices frozen{comparison.rfq?.frozen_at
            ? ` ${fmtDate(comparison.rfq.frozen_at)}` : ""}
          {comparison.rfq?.frozen_by_name ? ` · by ${comparison.rfq.frozen_by_name}` : ""}
        </span>
      )}
      <span className="rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium text-body">
        Ranked by {String(comparison.evaluation_method ?? "landed cost").replace(/_/g, " ")}
      </span>
      {best && (
        <span className="rounded-full border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-semibold text-success">
          Suggested: {best.vendor_name} · {money(best.grand_total)}
        </span>
      )}
      {next && deltaPct != null && (
        <span className={`rounded-full px-3 py-1.5 text-xs font-medium ${
          deltaPct > 0 ? "bg-warn-bg text-warn" : "bg-surface-2 text-body"}`}>
          Next best {next.vendor_name} at {money(next.grand_total)}
          {deltaPct > 0 ? ` (+${deltaPct.toFixed(1)}%)` : ""}
        </span>
      )}
    </div>
  );
}

/** Typed bridge so the band can name the comparison payload without a second
 *  definition of it. */
function useVerdict(rfqId: number, method: string) {
  return useQuery({
    queryKey: ["rfq-comparison", rfqId, method],
    queryFn: () => rfqApi.comparison(rfqId, method || undefined),
    enabled: Number.isFinite(rfqId) && rfqId > 0,
  });
}

/**
 * Price Compare — the war room (2026-09-26).
 *
 * The RFQ page says WHAT we asked; the Quotations page says WHAT ONE SUPPLIER
 * answered; this screen is where the answers meet. One RFQ picked at the top,
 * every quotation to it side by side underneath, and the award — which moved
 * here from the RFQ detail so the tender room never carries another vendor's
 * price. `QuotationComparison` renders the sheet itself, unmodified: it is the
 * only comparison renderer in the product, and this page is now its only home.
 */
export function PriceComparePage() {
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canFreeze = can("rfq.approve");
  const [params, setParams] = useSearchParams();
  const rfqId = Number(params.get("rfq") ?? 0);
  const [method, setMethod] = useState("");

  // The tenders a comparison makes sense on: open or already awarded, with at
  // least one reply. A DRAFT has nothing to compare and a CANCELLED was never
  // worth opening — neither belongs in the dropdown.
  const { data: rfqPage } = useQuery({
    queryKey: ["price-compare-rfqs"],
    queryFn: () => rfqApi.list({ status: "PUBLISHED", page: 1, size: SIZE }),
  });
  const { data: rfqClosed } = useQuery({
    queryKey: ["price-compare-rfqs-closed"],
    queryFn: () => rfqApi.list({ status: "CLOSED", page: 1, size: SIZE }),
  });
  const { data: rfqAwarded } = useQuery({
    queryKey: ["price-compare-rfqs-awarded"],
    queryFn: () => rfqApi.list({ status: "AWARDED", page: 1, size: SIZE }),
  });

  const options: RFQListRow[] = useMemo(() => {
    const seen = new Set<number>();
    const merged: RFQListRow[] = [];
    for (const page of [rfqPage, rfqClosed, rfqAwarded]) {
      for (const row of page?.items ?? []) {
        if (row.response_count > 0 && !seen.has(row.id)) {
          seen.add(row.id);
          merged.push(row);
        }
      }
    }
    return merged.sort((a, b) => b.id - a.id);
  }, [rfqPage, rfqClosed, rfqAwarded]);

  // Deep links land pre-selected (`?rfq=` from the RFQ page's Compare & Award
  // button). Without a selection the page asks for one instead of guessing —
  // picking a tender FOR the buyer would put somebody else's decision on their
  // screen.
  useEffect(() => {
    if (!rfqId && options.length > 0) return;
  }, [rfqId, options.length]);

  const { data: rfq } = useQuery({
    queryKey: ["rfq", String(rfqId)],
    queryFn: () => rfqApi.get(rfqId),
    enabled: rfqId > 0,
  });

  const { data: methods } = useQuery({
    queryKey: ["rfq-evaluation-methods"],
    queryFn: rfqApi.evaluationMethods,
    enabled: rfqId > 0,
  });

  const comparison = useVerdict(rfqId, method);

  // Previewing a different ranking is a query parameter, not a save — same rule
  // the RFQ form holds: looking at the quotes another way is not choosing one.
  useEffect(() => {
    if (comparison.data && !method) setMethod("");
  }, [comparison.data, method]);

  // ── Award + PO, ported from RFQDetailPage unchanged in behaviour ────────
  const awardedQuoteIds = (comparison.data?.quotations ?? [])
    .filter((q) => q.status === "ACCEPTED").map((q) => q.id);

  const busy = comparison.isLoading;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["rfq-comparison", rfqId] });
    queryClient.invalidateQueries({ queryKey: ["rfq", String(rfqId)] });
    queryClient.invalidateQueries({ queryKey: ["price-compare-rfqs"] });
    queryClient.invalidateQueries({ queryKey: ["pos"] });
  };

  const raisePo = useMutation({
    mutationFn: (quotationId: number) => poApi.createFromQuotation(quotationId),
    onSuccess: (po) => {
      refresh();
      toast.success(`${po.po_no} raised from ${po.vendor_name ?? "the winner"}`);
      nav(`/pos/${po.id}`);
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });

  const award = useMutation({
    mutationFn: (quotationIds: number[]) => rfqApi.award(rfqId, quotationIds),
    onSuccess: (updated) => {
      refresh();
      toast.success(`Awarded to ${updated.awarded_vendor_name ?? "the selected supplier"} and PO generated`);
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });

  const awardSplit = useMutation({
    mutationFn: (allocations: { item_id: number; rfq_item_id?: number; vendor_id: number; quantity: number }[]) =>
      rfqApi.awardSplit(rfqId, allocations),
    onSuccess: () => {
      refresh();
      toast.success("Items awarded and POs generated for each supplier");
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });

  // Freeze Prices (SCM_0057): awarding and raising a PO both refuse an unfrozen
  // tender (`award_rfq` on the server), but this screen used to have no way to
  // freeze — only a badge once it already was, and a dead-end warning pointing
  // the buyer back to the RFQ page. Same mutation RFQDetailPage already uses.
  const freeze = useMutation({
    mutationFn: () => rfqApi.freeze(rfqId),
    onSuccess: () => {
      refresh();
      toast.success("Prices frozen — suppliers can no longer change their quotes");
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        back={{ to: "/procurement/rfqs", label: "Back to RFQs" }}
        eyebrow="Procurement"
        title="Compare Quotations"
        actions={rfq?.is_price_frozen ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">
            <Snowflake className="h-3.5 w-3.5" /> Frozen
          </span>
        ) : rfqId > 0 && canFreeze ? (
          <Button
            className="bg-amber-600 hover:bg-amber-700 text-white font-medium shadow-sm inline-flex items-center gap-1.5"
            disabled={freeze.isPending}
            onClick={() => freeze.mutate()}
          >
            <Lock className="h-4 w-4" /> {freeze.isPending ? "Freezing…" : "Freeze prices"}
          </Button>
        ) : undefined}
      />

      {/* The tender picker. Sticky so the identity of the sheet stays on screen
          while a ten-vendor grid scrolls under it. */}
      <Card className="sticky top-2 z-20 mb-4 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[280px] flex-1">
            <Select
              value={rfqId ? String(rfqId) : ""}
              placeholder="Pick a tender to compare…"
              options={options.map((r) => {
                const titleStr = r.title && r.title.trim() !== "" && r.title !== "Untitled" ? ` · ${r.title}` : "";
                return {
                  value: String(r.id),
                  label: `${r.rfq_no}${titleStr} · ${r.response_count} quote${r.response_count === 1 ? "" : "s"}`,
                };
              })}
              onChange={(value) => {
                const next = new URLSearchParams(params);
                next.set("rfq", value);
                setParams(next, { replace: true });
                setMethod("");
              }}
            />
          </div>
          <div className="w-56">
            <Select
              value={method || comparison.data?.evaluation_method || ""}
              placeholder="Rank by…"
              options={(methods ?? []).map((m) => ({ value: m.value, label: m.label }))}
              onChange={setMethod}
            />
          </div>
        </div>
      </Card>

      <ErrorBanner error={comparison.error ?? freeze.error} />

      {rfqId > 0 && comparison.data && (
        <>
          <VerdictBand comparison={comparison.data} frozen={!!rfq?.is_price_frozen} />
          <QuotationComparison
            comparison={comparison.data}
            awardedQuotationIds={awardedQuoteIds}
            purchaseOrders={rfq?.purchase_orders ?? []}
            busy={busy || award.isPending || awardSplit.isPending || raisePo.isPending || freeze.isPending}
            reawardable={rfq?.status === "AWARDED"}
            liveAllocatedQuantities={Object.fromEntries(
              (rfq?.vendors ?? [])
                .filter((v) => v.live_allocated_quantities)
                .map((v) => [v.vendor_id,
                  v.live_allocated_quantities as Record<string, number>]),
            )}
            onAward={(ids) => award.mutate(ids)}
            onAwardSplit={(allocations) => awardSplit.mutate(allocations)}
            onCreatePo={(quoteId) => raisePo.mutate(quoteId)}
            onOpenPo={(poId) => nav(`/pos/${poId}`)}
          />
          {!rfq?.is_price_frozen && (
            <p className="mt-3 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
              {canFreeze
                ? "Prices on this tender are not frozen yet — freeze them above before "
                  + "awarding or raising purchase orders."
                : "Prices on this tender are not frozen yet — ask a buyer with approval "
                  + "rights to freeze them before awarding or raising purchase orders."}
            </p>
          )}
        </>
      )}

      {rfqId > 0 && !comparison.isLoading && comparison.data
        && (comparison.data.responded ?? 0) === 0 && (
        <Card className="p-8 text-center">
          <StatusPill status="PUBLISHED" />
          <p className="mt-3 text-sm text-muted">
            No supplier has answered this tender yet — the sheet fills itself as
            quotations arrive.
          </p>
        </Card>
      )}

      {rfqId === 0 && (
        <Card className="p-10 text-center">
          <p className="text-sm font-semibold text-ink">Pick a tender above</p>
          <p className="mt-1 text-sm text-muted">
            Every quotation to the tender you pick appears here, side by side, with
            the ranking and the award — nothing is compared until you choose.
          </p>
        </Card>
      )}
    </div>
  );
}
