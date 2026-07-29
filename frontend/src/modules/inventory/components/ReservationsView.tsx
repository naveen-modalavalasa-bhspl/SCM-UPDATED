import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { Unlock, RefreshCw } from "lucide-react";
import { Button, Card, PageHeader, ResponsiveList, Select, StatusPill, Can, type Column } from "@/shared/components";
import { getReservations, releaseReservation } from "../api";
import type { ReservationRow } from "../types";

const STATUSES = [
  { value: "ACTIVE", label: "Active Holds" },
  { value: "RELEASED", label: "Released" },
  { value: "CONSUMED", label: "Consumed" },
  { value: "ALL", label: "All Statuses" },
];

export function ReservationsView() {
  const [status, setStatus] = useState("ACTIVE");
  const [error, setError] = useState("");
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["reservations", status],
    queryFn: () => getReservations({ status: status !== "ALL" ? status : undefined }),
  });
  const rows: ReservationRow[] = data?.items ?? [];

  const release = useMutation({
    mutationFn: releaseReservation,
    onSuccess: () => {
      setError("");
      qc.invalidateQueries({ queryKey: ["reservations"] });
    },
    onError: (e: any) => setError(e?.response?.data?.error ?? "Could not release the hold"),
  });

  const releaseBtn = (r: ReservationRow) =>
    r.status === "ACTIVE" ? (
      <Can do="stock.reserve">
        <Button variant="ghost" onClick={() => release.mutate(r.id)}>
          <Unlock size={14} /> Release
        </Button>
      </Can>
    ) : null;

  const columns: Column<ReservationRow>[] = [
    { key: "id", header: "ID", render: (r) => <span className="font-semibold">#{r.id}</span> },
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div>
          <div className="font-medium text-ink">{r.item_name}</div>
          <div className="text-[11px] text-muted">{r.item_code}</div>
        </div>
      ),
    },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name ?? "-" },
    { key: "quantity", header: "Reserved Qty", render: (r) => <span className="font-semibold">{r.quantity}</span> },
    {
      key: "ref",
      header: "Reference",
      hideOnNarrow: true,
      render: (r) => (
        <div>
          <Chip size="sm" variant="flat">{r.ref_type}</Chip>
          <div className="text-[11px] text-muted">{r.ref_no}</div>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "created_at",
      header: "Created",
      hideOnNarrow: true,
      render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : "-"),
    },
    { key: "actions", header: "", render: releaseBtn },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Reservations"
        actions={
          <>
            <Select value={status} onChange={setStatus} options={STATUSES} className="w-44" />
            <Button variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ["reservations"] })}>
              <RefreshCw size={14} /> Refresh
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>
      )}

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          empty="No reservations."
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{r.item_name}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-xs text-muted">{r.item_code} · {r.warehouse_name}</div>
              <div className="text-sm">Reserved: <strong>{r.quantity}</strong></div>
              <div className="text-xs text-muted">{r.ref_type} {r.ref_no}</div>
              {releaseBtn(r)}
            </div>
          )}
        />
      </Card>
    </div>
  );
}
