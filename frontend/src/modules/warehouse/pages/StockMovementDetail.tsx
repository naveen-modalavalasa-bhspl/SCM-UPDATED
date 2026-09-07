import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FileText, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button, Can, Card, ErrorBanner, PageHeader, StatusPill, ResponsiveList, useToast,
} from "@/shared/components";
import { actOnStockMovementOrder, getStockMovementOrder } from "../api";
import { Section } from "../components/DocumentMeta";
import { fmtDateTime, fmtQty } from "../format";
import type { StockMovementOrderItem } from "../types";
import { TONE_APPROVE, TONE_REJECT } from "@/shared/components/tones";

export default function StockMovementDetail() {
  const [params] = useSearchParams();
  const orderNo = params.get("order_no");
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-stock-movement-order", orderNo],
    queryFn: () => getStockMovementOrder(orderNo as string),
    enabled: !!orderNo,
  });

  // Approving is what MOVES the stock — `_perform_movement_order` re-checks the shelf
  // first, because the units can be issued or picked between the press and the
  // signature. A refusal there means the order is stale, not that the approval failed.
  const act = useMutation({
    mutationFn: (action: "APPROVED" | "REJECTED") =>
      actOnStockMovementOrder((data as { id: number }).id, action),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["wh-stock-movement-order"] });
      queryClient.invalidateQueries({ queryKey: ["wh-stock-movement-orders"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-stock"] });
      toast.success(result.status === "REJECTED"
        ? `${result.order_no} rejected — nothing moved`
        : `${result.order_no} approved — the stock has moved`);
    },
  });

  if (!orderNo) {
    return <ErrorBanner error="No order number provided." />;
  }

  if (isLoading) {
    return <p className="p-8 text-sm text-muted">Loading movement details...</p>;
  }

  if (error || !data) {
    return <ErrorBanner error={error || "Movement order not found"} />;
  }

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title="Stock Movement Order"
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/stock-movements")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button
              variant="secondary"
              onClick={() => window.open(`/warehouse/stock-movements/print?order_no=${encodeURIComponent(data.order_no)}`, "_blank")}
            >
              <FileText className="h-4 w-4" /> Print
            </Button>
            {/* Only on an order that is actually waiting. `id` is 0 when no ladder is
                configured — that path moves the stock on the press and writes no
                document, so there is nothing to sign and no button to show. Gated on
                `movement.approve`, which is also what the endpoint checks: hiding a
                button is not security, the backend is. */}
            {data.status === "PENDING_APPROVAL" && data.id > 0 && (
              <Can do="movement.approve">
                <Button className={TONE_REJECT}
                  variant="secondary"
                  disabled={act.isPending}
                  onClick={() => act.mutate("REJECTED")}
                >
                  <X className="h-4 w-4" /> Reject
                </Button>
                <Button className={TONE_APPROVE}
                  disabled={act.isPending}
                  onClick={() => act.mutate("APPROVED")}
                >
                  <Check className="h-4 w-4" />
                  {act.isPending ? "Working…" : "Approve & move"}
                </Button>
              </Can>
            )}
          </>
        }
      />

      <Section title="Movement Summary">
        <Card className="p-6">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <div className="text-xs text-muted">Order No</div>
              <div className="font-mono text-sm font-semibold">{data.order_no}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Status</div>
              <div className="mt-1">
                <StatusPill status={data.status} />
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">
                {data.current_approver_name ? "Waiting on" : "Warehouse"}
              </div>
              <div className="text-sm">
                {data.current_approver_name ?? data.warehouse_name ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">Created</div>
              <div className="text-sm">{fmtDateTime(data.created_at)}</div>
            </div>
            <div className="col-span-2 md:col-span-4">
              <div className="text-xs text-muted">Reason</div>
              <div className="text-sm">{data.reason ?? "—"}</div>
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Movement Lines">
        <ResponsiveList<StockMovementOrderItem>
          columns={[
            {
              key: "item",
              header: "Item",
              render: (row) => (
                <div>
                  <div className="font-semibold text-ink">{row.item_name}</div>
                  <div className="font-mono text-[11px] text-muted">{row.item_code}</div>
                </div>
              ),
            },
            {
              key: "source",
              header: "From",
              render: (row) => (
                <div>
                  <div className="font-mono text-[11px] text-ink">{row.source_bin_code ?? "—"}</div>
                  {row.batch_id ? (
                    <div className="text-[10px] text-muted">Batch: {row.batch_id}</div>
                  ) : null}
                </div>
              ),
            },
            {
              key: "destination",
              header: "To",
              render: (row) => (
                <div className="font-mono text-[11px] text-ink">{row.destination_bin_code ?? "—"}</div>
              ),
            },
            {
              key: "qty",
              header: "Quantity",
              className: "text-right",
              render: (row) => (
                <span className="tabular text-sm text-ink">
                  {fmtQty(row.quantity)} <span className="text-xs text-muted">{row.uom_code}</span>
                </span>
              ),
            },
          ]}
          data={data.items || []}
          keyOf={(row) => row.id ?? `${row.item_id}-${row.source_bin_id}-${row.destination_bin_id}`}
          empty="No items moved."
          renderCard={(row) => (
            <div className="space-y-2">
              <div className="flex justify-between font-semibold">
                <span>{row.item_name}</span>
                <span>{fmtQty(row.quantity)} <span className="text-xs text-muted">{row.uom_code}</span></span>
              </div>
              <div className="text-sm">
                <span className="text-muted">From:</span> {row.source_bin_code ?? "—"}
                {row.batch_id ? ` (Batch: ${row.batch_id})` : ""}
              </div>
              <div className="text-sm">
                <span className="text-muted">To:</span> {row.destination_bin_code ?? "—"}
              </div>
            </div>
          )}
        />
      </Section>
    </div>
  );
}
