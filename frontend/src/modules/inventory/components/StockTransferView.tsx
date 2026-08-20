import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Calendar, MapPin } from "lucide-react";
import {
  Button, Card, PageHeader, ResponsiveList, StatCard, StatusPill, type Column,
  ResponsiveGrid,
} from "@/shared/components";
import { FilterBar, FilterMenu } from "./FilterBar";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { MovementKindStrip } from "../pages/StockingPointsPage";
import { listSTOs, getSTO, getWarehouses } from "../api";
import { fmtDate } from "@/shared/datetime";

/**
 * Stock transfer / movement RECORDS — read only.
 *
 * This screen used to raise transfers and walk them through approve -> dispatch ->
 * receive. It no longer does (2026-08-20, business request): a stock transfer is
 * raised and worked in the WAREHOUSE module, where the physical document, its
 * approval and its picking live. Two front doors onto the same state change meant a
 * transfer could be advanced from a screen that showed none of the warehouse checks,
 * and an approval given here bypassed the desk that actually holds the stock.
 *
 * So what is left is the register: every STO/SMO the login is allowed to see, with
 * search and filters over it, and a read-only detail sheet. No create, no approve,
 * no dispatch, no receive. Scope is unchanged — `listSTOs` is the same endpoint
 * behind the same permission, so a login sees exactly the rows it saw before and no
 * more.
 */

type STO = Record<string, any>;

const STATUS_OPTIONS = [
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "DISPATCHED", label: "Dispatched" },
  { value: "RECEIVED", label: "Received" },
];

const DATE_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
];

/** Start of the window a date filter means, or null for "all time". */
function windowStart(preset: string): Date | null {
  if (!preset) return null;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  if (preset === "week") from.setDate(from.getDate() - 7);
  if (preset === "month") from.setDate(from.getDate() - 30);
  return from;
}

