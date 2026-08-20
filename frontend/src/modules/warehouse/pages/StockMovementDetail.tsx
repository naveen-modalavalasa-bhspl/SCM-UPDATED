import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileText } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, ErrorBanner, PageHeader, StatusPill, Table } from "@/shared/components";
import { getStockMovementOrder } from "../api";
import { Section } from "../components/DocumentMeta";
import { fmtDateTime, fmtQty } from "../format";
import type { StockMovementOrderItem } from "../types";

export default function StockMovementDetail() {
  const [params] = useSearchParams();
  const orderNo = params.get("order_no");
  const nav = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-stock-movement-order", orderNo],
    queryFn: () => getStockMovementOrder(orderNo as string),
    enabled: !!orderNo,
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
              <div className="text-xs text-muted">Warehouse</div>
              <div className="text-sm">{data.warehouse_name ?? "—"}</div>
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
        <Table<StockMovementOrderItem>
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
          keyOf={(row) => row.id}
          empty="No items moved."
        />
      </Section>
    </div>
  );
}
