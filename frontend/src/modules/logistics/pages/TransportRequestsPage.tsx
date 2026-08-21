import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Can, Card, ErrorBanner, Input, PageHeader, ResponsiveList, Select,
  StatusPill, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { transportApi } from "../api";
import {
  load, modeLabel, modeTint, money, nextMove, statusTint, TR_STATUSES,
} from "../components/modeCopy";
import type { TransportSummary, TRListRow } from "../transportTypes";

const SIZE = 20;

const MODES = [
  { value: "", label: "All modes" },
  { value: "DIRECT", label: "Hand-over" },
  { value: "COURIER", label: "Courier" },
  { value: "OWN_VEHICLE", label: "Own vehicle" },
  { value: "THIRD_PARTY", label: "Third-party" },
];

/** Which WAY the leg runs, filtered on `source_type` (doc E7).
 *
 *  One equality each, which is why there is no single "outward" option: outward is
 *  CONSIGNMENT *or* ISSUE, and the register filter is one column compared to one
 *  value. Offering "Outward" here would mean either a second backend filter or a
 *  screen that quietly drops issue legs out of its own list. */
const DIRECTIONS = [
  { value: "", label: "Everything" },
  { value: "CONSIGNMENT", label: "Out — consignments" },
  { value: "ISSUE", label: "Out — issues" },
  { value: "RETURN", label: "Returns from the field" },
];

/** The board across the top: one tile per queue, and pressing it filters the list.
 *  The order is the order the flow runs, so the board reads left to right as the
 *  journey a consignment takes. */
const QUEUES: { key: keyof TransportSummary; label: string; status: string }[] = [
  { key: "draft", label: "Draft", status: "DRAFT" },
  { key: "pending_approval", label: "Approval", status: "PENDING_APPROVAL" },
  { key: "quoting", label: "Quotes", status: "QUOTING" },
  { key: "awaiting_carrier", label: "Carrier", status: "AWAITING_CARRIER" },
  { key: "ready", label: "To dispatch", status: "READY" },
  { key: "in_transit", label: "On the road", status: "IN_TRANSIT" },
  { key: "delivered", label: "To sign", status: "DELIVERED" },
];

/**
 * The transport register — every consignment logistics has been asked to move.
 *
 * The board is the screen's point: seven queues, each one a stage of the flow, each
 * one a click. A desk opening this in the morning should be able to see where the
 * work has piled up without reading a single row, and land in that queue by pressing
 * the number.
 *
 * Dispatch is not a separate list any more. A request in READY is one waiting to be
 * dispatched, which is why "To dispatch" is a filter here and not a second screen.
 */
export function TransportRequestsPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState("");
  // Which way the legs in this list run. A return is the same document backwards, so
  // it belongs in this register rather than in a second one — but "show me only the
  // returns" is a real question, so it is a filter.
  const [direction, setDirection] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const onlyReturns = direction === "RETURN";

  const { data: summary } = useQuery({
    queryKey: ["transport-summary"],
    queryFn: transportApi.summary,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport", status, mode, direction, search, page],
    queryFn: () => transportApi.list({
      status: status || undefined,
      mode: mode || undefined,
      source_type: direction || undefined,
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
            {r.consignment_no
              ?? (r.indent_no ? `Indent ${r.indent_no}` : fmtDate(r.tr_date))}
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
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <div className="min-w-0">
          <StatusPill status={r.status} />
          <div className="mt-0.5 truncate text-[11px] text-muted">
            {nextMove(r.status)}
          </div>
        </div>
      ),
    },
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
        <span className="text-sm text-body">{load(r.total_packages, r.total_weight_kg)}</span>
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
        title={onlyReturns ? "Return legs" : "Shipments"}
        actions={
          <Can do="transport.create">
            <Button variant="ghost" onClick={() => nav("/logistics/consignments")}>
              From a consignment
            </Button>
            {/* The trip BACK, raised on its own rather than hidden behind a tickbox
                inside the outward form. A return is planned, priced, tracked and
                closed exactly like an outward leg (doc E7), so it is the same document
                and the same screens — but it starts from a different question, and a
                desk arranging a collection from a site should be able to say so in one
                press instead of finding a checkbox halfway down a form titled
                "Where it goes". */}
            <Button variant="ghost"
              onClick={() => nav("/logistics/shipments/new?direction=return")}>
              Return leg
            </Button>
            <Button onClick={() => nav("/logistics/shipments/new")}>
              New shipment
            </Button>
          </Can>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {QUEUES.map((queue) => {
          const active = status === queue.status;
          const count = summary?.[queue.key] ?? 0;
          return (
            <button
              key={queue.key}
              type="button"
              onClick={() => {
                setStatus(active ? "" : queue.status);
                setPage(1);
              }}
              className={`min-h-11 rounded-xl border px-3 py-2.5 text-left transition ${
                active
                  ? "border-brand bg-brand/5 ring-2 ring-brand/20"
                  : "border-line bg-content1 hover:border-brand/50 hover:bg-surface-2"
              }`}
            >
              <span className="block font-display text-2xl font-bold tabular text-ink">
                {count}
              </span>
              <span className={`mt-0.5 inline-block rounded-full px-1.5 text-[10px] font-semibold uppercase tracking-wide ${statusTint(queue.status)}`}>
                {queue.label}
              </span>
            </button>
          );
        })}
      </div>

      {Boolean(summary?.open_claims) && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-2 border-amber-300 bg-amber-50 p-3 dark:bg-amber-900/20">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            <strong>{summary?.open_claims}</strong> open claim
            {summary?.open_claims === 1 ? "" : "s"} against carriers
            {summary?.untracked
              ? `, and ${summary.untracked} shipment(s) the field has never been told about`
              : ""}.
          </p>
          {/* The ledger, filtered to the claims — the Exceptions desk's list, on the
              register that now holds it. The event filter is served, so DAMAGED is a
              value the backend really returns rather than a guess made here. */}
          <Button variant="ghost" onClick={() => nav("/logistics/activity?claims=1")}>
            Open claims
          </Button>
        </Card>
      )}

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
        <div className="w-full max-w-[14rem]">
          <Select
            value={direction}
            options={DIRECTIONS}
            onChange={(value) => { setDirection(String(value)); setPage(1); }}
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
          onRowClick={(r) => nav(`/logistics/shipments/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={
            onlyReturns && !status && !mode && !search
              ? "No return legs yet. Raise one with “Return leg” when a site is sending material back."
              : status || mode || direction || search
                ? "No shipments match that."
                : "Nothing being moved yet. Start from a packed consignment."
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
                {load(r.total_packages, r.total_weight_kg)}
                {r.carrier_name ? ` · ${r.carrier_name}` : ""}
                {r.freight_amount ? ` · ${money(r.freight_amount)}` : ""}
              </div>
              <div className="text-[11px] text-brand">{nextMove(r.status)}</div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
