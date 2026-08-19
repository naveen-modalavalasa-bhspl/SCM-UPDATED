import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, MapPin, X } from "lucide-react";
import {
  Card, ErrorBanner, Field, Input, PageHeader, ResponsiveList, Select, StatCard,
  type Column,
} from "@/shared/components";
import { transportApi } from "../api";
import { modeLabel, modeTint, money } from "../components/modeCopy";
import type { ActivityRow } from "../transportTypes";

const SIZE = 25;

/**
 * How each result reads at a glance. Colour never carries the meaning on its own —
 * the label is written out beside it — it only says which of the four things
 * happened: it moved on (sky), it landed (emerald), somebody stopped it (rose), or
 * it is waiting on a person (amber).
 *
 * Keyed on `result`, which the backend serves per event: the rung the event put the
 * shipment on, not the status it carries today. A ledger whose old rows repaint
 * themselves every time the shipment moves is not a ledger.
 */
const RESULT_TONE: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-600",
  PENDING_APPROVAL: "bg-amber-50 text-amber-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-rose-50 text-rose-700",
  RETURNED: "bg-amber-50 text-amber-700",
  QUOTING: "bg-indigo-50 text-indigo-700",
  AWAITING_CARRIER: "bg-amber-50 text-amber-700",
  READY: "bg-sky-50 text-sky-700",
  IN_TRANSIT: "bg-sky-50 text-sky-700",
  DELIVERED: "bg-emerald-50 text-emerald-700",
  ACKNOWLEDGED: "bg-emerald-50 text-emerald-800",
  CLAIM_OPEN: "bg-rose-50 text-rose-700",
  CLAIM_SETTLED: "bg-slate-100 text-slate-600",
};

const resultLabel = (result: string) =>
  result.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

