import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Card, ErrorBanner, PageHeader, ResponsiveList, StatCard, StatusPill, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { transportApi } from "../api";
import { modeLabel, modeTint, money } from "../components/modeCopy";
import type { TRListRow } from "../transportTypes";

const SIZE = 20;

/**
 * The tender desk: every shipment waiting for a provider.
 *
 * Two queues on one screen because they are one job — QUOTING is "still deciding",
 * READY is "decided, not yet gone". A logistics desk works down both, and splitting
 * them into two menu entries would mean checking two places to know what is
 * outstanding.
 */
export function ProviderSelectionPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport", "provider-queue", page],
    queryFn: () => transportApi.list({
      status: "QUOTING,READY", page, size: SIZE,
    }),
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));
  const quoting = rows.filter((r) => r.status === "QUOTING").length;
  const ready = rows.filter((r) => r.status === "READY").length;

  const columns: Column<TRListRow>[] = [
    {
      key: "tr",
      header: "Request",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.tr_no}</div>
          <div className="text-[11px] text-muted">{r.to_location_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "mode",
      header: "Mode",
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${modeTint(r.mode)}`}>
          {modeLabel(r.mode)}
        </span>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "load",
      header: "Load",
      className: "text-right",
      render: (r) => (
        <span className="text-sm">
          {r.total_packages} pkg · {Number(r.total_weight_kg ?? 0)} kg
        </span>
      ),
    },
    {
      key: "carrier",
      header: "Carrier",
      render: (r) => r.carrier_name ?? (
        <span className="text-amber-600">Not chosen</span>
      ),
    },
    {
      key: "freight",
      header: "Freight",
      className: "text-right",
      render: (r) => money(r.freight_amount),
    },
    {
      key: "due",
      header: "Needed by",
      hideOnNarrow: true,
      render: (r) => fmtDate(r.expected_delivery),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Logistics"
        title="Provider Selection"
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <StatCard label="Out to carriers" value={quoting} />
        <StatCard label="Awarded, awaiting dispatch" value={ready} />
      </div>

      <ErrorBanner error={error} />

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
          empty="Nothing waiting for a provider."
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.tr_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.to_location_name ?? "—"}</div>
              <div className="text-xs text-muted">
                {modeLabel(r.mode)} · {r.total_packages} pkg ·{" "}
                {r.carrier_name ?? "no carrier yet"}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
