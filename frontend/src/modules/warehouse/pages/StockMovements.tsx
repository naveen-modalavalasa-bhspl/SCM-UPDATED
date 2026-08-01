import { useNavigate } from "react-router-dom";
import { StatusPill, type Column } from "@/shared/components";
import { DocumentList } from "../components/DocumentList";
import { listStockMovements } from "../api";
import { fmtDateTime, fmtQty, humanise } from "../format";
import type { StockMovement } from "../types";

const columns: Column<StockMovement>[] = [
  {
    key: "movement",
    header: "Movement",
    render: (row) => (
      <div>
        <div className="font-mono text-xs font-semibold text-ink">{row.movement_no}</div>
        <div className="text-[11px] text-muted">{fmtDateTime(row.moved_at)}</div>
      </div>
    ),
  },
  {
    key: "item",
    header: "Item",
    render: (row) => (
      <div>
        <div className="font-mono text-xs text-ink">{row.item_code ?? "—"}</div>
        <div className="text-xs text-muted">{row.item_name ?? "—"}</div>
      </div>
    ),
  },
  {
    key: "route",
    header: "Bin movement",
    render: (row) => (
      <span className="font-mono text-xs">
        {row.source_bin_code ?? "—"} → {row.destination_bin_code ?? "—"}
      </span>
    ),
  },
  {
    key: "quantity",
    header: "Quantity",
    className: "text-right",
    render: (row) => <span className="tabular">{fmtQty(row.quantity)}</span>,
  },
  {
    key: "type",
    header: "Type",
    hideOnNarrow: true,
    render: (row) => humanise(row.movement_type),
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusPill status={row.status} />,
  },
];

export default function StockMovements() {
  const nav = useNavigate();
  return (
    <DocumentList<StockMovement>
      title="Stock movements"
      queryKey="wh-stock-movements"
      fetch={listStockMovements}
      columns={columns}
      keyOf={(row) => row.movement_no}
      searchIn={(row) => [
        row.movement_no,
        row.item_code,
        row.item_name,
        row.source_bin_code,
        row.destination_bin_code,
      ]}
      searchPlaceholder="Search movement, item or bin…"
      createTo="new"
      createLabel="New movement"
      createPermission="stock.transfer"
      onRowClick={() => undefined}
      empty="No internal stock movements recorded."
      renderCard={(row) => (
        <button
          type="button"
          className="w-full text-left"
          onClick={() => nav("new")}
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-semibold">{row.movement_no}</span>
            <StatusPill status={row.status} />
          </div>
          <div className="mt-1 text-sm">{row.item_name ?? row.item_code}</div>
          <div className="text-xs text-muted">
            {row.source_bin_code} → {row.destination_bin_code} · {fmtQty(row.quantity)}
          </div>
        </button>
      )}
    />
  );
}
