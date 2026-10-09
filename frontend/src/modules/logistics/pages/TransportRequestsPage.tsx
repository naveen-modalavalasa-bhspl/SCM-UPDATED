import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Archive, CheckCircle2, Clock, Gavel, Hourglass, PenLine, PencilLine, Route, Send, Truck,
  type LucideIcon,
} from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, Input, KpiTiles, PageHeader, ResponsiveList,
  Select, StatusPill, type Column, type Tone,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { transportApi } from "../api";
import {
  load, modeLabel, modeTint, money, nextMove, TR_STATUSES,
} from "../components/modeCopy";
import type { ProviderBoardRow as TRListRow, TransportSummary } from "../transportTypes";
import { legDestination } from "../components/manifestView";
import { TONE_MINT } from "@/shared/components/tones";

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
  { value: "CONSIGNMENT", label: "Out — consignments" },
  { value: "ISSUE", label: "Out — issues" },
  { value: "RETURN", label: "Returns from the field" },
  { value: "TRIP", label: "Out — multi-drop trips" },
];

/** The board across the top: one tile per queue, and pressing it filters the list.
 *  The order is the order the flow runs, so the board reads left to right as the
 *  journey a consignment takes — and it runs to the END of that journey.
 *
 *  FIX 2026-09-16: "Signed" and "Closed" were missing, and the board stopped at
 *  "To sign". Both counts have always been served (`_SUMMARY_QUEUES`), so the effect
 *  was a shipment falling off every tile the moment the site acknowledged it: a desk
 *  that works this screen by pressing numbers had no number left that contained the
 *  row, and an acknowledged leg read as deleted. The last two tiles are history rather
 *  than work, which is why they sit after the divider the order already implies — but
 *  a register that cannot show you a finished shipment is not a register. */
const QUEUES: {
  key: keyof TransportSummary; label: string; status: string;
  icon: LucideIcon; tone: Tone;
}[] = [
  { key: "draft", label: "Draft", status: "DRAFT", icon: PencilLine, tone: "neutral" },
  { key: "pending_approval", label: "In approval", status: "PENDING_APPROVAL",
    icon: Hourglass, tone: "info" },
  { key: "quoting", label: "Out for quotes", status: "QUOTING",
    icon: Gavel, tone: "brand" },
  { key: "awaiting_carrier", label: "Awaiting carrier", status: "AWAITING_CARRIER",
    icon: Clock, tone: "warn" },
  { key: "ready", label: "To dispatch", status: "READY", icon: Send, tone: "ok" },
  { key: "in_transit", label: "On the road", status: "IN_TRANSIT",
    icon: Truck, tone: "brand" },
  { key: "delivered", label: "To sign", status: "DELIVERED",
    icon: PenLine, tone: "warn" },
  { key: "acknowledged", label: "Signed", status: "ACKNOWLEDGED",
    icon: CheckCircle2, tone: "ok" },
  { key: "closed", label: "Closed", status: "CLOSED",
    icon: Archive, tone: "neutral" },
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
  // Seeded from the URL so a link can open this register already narrowed. The
  // Logistics Overview's tiles are the reason: a tile that counts READY has to be able
  // to hand the reader the READY queue, not the whole register and a shrug. Read ONCE,
  // as the initial value — the filter stays local state after that, so changing it on
  // screen does not push history entries the back button then has to walk through.
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get("status") ?? "");
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
          {(r.source_type ?? "").toUpperCase() === "TRIP" ? (
            <div className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-brand-050 px-2 py-0.5 text-[10px] font-semibold text-brand"
              title={r.source_no ?? undefined}>
              <Route className="h-3 w-3" aria-hidden /> Multi-drop · {r.total_items} drops
            </div>
          ) : (
            <div className="text-[11px] text-muted">
              {r.consignment_no
                ?? (r.indent_no ? `Indent ${r.indent_no}` : fmtDate(r.tr_date))}
            </div>
          )}
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
          {/* A trip's destination is only its LAST stop; say the run instead. */}
          <div className="truncate text-body" title={r.to_location_name ?? undefined}>
            {legDestination(r)}
          </div>
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
      render: (r) => r.carrier_name ?? (
        r.status === "QUOTING" && r.invited_count > 0 ? (
          <div className="min-w-0">
            <div className="text-sm text-body">
              {r.responded_count} of {r.invited_count} quoted
            </div>
            {r.best_carrier_name && (
              <div className="truncate text-[11px] text-muted">
                Best: {r.best_carrier_name}
              </div>
            )}
          </div>
        ) : <span className="text-muted">Not set</span>
      ),
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
      // Before the award `freight_amount` is empty; the best quote so far stands in,
      // labelled so it is never read as the agreed price.
      render: (r) => r.freight_amount == null && r.best_amount != null ? (
        <span className="text-sm text-body" title="Best quote so far — not yet awarded">
          {money(r.best_amount)} <span className="text-[11px] text-muted">quoted</span>
        </span>
      ) : (
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
            {/* REMOVED 2026-09-16 — the "Return leg" press only. A return leg is not
                raised from this desk: it is raised by the returns module when a
                decision is signed off and the load is released, which is what stamps
                `source_type=RETURN` and links the branch return behind it. A leg
                started here would have carried none of that. The form still accepts
                `?direction=return` and the "Returns from the field" filter, the route
                and every existing return leg are untouched. */}
            <Button className={TONE_MINT} onClick={() => nav("/logistics/shipments/new")}>
              New shipment
            </Button>
          </Can>
        }
      />

      {/* The shared KPI strip (2026-08-23), replacing this screen's own hand-rolled
          tiles — one app, one shape for "here is a queue". The behaviour it already
          had is kept exactly: a tile is a TOGGLE, so pressing the one that is on
          clears the filter rather than reapplying it. */}
      <KpiTiles
        label="Shipment queues"
        className="mb-4"
        tiles={QUEUES.map((queue) => ({
          key: String(queue.key),
          label: queue.label,
          icon: queue.icon,
          tone: queue.tone,
          value: summary ? (summary[queue.key] ?? 0) : undefined,
          active: status === queue.status,
          onPress: () => {
            setStatus(status === queue.status ? "" : queue.status);
            setPage(1);
          },
        }))}
      />

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
            placeholder="Direction"
            searchable
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
              ? "No return legs yet."
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
