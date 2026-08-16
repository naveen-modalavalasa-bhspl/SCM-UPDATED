import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Can, Card, ErrorBanner, Input, PageHeader, ResponsiveList, StatCard,
  StatusPill, useAction, type Column,
} from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { transportApi } from "../api";
import { modeLabel, modeTint } from "../components/modeCopy";
import type { TRListRow } from "../transportTypes";

const SIZE = 20;

/**
 * What is on the road, and what has landed but is not closed.
 *
 * "Share tracking" sits on the row rather than only on the detail screen: doc D5 is a
 * batch job — the logistics desk works down the list telling each site where its
 * material is — and making that four clicks deep guarantees it stops happening.
 */
export function ShipmentTrackingPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport", "tracking", search, page],
    queryFn: () => transportApi.list({
      status: "IN_TRANSIT,DELIVERED",
      search: search.trim() || undefined,
      page, size: SIZE,
    }),
  });

  const share = useAction({
    run: (id: number) => transportApi.shareTracking(id),
    success: "Tracking shared with the field",
    invalidates: [["transport"]],
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));
  const moving = rows.filter((r) => r.status === "IN_TRANSIT").length;
  const landed = rows.filter((r) => r.status === "DELIVERED").length;

  const columns: Column<TRListRow>[] = [
    {
      key: "tr",
      header: "Consignment",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.tr_no}</div>
          <div className="text-[11px] text-muted">
            {r.indent_no ? `Indent ${r.indent_no}` : r.from_warehouse_name ?? "—"}
          </div>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "mode",
      header: "Mode",
      hideOnNarrow: true,
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${modeTint(r.mode)}`}>
          {modeLabel(r.mode)}
        </span>
      ),
    },
    { key: "to", header: "Destination", render: (r) => r.to_location_name ?? "—" },
    { key: "carrier", header: "Carrier", hideOnNarrow: true, render: (r) => r.carrier_name ?? "—" },
    {
      key: "tracking",
      header: "LR / Docket",
      render: (r) => (
        <span className="font-mono text-xs">{r.lr_no ?? r.docket_no ?? "—"}</span>
      ),
    },
    {
      key: "due",
      header: "Due",
      hideOnNarrow: true,
      render: (r) => fmtDate(r.expected_delivery),
    },
    {
      key: "act",
      header: "",
      render: (r) => (
        <Can do="transport.track">
          <Button
            variant="ghost"
            onClick={() => share.mutate(r.id)}
            disabled={share.isPending}
          >
            Share tracking
          </Button>
        </Can>
      ),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Logistics" title="Shipment Tracking" />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <StatCard label="On the road" value={moving} />
        <StatCard label="Delivered, not closed" value={landed} />
      </div>

      <div className="mb-4 max-w-xs">
        <Input
          value={search}
          placeholder="TR no, LR, docket, destination…"
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      <ErrorBanner error={error ?? share.error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(`/logistics/transport/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty="Nothing in transit."
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.tr_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.to_location_name ?? "—"}</div>
              <div className="text-xs text-muted">
                {r.carrier_name ?? modeLabel(r.mode)}
                {r.lr_no || r.docket_no ? ` · ${r.lr_no ?? r.docket_no}` : ""}
              </div>
              <div className="text-[11px] text-muted">
                Raised {fmtDateTime(r.created_at)}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
