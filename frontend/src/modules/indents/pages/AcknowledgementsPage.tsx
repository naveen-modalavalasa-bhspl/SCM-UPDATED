import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, ListFilter, Truck } from "lucide-react";
import {
  Button, Can, Card, EmptyState, ErrorBanner, Input, ResponsiveList, Select,
  type Column,
} from "@/shared/components";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentSummaryStatusBadge } from "../components/IndentSummaryStatusBadge";
import { INDENT_LIST_TYPES, INDENT_STATUS } from "../constants";
import { indentApi } from "../api";
import { ackDetailPath, isTransferRow } from "../ackPaths";
import type { Acknowledgement } from "../types";
import {
  displayStatus, summarise, trackingHandle,
} from "../components/acknowledgementParts";
import { DirectIssueAcknowledgements } from "../components/DirectIssueAcknowledgements";
import { FILTER_PILL_COUNT_OFF, FILTER_PILL_COUNT_ON, FILTER_PILL_ON } from "../buttonTones";

/**
 * What the requester is still owed, and where it has got to.
 *
 * This is the list. Confirming one delivery is its own screen
 * (`AcknowledgementDetailPage`, `/indents/acknowledgements/:indentId`) — it was a
 * modal over this list, and a receipt is a form with a quantity per line, the tracking
 * trail, uploads and a damage report on it, which is a page, not a box.
 *
 * One row per indent, not per line. An indent with a hundred items must not push the
 * next indent off the screen — the lines live on the screen you open.
 */

// The three states a requester's goods are ever in from their side: set aside, part
// of it arrived, all of it arrived. The procurement statuses were noise here — nothing
// on this screen can be done about an indent that is still being bought in.
const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: INDENT_STATUS.ALLOCATED, label: "Allocated" },
  { value: INDENT_STATUS.PARTIALLY_FULFILLED, label: "Partially fulfilled" },
  { value: INDENT_STATUS.CLOSED, label: "Fulfilled" },
];

/** `indentTypes` narrows the list to one kind of request, and `embedded` drops the
 *  module header — Inventory > Stock Transfer mounts this on STRs alone. */
