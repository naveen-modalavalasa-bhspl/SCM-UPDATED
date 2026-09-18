import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  Card, EmptyState, ErrorBanner, FilterBar, PageHeader,
  ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { AwaitingReceiptPanel } from "../components/AwaitingReceiptPanel";
import { RaisedDateFilter } from "../components/RaisedDateFilter";
import { returnsApi } from "../api";
import { QUEUE, money } from "../constants";
import { formatReturnDate } from "../dateTime";
import type { StockReturn } from "../types";

const qty = (value: string | number) => Number(value ?? 0).toLocaleString();

/**
 * The two desks' work lists — the decision desk, and the floor that endorses it.
 *
 * One component for both, because they differ only in the `queue` sent to the same
 * endpoint. That parameter is not a status filter: a return waiting for a decision and a
 * return waiting for sign-off are both PENDING_APPROVAL, so nothing but the desk can tell
 * the two backlogs apart. The backend also drops its visibility rule for a queue — these
 * desks hold no stocking point of their own, and the filter written for storekeepers would
 * hand them an empty list.
 *
 * Decision desk (INVENTORY MANAGER) is newest first; endorsement/logistics stay oldest first.
 *
 * NARROWING IT (2026-09-08) is done on the SERVER, by the same `/api/returns` call that
 * draws the rows — never in this component over whichever page happens to be loaded. A
 * desk works a backlog several pages deep, and a box that searched only the twenty rows
 * in hand answers "nothing matches" for a return that is plainly there. The server
 * matches the term against the fields this table draws (`_QUEUE_SEARCH_FIELDS`), so a
 * term visible in a row always finds it and a term visible nowhere never invents one,
 * and it bounds the raise date with both ends inclusive — the date the last column
 * prints, formatted through the module's own `formatReturnDate` so the filter and the
 * column can never read differently.
 */