export function StockTransferView() {
  const [status, setStatus] = useState("");
  const [fromWarehouse, setFromWarehouse] = useState("");
  const [toWarehouse, setToWarehouse] = useState("");
  const [raised, setRaised] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<STO | null>(null);
  const [error, setError] = useState("");

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  const { data, isLoading } = useQuery({
    queryKey: ["stos", status],
    queryFn: () => listSTOs({ status: status || undefined, size: 100 }),
  });

  // Only the warehouses that actually appear on a row: filtering by a point that
  // never sent or received anything is a dropdown of 900 dead options.
  const warehouseOptions = useMemo(() => {
    const all: STO[] = data?.items ?? [];
    const seen = new Map<string, string>();
    all.forEach((r) => {
      if (r.from_warehouse_name) seen.set(String(r.from_warehouse_id), r.from_warehouse_name);
      if (r.to_warehouse_name) seen.set(String(r.to_warehouse_id), r.to_warehouse_name);
    });
    const named = [...seen].map(([value, label]) => ({ value, label }));
    return named.length
      ? named.sort((a, b) => a.label.localeCompare(b.label))
      : (warehouses as any[]).map((w) => ({ value: String(w.id), label: w.name }));
  }, [data, warehouses]);

  const rows: STO[] = useMemo(() => {
    const all: STO[] = data?.items ?? [];
    const q = search.trim().toLowerCase();
    const from = windowStart(raised);
    return all.filter((r) => {
      if (fromWarehouse && String(r.from_warehouse_id) !== fromWarehouse) return false;
      if (toWarehouse && String(r.to_warehouse_id) !== toWarehouse) return false;
      if (from && (!r.created_at || new Date(r.created_at) < from)) return false;
      if (!q) return true;
      // Every text on the row, so the one search box answers "find that number",
      // "everything out of Vijayawada" and "what did Ramesh raise" alike.
      return [r.sto_no, r.from_warehouse_name, r.to_warehouse_name,
              r.requested_by_name, r.status]
        .some((field) => String(field ?? "").toLowerCase().includes(q));
    });
  }, [data, search, fromWarehouse, toWarehouse, raised]);

  const counts = useMemo(() => {
    const all: STO[] = data?.items ?? [];
    return {
      pending: all.filter((r) => r.status === "PENDING_APPROVAL").length,
      inTransit: all.filter((r) => r.status === "DISPATCHED").length,
      done: all.filter((r) => r.status === "RECEIVED").length,
    };
  }, [data]);

  const openDetail = useMutation({
    mutationFn: getSTO,
    onSuccess: (d: STO) => { setSelected(d); setError(""); },
    onError: (e: any) => setError(e?.response?.data?.error ?? "Could not open that record"),
  });

  const activeFilters = [search, status, fromWarehouse, toWarehouse, raised].filter(Boolean).length;

  const columns: Column<STO>[] = [
    {
      key: "sto_no",
      header: "Transfer No",
      render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.sto_no}</span>,
    },
    {
      key: "route",
      header: "Route",
      render: (r) => (
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate text-body">{r.from_warehouse_name}</span>
          <ArrowRight size={14} className="shrink-0 text-muted" />
          <span className="truncate text-body">{r.to_warehouse_name}</span>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "requested_by_name", header: "Raised By", render: (r) => r.requested_by_name ?? "—", hideOnNarrow: true },
    {
      key: "created_at", header: "Raised On", hideOnNarrow: true,
      render: (r) => fmtDate(r.created_at),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Transfer & Movement Records"
      />

      <p className="mb-4 text-sm text-muted">
        A read-only register of stock transfers between points. Raise and work a
        transfer in Warehouse.
      </p>

      <MovementKindStrip />

      <ResponsiveGrid cols={3} className="mb-4">
        <StatCard label="Awaiting Approval" value={counts.pending} tone={counts.pending ? "text-warning" : "text-muted"} />
        <StatCard label="In Transit" value={counts.inTransit} tone={counts.inTransit ? "text-brand" : "text-muted"} />
        <StatCard label="Received" value={counts.done} tone="text-success" />
      </ResponsiveGrid>

      {error && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>
      )}

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search transfer no., warehouse, raiser or status…"
        onClear={() => {
          setSearch(""); setStatus(""); setFromWarehouse(""); setToWarehouse(""); setRaised("");
        }}
        active={activeFilters}
      >
        <FilterMenu label="Raised" value={raised} onChange={setRaised}
                    options={DATE_OPTIONS} icon={<Calendar className="h-4 w-4 opacity-70" />} />
        <FilterMenu label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        <FilterMenu label="From" value={fromWarehouse} onChange={setFromWarehouse}
                    options={warehouseOptions} icon={<MapPin className="h-4 w-4 opacity-70" />} />
        <FilterMenu label="To" value={toWarehouse} onChange={setToWarehouse}
                    options={warehouseOptions} icon={<MapPin className="h-4 w-4 opacity-70" />} />
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => openDetail.mutate(r.id)}
          empty={activeFilters ? "No transfers match these filters." : "No transfers on record."}
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-sm font-semibold text-ink">{r.sto_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.from_warehouse_name} → {r.to_warehouse_name}</div>
              <div className="text-xs text-muted">{r.requested_by_name ?? "—"} · {fmtDate(r.created_at)}</div>
            </div>
          )}
        />
      </Card>

      <DetailSheet
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.sto_no ?? ""}
        subtitle={selected ? `${selected.from_warehouse_name} → ${selected.to_warehouse_name}` : undefined}
        badge={selected && <StatusPill status={selected.status} />}
        footer={<Button variant="subtle" onClick={() => setSelected(null)}>Close</Button>}
      >
        {selected && (
          <>
            <SheetSection title="Progress">
              <SheetRow label="Raised by" value={selected.requested_by_name} />
              <SheetRow label="Raised on" value={selected.created_at ? new Date(selected.created_at).toLocaleString() : null} />
              <SheetRow label="Approved by" value={selected.approved_by_name} />
              <SheetRow label="Dispatched" value={selected.dispatched_at ? new Date(selected.dispatched_at).toLocaleString() : null} />
              <SheetRow label="Received" value={selected.received_at ? new Date(selected.received_at).toLocaleString() : null} />
              <SheetRow label="Remarks" value={selected.remarks} />
            </SheetSection>

            <SheetSection title={`Items (${selected.items?.length ?? 0})`}>
              <div className="space-y-2">
                {(selected.items ?? []).map((it: any) => (
                  <div key={it.id} className="rounded-lg border border-line/70 p-3">
                    <div className="font-medium text-ink">{it.item_name}</div>
                    <div className="font-mono text-[11px] text-muted">{it.item_code}</div>
                    <div className="mt-2 flex flex-wrap gap-4 text-sm">
                      <span>Requested <strong>{it.requested_qty}</strong></span>
                      <span className="text-muted">Dispatched {it.dispatched_qty}</span>
                      <span className="text-muted">Received {it.received_qty}</span>
                      <span className="text-[11px] text-muted">{it.uom_code}</span>
                    </div>
                  </div>
                ))}
              </div>
            </SheetSection>
          </>
        )}
      </DetailSheet>
    </div>
  );
}
