import { useNavigate } from "react-router-dom";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listStockMovementOrders } from "../api";
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
      createPermission="stock.transfer"
      onRowClick={() => undefined}
      empty="No stock movement orders recorded."
      renderCard={(row) => (
        <button
          type="button"
          className="w-full text-left"
          onClick={() => nav("new")} // For now goes to new, can be linked to details later
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-semibold">{row.order_no}</span>
            <StatusPill status={row.status} />
          </div>
          <div className="mt-1 text-sm">{row.warehouse_name}</div>
          <div className="text-xs text-muted">
            {row.items?.length ?? 0} lines · {row.reason ?? ""}
          </div>
        </button>
      )}
    />
  );
}