export default function DecisionQueuePage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const logistics = pathname.endsWith("/logistics");
  const queue = logistics
    ? QUEUE.LOGISTICS
    : pathname.endsWith("/sign-off")
      ? QUEUE.ENDORSEMENT
      : QUEUE.DECISION;
  const deciding = queue === QUEUE.DECISION;
  // ADDED 2026-09-10: the sign-off screen also carries what has been DISPATCHED and is
  // waiting to be signed for at the far end. A second list rather than more rows in the
  // one below, because the two are not the same backlog and are not the same press:
  // endorsement agrees a decision, the receipt puts the material on a shelf. It draws
  // nothing when there is nothing on the way, so a desk with no deliveries sees the page
  // exactly as it was.
  const receiving = queue === QUEUE.ENDORSEMENT;

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // One request per pause in typing, not one per keystroke: every row on a queue is
  // costed and hazard-checked to be drawn, so a nine-character return number typed
  // straight through would put nine of those in flight to race each other.
  const term = useDebouncedValue(search).trim();

  const filtersOn = (term ? 1 : 0) + (dateFrom || dateTo ? 1 : 0);
  const narrow = (next: () => void) => {
    next();
    // A filter changed while page 4 is showing would otherwise ask for the fourth page
    // of a three-row result and land on an empty grid that reads as a broken screen.
    setPage(1);
  };

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["returns", "queue", queue, page, term, dateFrom, dateTo],
    queryFn: () =>
      returnsApi.list({
        page,
        size: 20,
        queue,
        search: term,
        date_from: dateFrom,
        date_to: dateTo,
      }),
    // Rows stay on screen while a narrowed list is fetched. Blanking the grid on every
    // keystroke reads as "nothing matches" a moment before the answer arrives.
    placeholderData: keepPreviousData,
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.size || 20)));

  const columns: Column<StockReturn>[] = useMemo(() => [
    {
      key: "return_no",
      header: "Return",
      render: (row) => (
        <div>
          <div className="font-semibold text-ink">{row.return_no}</div>
          <div className="text-xs text-muted">{row.reason_label ?? row.reason ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "from",
      header: "From",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.from_warehouse_name ?? "—"}</div>
          {/* FIX 2026-09-05: the office label repeated the warehouse on the line above
            * it. The raiser's name is what this subline is for. */}
          <div className="text-xs text-muted">{row.raised_by_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Quantity",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{qty(row.total_qty)}</div>
          <div className="text-xs text-muted">
            {row.total_items} {row.total_items === 1 ? "item" : "items"}
          </div>
        </div>
      ),
    },
    {
      key: "value",
      header: "Worth",
      hideOnNarrow: true,
      // An em dash where nothing has been costed. Printing ₹0 would be a lie, and this is
      // the number the freight-versus-value call is made against.
      render: (row) => <span className="text-sm text-body">{money(row.value)}</span>,
    },
    {
      key: "intent",
      header: "Wants",
      hideOnNarrow: true,
      // Served, never composed here. "Return only" is all this document may claim:
      // whether the material comes back as a replacement or as a credit note is the
      // supplier's call on their own note, long after this desk is finished with it.
      render: (row) => (
        <span className="text-sm text-body">{row.intent_label ?? "—"}</span>
      ),
    },
    {
      key: "state",
      header: deciding ? "Waiting since" : logistics ? "Transport" : "Decision",
      render: (row) =>
        deciding ? (
          <div className="space-y-1 text-sm">
            {/* Through the module's own formatter, not `toLocaleDateString`: the older
              * stamps on this document are naive MySQL text, which Safari refuses
              * outright and which a raw `new Date` reads five and a half hours early. */}
            <div className="text-ink">{formatReturnDate(row.created_at) ?? "—"}</div>
            {row.hazard_features.length > 0 && (
              <div className="flex items-center gap-1 text-xs text-warn">
                <AlertTriangle className="h-3 w-3" />
                {row.hazard_features.join(", ")}
              </div>
            )}
            {(row.decision?.objections ?? 0) > 0 && (
              <div className="text-xs text-bad">
                sent back {row.decision?.objections}&#215;
              </div>
            )}
          </div>
        ) : logistics ? (
          <div className="space-y-1 text-sm">
            <div className="text-ink">
              {row.transport?.transport_request_no ?? "Waiting approval"}
            </div>
            <div className="text-xs text-muted">{row.leg_label ?? "Return logistics"}</div>
          </div>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="text-ink">
              {row.decision?.disposition_label ?? "—"}
            </div>
            <div className="text-xs text-muted">
              {row.decision?.decided_by_name ?? ""}
            </div>
          </div>
        ),
    },
  ], [deciding, logistics]);

  return (
    <div>
      <PageHeader
        eyebrow="RETURN"
        title={deciding ? "Decision desk" : logistics ? "Return logistics" : "Awaiting sign-off"}
      />

      <Card className="mb-4 p-3">
        <p className="text-sm text-muted">
          {deciding
            ? "Returns that have cleared their reporting line. Choose where the material goes — two of the six outcomes move nothing at all."
            : logistics
              /* CHANGED 2026-09-10: a tracking list, not an approval one. The logistics
               * rung is retired — a released return is arranged on the Dispatch board and
               * nothing is signed here — so this says where the load has got to. */
              ? "Returns released to logistics: signed off, and with the dispatch desk arranging the leg that carries them."
              : "Decisions waiting to be agreed. Open a row to sign it, or send a decision back with a reason."}
        </p>
      </Card>

      {/* The one filter strip the rest of the application uses — same rail, same search
        * box, same pills, same place for Clear. Nothing new is styled here. */}
      <FilterBar
        search={search}
        onSearch={(value) => narrow(() => setSearch(value))}
        searchPlaceholder="Search return no., point, person or reason…"
        searchLabel="Search this queue"
        // The box takes up whatever the one date pill and the count leave over, rather
        // than stopping at the shared default's 24rem. This strip carries a single pill,
        // so a capped box left a third of the rail as dead space and read as unfinished.
        searchClassName="min-w-[240px] flex-1"
        active={filtersOn}
        onClear={() => narrow(() => { setSearch(""); setDateFrom(""); setDateTo(""); })}
        right={
          // What the grid below is showing, in a sentence — and it says when a small
          // number is small because of a filter, which is the one thing a count on a
          // work queue has to say. `aria-live` so it is announced when it changes.
          <span className="text-sm text-muted" aria-live="polite">
            {isLoading ? (
              "Counting…"
            ) : (
              <>
                <span className="font-semibold text-ink">{total}</span>{" "}
                {receiving
                  ? total === 1 ? "decision" : "decisions"
                  : total === 1 ? "return" : "returns"}
                {filtersOn > 0 ? " match" : " waiting"}
                {isFetching ? "…" : ""}
              </>
            )}
          </span>
        }
      >
        <RaisedDateFilter
          from={dateFrom}
          to={dateTo}
          onChange={({ from, to }) => narrow(() => { setDateFrom(from); setDateTo(to); })}
        />
      </FilterBar>

      {receiving && (
        <AwaitingReceiptPanel
          search={term}
          dateFrom={dateFrom}
          dateTo={dateTo}
          filtersOn={filtersOn > 0}
        />
      )}

      {error && <ErrorBanner error="This queue could not be loaded." />}

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.id}
        loading={isLoading}
        onRowClick={(row) => navigate(`/returns/${row.id}`)}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        empty={
          // A filtered queue coming back empty is not an empty queue, and saying
          // "nothing waiting on you" there sends somebody looking for a configuration
          // fault that is really a search term.
          filtersOn > 0 ? (
            <EmptyState
              title="Nothing matches those filters"
              hint="Clear the search, or widen the raised-on dates."
            />
          ) : (
            <EmptyState
              title="Nothing waiting on you"
              hint={
                deciding
                  ? "Returns appear here once their reporting line has signed. If nothing ever arrives, check that your post is the first step under Receiving approvers."
                  : logistics
                    ? "Returns appear here once a sign-off releases one to logistics, and stay until the far end has signed for the material."
                    : "Decisions appear here once the desk has recorded one."
              }
            />
          )
        }
        renderCard={(row) => (
          <button
            type="button"
            onClick={() => navigate(`/returns/${row.id}`)}
            className="block w-full p-4 text-left"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.return_no}</span>
              <StatusPill status={row.status} />
            </div>
            <div className="mt-1 text-sm text-body">
              {row.from_warehouse_name ?? "—"} · {qty(row.total_qty)} across{" "}
              {row.total_items} {row.total_items === 1 ? "item" : "items"}
            </div>
            <div className="mt-1 text-xs text-muted">
              {row.reason_label ?? row.reason ?? "—"} · {money(row.value)}
            </div>
            {/* Below 768px the Wants and Waiting-since columns are dropped, so the card
              * carries them itself — they are what the desk decides against. */}
            {deciding && (
              <div className="mt-1 text-xs text-muted">
                {row.intent_label ?? "—"}
                {formatReturnDate(row.created_at)
                  ? ` · waiting since ${formatReturnDate(row.created_at)}`
                  : ""}
              </div>
            )}
            {!deciding && !logistics && row.decision && (
              <div className="mt-1 text-xs text-brand">
                {row.decision.disposition_label}
              </div>
            )}
            {logistics && (
              <div className="mt-1 text-xs text-brand">
                {row.transport?.transport_request_no ?? "Waiting approval"}
              </div>
            )}
          </button>
        )}
      />
    </div>
  );
}