export default function AcknowledgementsPage({ indentTypes = INDENT_LIST_TYPES, embedded = false }: {
  indentTypes?: string[]; embedded?: boolean;
} = {}) {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [onlyActionable, setOnlyActionable] = useState(false);
  // Indent deliveries, or material issued to me DIRECT (no indent). Stock Transfer
  // embeds this list for STRs alone, where direct issues have no place.
  // In the URL so Back from a direct issue's receipt lands on this tab again.
  const [query, setQuery] = useSearchParams();
  const view = !embedded && query.get("view") === "direct" ? "direct" : "indent";
  const setView = (next: "indent" | "direct") =>
    setQuery(next === "direct" ? { view: "direct" } : {}, { replace: true });

  // Filtering happens server-side so the list stays honest when it grows past a page.
  const filters = useMemo(
    () => ({ search: search.trim() || undefined, status: status || undefined,
             only_actionable: onlyActionable || undefined, indent_type: indentTypes }),
    [search, status, onlyActionable, indentTypes],
  );

  const acknowledgements = useQuery({
    queryKey: ["indent-acknowledgements", filters],
    queryFn: () => indentApi.myAcknowledgements(filters),
  });

  const rows = acknowledgements.data ?? [];
  // One destination, whichever of the three ways in was used — the row, the desktop
  // button or the phone card.
  // An STR is received on Stock Transfer, never here (2026-10-29).
  const open = (row: Acknowledgement) => nav(ackDetailPath(
    row.indent_id, isTransferRow(row) || (indentTypes.length === 1 && indentTypes[0] === "STR")));
  // What the pill would leave on screen. The endpoint returns the whole list rather
  // than a page, so counting the loaded rows is the true number; with the filter
  // already on, the server has narrowed it and every row here is one of them.
  const readyCount = rows.filter((row) => row.can_acknowledge).length;

  const columns: Column<Acknowledgement>[] = [
    {
      key: "indent",
      header: indentTypes.length === 1 && indentTypes[0] === "STR" ? "STR" : "Indent",
      render: (row) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{row.indent_no}</div>
          <div className="text-[11px] text-muted">
            {row.required_date ? `Needed by ${row.required_date}` : row.indent_date ?? "—"}
          </div>
        </div>
      ),
    },
    {
      key: "project",
      header: "Raised By",
      hideOnNarrow: true,
      render: (row) => <span className="text-sm text-muted">{row.project_name ?? "—"}</span>,
    },
    {
      key: "consignment",
      header: "Consignment",
      render: (row) => <ConsignmentNos row={row} />,
    },
    {
      key: "items",
      header: "Items",
      render: (row) => <span className="tabular-nums">{row.lines.length}</span>,
    },
    {
      key: "progress",
      header: "Progress",
      render: (row) => {
        // The docket, on the row. Someone scanning this list for "has mine shipped"
        // should not have to open every one of them to find out.
        const leg = row.shipments[0];
        const handle = leg ? trackingHandle(leg) : null;
        return (
          <div className="min-w-0">
            <div className="text-sm text-muted">{summarise(row)}</div>
            {leg && (
              <div className="truncate text-[11px] text-muted">
                {leg.carrier_name ?? leg.vehicle_number ?? "Hand delivery"}
                {handle ? ` · ${handle}` : ""}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <IndentSummaryStatusBadge status={displayStatus(row)} />,
    },
    {
      key: "action",
      header: "",
      // can_acknowledge is the document's answer ("is this line mine to receive");
      // the permission is the login's. Both have to hold.
      render: (row) => (row.can_acknowledge ? (
        <Can do="indent.acknowledge">
          <Button onClick={() => open(row)}>
            <CheckCircle2 className="h-4 w-4" /> Acknowledge
          </Button>
        </Can>
      ) : null),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Same header as the other indent screens, minus the shared filter bar: this list
          has its own, and the shared one filters a different query shape. */}
      {!embedded && (
        <IndentModuleHeader title="Acknowledgements" showCreate={false} showFilters={false} />
      )}

      {!embedded && (
        <div role="tablist" aria-label="What to acknowledge" className="inline-flex rounded-xl border border-line bg-content1 p-1">
          {([["indent", "Against document"], ["direct", "Direct issues"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={`h-11 rounded-lg px-4 text-sm font-medium transition ${
                view === key ? "bg-brand text-white" : "text-body hover:bg-content2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {view === "direct" ? <DirectIssueAcknowledgements /> : <>

      <Card className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Search acknowledgements"
            placeholder="Search indent no., project or item…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="w-full md:w-56">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(value) => setStatus(String(value ?? ""))}
            options={STATUS_OPTIONS}
            placeholder="Any status"
          />
        </div>
        {/* A filter, not an action — so it is a pill and never wears the solid button or
            the tick icon the row's Acknowledge uses. Lit when on, quiet when off, and it
            says so to a screen reader through aria-pressed. The count is the point of
            the pill: it tells you whether pressing it is worth anything before you do. */}
        <button
          type="button"
          aria-pressed={onlyActionable}
          title={onlyActionable
            ? "Showing only what you can acknowledge — press to show everything"
            : "Show only the indents waiting for your acknowledgement"}
          onClick={() => setOnlyActionable((current) => !current)}
          className={`inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
            onlyActionable
              ? FILTER_PILL_ON
              : "border-line bg-content1 text-body hover:border-brand/40 hover:bg-content2"
          }`}
        >
          <ListFilter className="h-4 w-4" />
          Ready to acknowledge
          {readyCount > 0 && (
            <span
              className={`min-w-5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                onlyActionable ? FILTER_PILL_COUNT_ON : FILTER_PILL_COUNT_OFF
              }`}
            >
              {readyCount}
            </span>
          )}
        </button>
      </Card>

      <ErrorBanner error={acknowledgements.error} />

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.indent_id}
        loading={acknowledgements.isLoading}
        onRowClick={(row) => open(row)}
        empty={
          <EmptyState
            title={search || status || onlyActionable ? "Nothing matches" : "Nothing on its way"}
            hint={
              search || status || onlyActionable
                ? "Try a different search or clear the filters."
                : "Indents you raise appear here once they are approved, so you can track them and acknowledge what arrives."
            }
          />
        }
        renderCard={(row) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-xs font-semibold text-ink">{row.indent_no}</div>
                <div className="text-[11px] text-muted">{row.project_name ?? "—"}</div>
              </div>
              <IndentSummaryStatusBadge status={displayStatus(row)} />
            </div>
            <ConsignmentNos row={row} />
            <div className="text-sm text-muted">{summarise(row)}</div>
            <div className="text-[11px] text-muted">
              {row.lines.length} item{row.lines.length === 1 ? "" : "s"}
              {row.required_date ? ` · needed by ${row.required_date}` : ""}
            </div>
            {row.can_acknowledge && (
              <Can do="indent.acknowledge">
                <Button onClick={() => open(row)}>
                  <CheckCircle2 className="h-4 w-4" /> Acknowledge receipt
                </Button>
              </Can>
            )}
          </div>
        )}
      />
      </>}
    </div>
  );
}

/**
 * The consignment note number(s) the goods travelled under — the number printed on the
 * paper the driver hands over, so the requester can match the row to the load at the
 * gate. Read off the package split already on each line; an indent served in rounds
 * can arrive under more than one, and all of them are in the tooltip.
 */
function ConsignmentNos({ row }: { row: Acknowledgement }) {
  const nos = [...new Set(
    row.lines.flatMap((line) => (line.package_quantities ?? [])
      .map((part) => part.dispatch_no)
      .filter((no): no is string => Boolean(no))),
  )];
  if (nos.length === 0) {
    return <span className="text-[11px] text-muted">Not sent yet</span>;
  }
  return (
    <div className="inline-flex min-w-0 items-center gap-1.5" title={nos.join("\n")}>
      <Truck className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      <span className="truncate font-mono text-xs font-semibold text-ink">{nos[0]}</span>
      {nos.length > 1 && (
        <span className="shrink-0 rounded-full bg-content2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
          +{nos.length - 1}
        </span>
      )}
    </div>
  );
}