function ResultBadge({ result }: { result: string }) {
  return (
    <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-semibold uppercase tracking-wide ${
      RESULT_TONE[result] ?? "bg-slate-100 text-slate-600"}`}>
      {resultLabel(result)}
    </span>
  );
}

/** Date over time, so a column of timestamps reads as a column rather than a wall. */
function WhenCell({ value }: { value: string }) {
  const at = new Date(value.length > 10 && !value.endsWith("Z") ? `${value}Z` : value);
  if (Number.isNaN(at.getTime())) return <span className="text-muted">—</span>;
  return (
    <span className="block tabular-nums text-xs text-muted">
      <span className="block whitespace-nowrap text-body">
        {at.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
      </span>
      <span className="block whitespace-nowrap">
        {at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
      </span>
    </span>
  );
}

/** Who, with whom, where, and what they said — in that order, because that is the
 *  order the question is asked: "who accepted it, and what did they charge?" */
function DetailCell({ row }: { row: ActivityRow }) {
  const who = [row.actor_name, row.carrier_name && row.carrier_name !== row.actor_name
    ? row.carrier_name : null].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0">
      {who && <p className="truncate text-sm text-body">{who}</p>}
      {row.location_name && (
        <p className="flex items-center gap-1 text-xs text-muted">
          <MapPin size={11} className="shrink-0" aria-hidden />
          <span className="truncate">{row.location_name}</span>
        </p>
      )}
      {row.detail && <p className="break-words text-xs text-muted">{row.detail}</p>}
      {!who && !row.location_name && !row.detail && (
        <span className="text-xs text-muted">—</span>
      )}
    </div>
  );
}

/**
 * The activity ledger: what happened, to which shipment, in the order it happened.
 *
 * One register in place of the two tabs that each drew a slice of it. Shipment
 * Tracking answered "where is it now" and Exceptions answered "what went wrong";
 * neither said who awarded the job, at what price, or when the carrier agreed to it,
 * so a desk chasing a consignment read half the story on one tab and half on another.
 *
 * Read-only, and derived: every row comes off a document the module already writes —
 * the request header, the approval actions, the carrier quotes and the shipment
 * timeline — so the ledger cannot claim an event that never happened. The wording of
 * an event and the rung it puts the shipment on are both SERVED, never mapped here.
 *
 * `?dispatch_id=` scopes it to one consignment's own trail, which is how the Dispatch
 * queue opens it for a single row.
 */
export function LogisticsActivityPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [eventType, setEventType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Read from the URL rather than kept in state: "open claims" is a link from the
  // Transport register, and the Exceptions desk it replaced was a page you could send
  // somebody to.
  const claimsOnly = params.get("claims") === "1";
  const dispatchId = Number(params.get("dispatch_id")) || undefined;
  const trId = Number(params.get("tr_id")) || undefined;
  const scopeLabel = params.get("scope");

  const filters = useMemo(() => ({
    search: search.trim() || undefined,
    event_type: eventType || undefined,
    only_exceptions: claimsOnly || undefined,
    date_from: from || undefined,
    date_to: to || undefined,
    dispatch_id: dispatchId,
    tr_id: trId,
    page,
    size: SIZE,
  }), [search, eventType, from, to, claimsOnly, dispatchId, trId, page]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport-activity", filters],
    queryFn: () => transportApi.activity(filters),
    // A filter change must not blank the table it is narrowing.
    placeholderData: keepPreviousData,
  });

  // Served rather than listed here: a dropdown offering an event the ledger cannot
  // return is a filter that silently empties the page.
  const { data: types } = useQuery({
    queryKey: ["transport-activity-types"],
    queryFn: () => transportApi.activityTypes(),
    staleTime: Infinity,
  });

  // Claims nobody has closed yet, across the whole module — the one number the
  // Exceptions desk existed to show, kept as a heading rather than as a screen.
  const { data: openClaims } = useQuery({
    queryKey: ["transport-exceptions", "count"],
    queryFn: () => transportApi.exceptions({ page: 1, size: 1 }),
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const scoped = dispatchId !== undefined || trId !== undefined;
  const filtered = Boolean(search || eventType || from || to || claimsOnly);

  const reset = (next: () => void) => { next(); setPage(1); };
  const clearFilters = () => {
    setSearch(""); setEventType(""); setFrom(""); setTo(""); setPage(1);
    if (claimsOnly) {
      params.delete("claims");
      setParams(params);
    }
  };
  const toggleClaims = () => {
    if (claimsOnly) params.delete("claims"); else params.set("claims", "1");
    setParams(params);
    setPage(1);
  };
  const clearScope = () => { setParams({}); setPage(1); };

  const columns: Column<ActivityRow>[] = [
    {
      key: "when",
      header: "When",
      className: "w-36 min-w-36",
      render: (row) => <WhenCell value={row.occurred_at} />,
    },
    {
      key: "shipment",
      header: "Shipment",
      render: (row) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{row.tr_no}</div>
          <div className="truncate text-[11px] text-muted">
            {row.consignment_no ?? row.indent_no ?? row.to_name ?? "—"}
          </div>
        </div>
      ),
    },
    {
      key: "event",
      header: "Event",
      render: (row) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {row.is_exception && (
              <AlertTriangle size={13} className="shrink-0 text-rose-600" aria-hidden />
            )}
            <span className={`text-sm font-medium ${
              row.is_exception ? "text-rose-700" : "text-ink"}`}>
              {row.event_label}
            </span>
          </div>
          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${modeTint(row.mode)}`}>
            {modeLabel(row.mode)}
          </span>
        </div>
      ),
    },
    {
      key: "details",
      header: "Details",
      hideOnNarrow: true,
      render: (row) => <DetailCell row={row} />,
    },
    {
      key: "amount",
      header: "Value",
      className: "text-right",
      hideOnNarrow: true,
      render: (row) => (
        <span className="tabular-nums text-sm text-body">
          {row.amount != null ? money(row.amount) : "—"}
        </span>
      ),
    },
    {
      key: "result",
      header: "Result",
      render: (row) => <ResultBadge result={row.result} />,
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Logistics" title="Activity ledger" />
      <p className="-mt-3 mb-5 max-w-3xl text-sm text-muted">
        Every event on every shipment, newest first — raised, approved, quoted,
        awarded, picked up, delivered, signed for and claimed.
      </p>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label={scoped ? "Events on this consignment" : "Events"} value={total} />
        {/* A tile that is also the filter: "3 open claims" is read and then acted on
            in the same breath, which is the whole of what the Exceptions desk did. */}
        <button
          type="button"
          onClick={toggleClaims}
          aria-pressed={claimsOnly}
          className={`w-full rounded-2xl text-left transition ${
            claimsOnly ? "ring-2 ring-rose-300" : "hover:opacity-90"}`}
        >
          <StatCard
            label={claimsOnly ? "Open claims · showing claims" : "Open claims"}
            value={openClaims?.total ?? 0}
            tone={openClaims?.total ? "text-rose-600" : "text-ink"}
          />
        </button>
        <StatCard label="On this page" value={rows.length} />
      </div>

      {scoped && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface/60 px-4 py-2.5">
          <span className="text-sm text-body">
            Showing one consignment&rsquo;s trail
            {scopeLabel ? <> · <span className="font-mono text-xs">{scopeLabel}</span></> : null}
          </span>
          <button type="button" onClick={clearScope}
            className="flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-body">
            <X size={14} aria-hidden />Show the whole ledger
          </button>
        </div>
      )}

      <Card className="mb-4 p-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search">
            <Input
              value={search}
              placeholder="Shipment, consignment, carrier, person…"
              onChange={(e) => reset(() => setSearch(e.target.value))}
            />
          </Field>
          <Field label="Event">
            <Select
              value={eventType}
              placeholder="Every event"
              options={[
                { value: "", label: "Every event" },
                ...(types ?? []).map((type) => ({
                  value: type.value, label: type.label,
                })),
              ]}
              onChange={(value) => reset(() => setEventType(value))}
            />
          </Field>
          <Field label="From">
            <Input type="date" value={from}
              onChange={(e) => reset(() => setFrom(e.target.value))} />
          </Field>
          <Field label="To">
            <Input type="date" value={to}
              onChange={(e) => reset(() => setTo(e.target.value))} />
          </Field>
        </div>
        {filtered && (
          <button type="button" onClick={clearFilters}
            className="mt-3 flex items-center gap-1 text-xs font-medium text-muted">
            <X size={13} aria-hidden />Clear filters
          </button>
        )}
      </Card>

      <ErrorBanner error={error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(row) => row.event_id}
          loading={isLoading}
          onRowClick={(row) => nav(`/logistics/transport/${row.tr_id}`)}
          page={page}
          totalPages={Math.max(1, Math.ceil(total / SIZE))}
          onPageChange={setPage}
          empty={filtered || scoped
            ? "No activity matches these filters."
            : "Nothing has happened on a shipment yet."}
          renderCard={(row) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{row.tr_no}</span>
                <ResultBadge result={row.result} />
              </div>
              <div className="flex items-center gap-1.5 text-sm font-medium text-body">
                {row.is_exception && (
                  <AlertTriangle size={13} className="shrink-0 text-rose-600" aria-hidden />
                )}
                {row.event_label}
              </div>
              <DetailCell row={row} />
              <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-muted">
                <WhenCell value={row.occurred_at} />
                {row.amount != null && <span className="tabular-nums">{money(row.amount)}</span>}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
