import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ClipboardList, Handshake, Truck, XCircle } from "lucide-react";
import { Card, ErrorBanner, StatusPill } from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { carrierPortalApi } from "../api";
import { load, money } from "../components/modeCopy";
import type { TRListRow } from "../transportTypes";

/** The carrier's own queues, in the order their day runs. Each one is a filter, and
 *  the label says what THEY have to do — not what status the shipment is in. */
const QUEUES = [
  { key: "QUOTING", label: "Quote for it", icon: ClipboardList },
  { key: "AWAITING_CARRIER", label: "Accept the job", icon: Handshake },
  { key: "READY", label: "Collect", icon: Truck },
  { key: "IN_TRANSIT", label: "On the road", icon: ArrowRight },
  { key: "DELIVERED,ACKNOWLEDGED", label: "Delivered", icon: Truck },
  // Not a status — an outcome, and the one queue that closes the loop. A carrier who
  // priced a lane and did not get it used to watch the shipment disappear off every
  // queue with nothing said, which reads as the portal having dropped it. The answer
  // is the last thing that happens on a tender, so it gets a place to be read.
  { key: "NOT_AWARDED", label: "Not awarded", icon: XCircle },
];

/** The one quote status that means the job is theirs. Anything else on a settled
 *  request — outbid, declined, or never priced — is a tender they did not win. */
const WON = "AWARDED";

/**
 * Everything this carrier has been invited to, and nothing else.
 *
 * Cards rather than a table: a carrier opens this on a phone at a loading bay, and
 * the four things that matter (where from, where to, how much, what do I press) have
 * to be readable without a horizontal scroll.
 */
export function CarrierJobsPage() {
  const nav = useNavigate();
  // The queue lives in the URL, not in a useState: sending a quote lands the carrier
  // back HERE, on the queue they just answered, and a component-local default would
  // drop them on a different tab than the one their work is on.
  //
  // Signing in with no queue named opens on "Quote for it", the first rung of their
  // day and the only one where somebody else is waiting on them. Opening on "Accept
  // the job" showed an empty queue to every carrier who had nothing awarded — which
  // is most of them, most of the time — and read as a portal with no work in it.
  const [search, setSearch] = useSearchParams();
  const queue = QUEUES.some((q) => q.key === search.get("queue"))
    ? search.get("queue")! : "QUOTING";
  const setQueue = (key: string) => setSearch({ queue: key }, { replace: true });

  const { data: summary } = useQuery({
    queryKey: ["carrier-summary"],
    queryFn: carrierPortalApi.summary,
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ["carrier-jobs", queue],
    queryFn: () => carrierPortalApi.list({ status: queue, size: 50 }),
  });

  const rows = data?.items ?? [];
  const counts: Record<string, number> = {
    QUOTING: summary?.to_quote ?? 0,
    AWAITING_CARRIER: summary?.to_confirm ?? 0,
    READY: summary?.to_pick_up ?? 0,
    IN_TRANSIT: summary?.on_the_road ?? 0,
    "DELIVERED,ACKNOWLEDGED": summary?.delivered ?? 0,
    NOT_AWARDED: summary?.not_awarded ?? 0,
  };

  return (
    <div>
      <h1 className="mb-1 font-display text-2xl font-bold text-ink">Shipments</h1>
      <p className="mb-5 text-sm text-muted">
        Price a lane, take the job, and tell us where it is.
      </p>

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {QUEUES.map((item) => {
          const Icon = item.icon;
          const active = queue === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setQueue(item.key)}
              className={`min-h-11 rounded-xl border px-3 py-2.5 text-left transition ${
                active
                  ? "border-brand bg-brand/5 ring-2 ring-brand/20"
                  : "border-line bg-content1 hover:border-brand/50"
              }`}
            >
              <Icon className={`h-4 w-4 ${active ? "text-brand" : "text-muted"}`} />
              <span className="mt-1 block font-display text-xl font-bold tabular text-ink">
                {counts[item.key] ?? 0}
              </span>
              <span className="block text-[11px] font-medium text-muted">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>

      <ErrorBanner error={error} />

      {isLoading ? (
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted">
          Nothing in this queue right now.
        </Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => nav(`/carrier/jobs/${row.id}`)}
                className="w-full rounded-xl border border-line bg-content1 p-4 text-left transition hover:border-brand hover:shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-ink">
                    {row.tr_no}
                  </span>
                  {/* On a lost row the shipment's status is describing another
                      carrier's truck — IN TRANSIT here would read as this carrier's
                      load being on the road. What they are shown is their own answer. */}
                  <StatusPill status={lost(row) ? "NOT_AWARDED" : row.status} />
                </div>
                <QuoteState row={row} />
                <LostState row={row} />
                <div className="mt-2 flex items-center gap-2 text-sm">
                  <span className="truncate text-muted">
                    {row.from_warehouse_name ?? "Warehouse"}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="truncate font-medium text-ink">
                    {row.to_location_name ?? "Destination"}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span>{load(row.total_packages, row.total_weight_kg)}</span>
                  {row.expected_delivery && (
                    <span>needed by {fmtDate(row.expected_delivery)}</span>
                  )}
                  {row.freight_amount ? (
                    <span className="font-semibold text-ink">
                      {money(row.freight_amount)}
                    </span>
                  ) : null}
                  {(row.lr_no || row.docket_no) && (
                    <span className="font-mono">{row.lr_no ?? row.docket_no}</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A tender this carrier did not win: their own quote says so, not the shipment.
 *  A shipment they ARE running carries either an AWARDED quote or (a single-provider
 *  dispatch, which never opened a tender) no quote at all. */
function lost(row: TRListRow) {
  return !!row.my_quote_status && row.my_quote_status !== WON
    && row.status !== "QUOTING";
}

/**
 * The outcome, said plainly. Nothing of the winner's is on the row to show — the
 * portal blanks the price, the carrier and the tracking numbers before it serves one
 * of these — so what is left is their own bid and what became of it.
 */
function LostState({ row }: { row: TRListRow }) {
  if (!lost(row)) return null;
  return (
    <p className="mt-1.5 text-xs font-medium text-rose-600">
      {row.my_quote_status === "DECLINED"
        ? "You declined this job — it went to another carrier"
        : row.my_quote_status === "INVITED"
          ? "The tender closed before your price came in"
          : row.my_quote_amount != null
            ? `Not awarded — you quoted ${money(row.my_quote_amount)}`
            : "Not awarded — it went to another carrier"}
    </p>
  );
}

/**
 * Whether this carrier has answered the tender — the one thing the card was missing.
 *
 * A priced lane stays on "Quote for it" (the desk can ask again, and a carrier can
 * revise until the award), so the status pill alone says QUOTING either way and the
 * board read as untouched the moment the carrier left the job screen. The amount and
 * the time it went in are what tell them the press landed.
 */
function QuoteState({ row }: { row: TRListRow }) {
  if (row.status !== "QUOTING") return null;

  // INVITED with a price on it is the desk sending it back for a better number: it is
  // an open ask again, not a quote in hand, and it has to read as one.
  const answered = row.my_quote_status && row.my_quote_status !== "INVITED";
  if (!answered) {
    return (
      <p className="mt-1.5 text-xs font-medium text-amber-600">
        {row.my_quote_amount != null
          ? `They asked for a new price — you last quoted ${money(row.my_quote_amount)}`
          : "Waiting for your price"}
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-xs font-medium text-emerald-600">
      Quoted {money(row.my_quote_amount)}
      {row.my_quote_submitted_at ? ` on ${fmtDateTime(row.my_quote_submitted_at)}` : ""}
      {" · waiting on their decision"}
    </p>
  );
}
