import { useNavigate } from "react-router-dom";
import { FileText } from "lucide-react";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listStockMovementOrders, deleteStockMovement, DRAFT_DELETE_PERMISSION } from "../api";
import { fmtDateTime } from "../format";
import type { StockMovementOrder } from "../types";

const columns: Column<StockMovementOrder>[] = [
  {
    key: "movement",
    header: "Order",
    render: (row) => (
      <div>
        <div className="font-mono text-xs font-semibold text-ink">{row.order_no}</div>
        <div className="text-[11px] text-muted">{fmtDateTime(row.created_at)}</div>
      </div>
    ),
  },
  {
    key: "warehouse",
    header: "Warehouse",
    render: (row) => <div className="text-sm">{row.warehouse_name ?? "—"}</div>,
  },
  {
    key: "reason",
    header: "Reason",
    render: (row) => <div className="text-sm">{row.reason ?? "—"}</div>,
  },
  {
    key: "lines",
    header: "Lines",
    className: "text-right",
    render: (row) => <span className="tabular">{row.items?.length ?? 0}</span>,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusPill status={row.status} />,
  },
  {
    key: "user",
    header: "Created By",
    render: (row) => <div className="text-sm">{row.created_by_name ?? "—"}</div>,
  },
  {
    key: "actions",
    header: "",
    className: "w-12 text-right",
    render: (r) => (
      <div className="flex justify-end gap-1">
        <button
          type="button"
          aria-label={`Print ${r.order_no || "Draft"}`}
          title="Download PDF"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
          onClick={(e) => {
            e.stopPropagation();
            window.open(`/warehouse/stock-movements/print?order_no=${encodeURIComponent(r.order_no)}`, "_blank");
          }}
        >
          <FileText className="h-4 w-4" />
        </button>
      </div>
    ),
  },
];

export default function StockMovements() {
  const nav = useNavigate();
  return (
    <DocumentList<StockMovementOrder>
      title="Stock Movement Orders"
      queryKey="wh-stock-movement-orders"
      fetch={listStockMovementOrders}
      columns={columns}
      keyOf={(row) => row.order_no}
      searchIn={(row) => [
        row.order_no,
        row.reason ?? "",
        row.warehouse_name ?? "",
      ]}
      searchPlaceholder="Search order no, reason, warehouse…"
      createTo="new"
      createLabel="New order"
      createPermission="movement.create"
      onRowClick={(row) => nav("view?order_no=" + encodeURIComponent(row.order_no))}
      empty="No stock movement orders recorded."
      onDelete={(row) => deleteStockMovement(row.id)}
      canDelete={(row) => row.status === "DRAFT"}
      deletePermission={DRAFT_DELETE_PERMISSION.movement}
      deleteLabel="movement order"
      labelOf={(row) => row.order_no ?? `Order ${row.id}`}
      renderCard={(row) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{row.order_no}</span>
            <div className="flex items-center gap-2">
              <StatusPill status={row.status} />
              <button
                type="button"
                className="text-muted hover:text-ink p-1"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(`/warehouse/stock-movements/print?order_no=${encodeURIComponent(row.order_no)}`, "_blank");
                }}
              >
                <FileText className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-1 text-sm">{row.warehouse_name}</div>
          <div className="text-xs text-muted">
            {row.items?.length ?? 0} lines · {row.reason ?? ""}
          </div>
        </div>
      )}
    />
  );
}
