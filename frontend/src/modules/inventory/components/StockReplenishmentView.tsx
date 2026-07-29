import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { TrendingDown, Clock, FilePlus2, Info } from "lucide-react";
import { Button, Card, PageHeader, ResponsiveList, StatCard, type Column } from "@/shared/components";
import { FilterBar, FilterSelect } from "./FilterBar";
import { getReplenishments, getWarehouses } from "../api";

/**
 * Items whose available quantity has fallen under their reorder level.
 *
 * The screen raises nothing by itself. It used to carry a "Create PO" button wired to
 * a stub that threw — buying starts with an indent, so the action here hands the item
 * to the indent form and the normal approval chain takes over from there.
 */

type Row = Record<string, any>;

const CRITICALITY: Record<string, "danger" | "warning" | "default"> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "default",
};

export function StockReplenishmentView() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [criticality, setCriticality] = useState("");

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  const { data = [], isLoading } = useQuery<Row[]>({
    queryKey: ["replenishment", warehouseId, criticality],
    queryFn: () =>
      getReplenishments({
        warehouse_id: warehouseId ? Number(warehouseId) : undefined,
        criticality: criticality || undefined,
      }),
  });

  // Only the text search is client-side: the endpoint returns the full shortfall list,
  // which is small by definition, and a round trip per keystroke buys nothing.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter(
      (r) => r.item_name?.toLowerCase().includes(q) || r.item_code?.toLowerCase().includes(q),
    );
  }, [data, search]);

  const kpis = useMemo(() => {
    const critical = rows.filter((r) => ["CRITICAL", "HIGH"].includes(r.criticality)).length;
    const longLead = rows.filter((r) => (r.lead_time_days ?? 0) > 14).length;
    return { critical, longLead };
  }, [rows]);

  const raiseIndent = (r: Row) =>
    navigate(`/indents/new?item_id=${r.item_id}&quantity=${Math.ceil(r.suggested_order_qty || 0)}`);

  const columns: Column<Row>[] = [
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{r.item_name}</div>
          <div className="font-mono text-[11px] text-muted">
            {r.item_code}{r.category_name ? ` · ${r.category_name}` : ""}
          </div>
        </div>
      ),
    },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name ?? "—", hideOnNarrow: true },
    {
      key: "available",
      header: "Available",
      className: "text-right",
      render: (r) => (
        <span className="font-semibold text-danger">
          {r.available_qty} <span className="text-[11px] font-normal text-muted">{r.uom_code}</span>
        </span>
      ),
    },
    {
      key: "reorder_level",
      header: "Reorder Level",
      className: "text-right",
      render: (r) => <span className="text-body">{r.reorder_level}</span>,
    },
    {
      key: "shortfall",
      header: "Shortfall",
      className: "text-right",
      render: (r) => <span className="text-warning">{Math.max(0, r.reorder_level - r.available_qty).toFixed(2)}</span>,
    },
    {
      key: "suggested_order_qty",
      header: "Suggested Order",
      className: "text-right",
      render: (r) => <span className="font-semibold text-ink">{r.suggested_order_qty}</span>,
    },
    {
      key: "lead_time_days",
      header: "Lead Time",
      hideOnNarrow: true,
      render: (r) => (r.lead_time_days ? `${r.lead_time_days} days` : "—"),
    },
    {
      key: "criticality",
      header: "Criticality",
      render: (r) =>
        r.criticality ? (
          <Chip size="sm" variant="flat" color={CRITICALITY[r.criticality] ?? "default"}>{r.criticality}</Chip>
        ) : "—",
    },
    {
      key: "action",
      header: "",
      render: (r) => (
        <Button variant="ghost" onClick={() => raiseIndent(r)}>
          <FilePlus2 size={14} /> Raise request
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Replenishment" />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <StatCard label="Items Below Reorder" value={rows.length} icon={<TrendingDown size={16} />} tone={rows.length ? "text-danger" : "text-muted"} />
        <StatCard label="Critical / High" value={kpis.critical} tone={kpis.critical ? "text-danger" : "text-muted"} />
        <StatCard label="Lead Time > 14 days" value={kpis.longLead} icon={<Clock size={16} />} />
      </div>

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search item code or name…"
        onClear={() => { setSearch(""); setWarehouseId(""); setCriticality(""); }}
        active={[search, warehouseId, criticality].filter(Boolean).length}
      >
        <FilterSelect
          value={warehouseId}
          onChange={setWarehouseId}
          placeholder="All warehouses"
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        />
        <FilterSelect
          value={criticality}
          onChange={setCriticality}
          placeholder="Any criticality"
          options={["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((c) => ({ value: c, label: c }))}
        />
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => `${r.item_id}-${r.warehouse_id ?? 0}`}
          loading={isLoading}
          empty={
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Info className="h-5 w-5 text-muted" />
              <p className="text-sm font-medium text-ink">Nothing needs reordering</p>
              <p className="max-w-md text-sm text-muted">
                This list is built from each item's reorder level. No item currently has one set,
                so nothing can fall below it — set reorder levels in Masters &rarr; Items to switch
                this screen on.
              </p>
              <Button variant="ghost" onClick={() => navigate("/masters")}>Open Masters</Button>
            </div>
          }
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-ink">{r.item_name}</span>
                {r.criticality && (
                  <Chip size="sm" variant="flat" color={CRITICALITY[r.criticality] ?? "default"}>{r.criticality}</Chip>
                )}
              </div>
              <div className="font-mono text-[11px] text-muted">{r.item_code}</div>
              <div className="flex gap-4 text-sm">
                <span className="text-danger">Available {r.available_qty}</span>
                <span className="text-muted">Reorder at {r.reorder_level}</span>
              </div>
              <div className="text-sm">Suggested order: <strong>{r.suggested_order_qty} {r.uom_code}</strong></div>
              <Button variant="ghost" onClick={() => raiseIndent(r)}>
                <FilePlus2 size={14} /> Raise request
              </Button>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
