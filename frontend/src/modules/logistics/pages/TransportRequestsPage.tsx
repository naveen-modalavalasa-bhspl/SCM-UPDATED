import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Can, Card, ErrorBanner, Input, PageHeader, ResponsiveList, Select,
  StatusPill, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { transportApi } from "../api";
import { modeLabel, modeTint, money, TR_STATUSES } from "../components/modeCopy";
import type { TRListRow } from "../transportTypes";

const SIZE = 20;

const MODES = [
  { value: "", label: "All modes" },
  { value: "DIRECT", label: "Hand-over" },
  { value: "COURIER", label: "Courier" },
  { value: "OWN_VEHICLE", label: "Own vehicle" },
  { value: "THIRD_PARTY", label: "Third-party" },
];

/**
 * The transport register — every consignment the warehouse has asked to move.
 *
 * The mode chip is the first thing on the row on purpose: it is what decides what
 * happens next (tender it, book a courier, or just record who carried it), so a
 * logistics desk sorting its day reads that before the status.
 */
export function TransportRequestsPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport", status, mode, search, page],
    queryFn: () => transportApi.list({
      status: status || undefined,
      mode: mode || undefined,
      search: search.trim() || undefined,
      page, size: SIZE,
    }),
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));

  const columns: Column<TRListRow>[] = [
    {
      key: "tr",
      header: "Request",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.tr_no}</div>
          <div className="text-[11px] text-muted">
            {r.indent_no ? `Indent ${r.indent_no}` : fmtDate(r.tr_date)}
          </div>
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
      key: "route",
      header: "Route",
      hideOnNarrow: true,
      render: (r) => (
        <div className="min-w-0 text-sm">
          <div className="truncate text-body">{r.to_location_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">
            from {r.from_warehouse_name ?? "—"}
          </div>
        </div>
      ),
    },
    {
      key: "carrier",
      header: "Carrier",
      hideOnNarrow: true,
      render: (r) => r.carrier_name ?? <span className="text-muted">Not set</span>,
    },
    {
      key: "load",
      header: "Load",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => (
        <span className="text-sm text-body">
          {r.total_packages} pkg · {Number(r.total_weight_kg ?? 0)} kg
        </span>
      ),
    },
    {
      key: "tracking",
      header: "LR / Docket",
      hideOnNarrow: true,
      render: (r) => (
        <span className="font-mono text-xs">{r.lr_no ?? r.docket_no ?? "—"}</span>
      ),
    },
    {
      key: "freight",
      header: "Freight",
      className: "text-right",
      render: (r) => (
        <span className="font-semibold text-ink">{money(r.freight_amount)}</span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Logistics"
        title="Transport Requests"
        actions={
          <Can do="transport.create">
            <Button onClick={() => nav("/logistics/transport/new")}>
              New request
            </Button>
          </Can>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <div className="w-full max-w-xs">
          <Select
            value={status}
            options={TR_STATUSES}
            onChange={(value) => { setStatus(String(value)); setPage(1); }}
          />
        </div>
        <div className="w-full max-w-[12rem]">
          <Select
            value={mode}
            options={MODES}
            onChange={(value) => { setMode(String(value)); setPage(1); }}
          />
        </div>
        <div className="w-full max-w-xs">
          <Input
            value={search}
            placeholder="TR no, LR, docket, indent…"
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
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
          empty={
            status || mode || search
              ? "No transport requests match that."
              : "No transport requests yet. Raise one when the warehouse has something to move."
          }
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.tr_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${modeTint(r.mode)}`}>
                  {modeLabel(r.mode)}
                </span>
                <span className="text-sm text-body">{r.to_location_name ?? "—"}</span>
              </div>
              <div className="text-xs text-muted">
                {r.total_packages} pkg · {Number(r.total_weight_kg ?? 0)} kg
                {r.carrier_name ? ` · ${r.carrier_name}` : ""}
                {r.freight_amount ? ` · ${money(r.freight_amount)}` : ""}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
