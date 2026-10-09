import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, FileText, Handshake, Package } from "lucide-react";
import { ErrorBanner, StatusPill } from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { carrierPortalApi } from "../api";
import { load, money } from "../components/modeCopy";
import type { TRListRow } from "../transportTypes";
import {
  CardAction, CardSkeleton, EmptyQueue, Lane, MetaChip, PortalHeading, TONE,
} from "./portalUi";

/** The only rung of the ladder this board covers, and the only one a carrier is ever
 *  waiting on us for: price the lane, revise it until the desk decides.
 *
 *  It used to carry five queues — collect, on the road, delivered, not awarded — one
 *  per status the shipment could be in. That is OUR ladder, not the carrier's day. A
 *  carrier prices lanes and confirms the ones they win; everything past the award is
 *  the Acknowledgements screen's, so the board that listed five kinds of row now lists
 *  one and hands the awarded ones over at the top.
 */
const QUEUE = "QUOTING";

/**
 * Quote for it — every lane this carrier has been invited to price, and nothing else.
 *
 * Cards rather than a table: a carrier opens this on a phone at a loading bay, and
 * the four things that matter (where from, where to, how much, what do I press) have
 * to be readable without a horizontal scroll. Each card is built in that order — a
 * coloured edge for their own position on it, the lane drawn, the load, then the
 * press — so "what does this one want from me" is answered before the detail screen
 * is ever opened.
 */
export function CarrierJobsPage() {
  const nav = useNavigate();

  const { data: summary } = useQuery({
    queryKey: ["carrier-summary"],
    queryFn: carrierPortalApi.summary,
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ["carrier-jobs", QUEUE],
    queryFn: () => carrierPortalApi.list({ status: QUEUE, size: 50 }),
  });

  const rows = data?.items ?? [];
  const toQuote = summary?.to_quote ?? 0;
  // Awards waiting on their yes. Not a list on this board — accepting one means naming
  // the vehicle and the driver, and that form is the Acknowledgements screen — but it
  // is the most urgent thing a carrier can have outstanding, so it is said at the top
  // and handed straight over.
  const toAcknowledge = summary?.to_confirm ?? 0;
  // Everything somebody on our side is waiting on THEM for. Said once at the top,
  // because a carrier opening the portal wants to know whether they owe us anything
  // before they read a single card.
  const owed = toQuote + toAcknowledge;

  return (
    <div>
      <PortalHeading
        title="Quote for it"
        subtitle="Price a lane, and revise it until the desk decides."
        aside={
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-content1 px-3 py-1.5 text-xs font-medium text-muted">
            <span className={`h-2 w-2 rounded-full ${owed ? "bg-signal" : "bg-ok"}`} />
            {owed ? `${owed} waiting on you` : "Nothing waiting on you"}
          </span>
        }
      />

      {/* The one thing this board cannot finish itself. A won lane needs the vehicle
          and the driver named before it can go to READY, so the press hands over to
          the screen that asks for them. Drawn as a light wash, not a red alert: it is
          work waiting, not something gone wrong. */}
      {toAcknowledge > 0 && (
        <button
          type="button"
          onClick={() => nav("/carrier/acknowledgements")}
          className="group mb-4 flex w-full items-center justify-between gap-3 rounded-2xl border border-brand/25 bg-brand-050 px-4 py-3 text-left transition hover:border-brand/50"
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/70 text-brand">
              <Handshake className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink">
                {toAcknowledge === 1 ? "1 job is yours" : `${toAcknowledge} jobs are yours`}
                {" — waiting on your yes"}
              </span>
              <span className="block text-xs text-muted">
                Name the vehicle and the driver, and the warehouse loads against it.
              </span>
            </span>
          </span>
          <span className="shrink-0 whitespace-nowrap rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">
            Acknowledge
          </span>
        </button>
      )}

      <ErrorBanner error={error} />

      {isLoading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <EmptyQueue
          title="Nothing to price"
          hint="A lane lands here the moment the logistics desk invites you to quote for it. Jobs you win move to Acknowledgements."
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id}>
              <JobCard row={row} onOpen={() => nav(`/carrier/jobs/${row.id}`)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One lane, as the carrier's own position on it.
 *
 * The whole card is the press — a driver on a phone should not have to find a link
 * inside it — and the edge colour, the state line and the action label are all read
 * off the same `state()` call, so a card can never say "waiting for your price" in
 * amber next to a press that offers to revise one.
 */
function JobCard({ row, onOpen }: { row: TRListRow; onOpen: () => void }) {
  const view = state(row);
  const tone = TONE[view.tone];

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative w-full overflow-hidden rounded-2xl border border-line bg-content1 text-left shadow-[0_1px_2px_rgba(14,20,36,0.04)] transition hover:-translate-y-px hover:border-brand/40 hover:shadow-[0_10px_28px_-16px_rgba(62,99,221,0.55)]"
    >
      {/* The edge, not another badge: at arm's length on a phone the colour of the
          left rail is what survives, and it is the one thing that says whether this
          row is waiting on the carrier. */}
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} />

      <div className="p-4 pl-5 sm:pl-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-xs font-semibold tracking-tight text-ink">
            {row.tr_no}
          </span>
          <StatusPill status={row.status} />
        </div>

        <p className={`mt-2 inline-flex items-start gap-1.5 rounded-lg px-2 py-1 text-xs font-medium ${tone.chip}`}>
          <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
          {view.line}
        </p>

        <Lane
          from={row.from_warehouse_name ?? "Warehouse"}
          to={row.to_location_name ?? "Destination"}
        />

        <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line/70 pt-3">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            <MetaChip icon={Package}>
              {load(row.total_packages, row.total_weight_kg)}
            </MetaChip>
            {row.expected_delivery && (
              <MetaChip icon={CalendarClock}>
                needed by {fmtDate(row.expected_delivery)}
              </MetaChip>
            )}
            {(row.lr_no || row.docket_no) && (
              <MetaChip icon={FileText}>
                <span className="font-mono">{row.lr_no ?? row.docket_no}</span>
              </MetaChip>
            )}
            {row.freight_amount ? (
              <MetaChip strong>{money(row.freight_amount)}</MetaChip>
            ) : null}
          </div>
          <CardAction label={view.action} />
        </div>
      </div>
    </button>
  );
}

/**
 * Where this carrier stands on this lane — the line the card prints, the tint it
 * wears and the press it offers, decided once.
 *
 * Nothing here is new information: it is the row's status and the carrier's own quote,
 * read the way the job screen reads them, so the card promises exactly the press that
 * screen is about to show. Two answers only, because the board carries one queue: we
 * are waiting for a price, or we have one and the desk is deciding.
 */
function state(row: TRListRow): {
  tone: "wait" | "done"; line: string; action: string;
} {
  // INVITED with a price on it is the desk sending it back for a better number: it is
  // an open ask again, not a quote in hand, and it has to read as one.
  const answered = row.my_quote_status && row.my_quote_status !== "INVITED";

  if (!answered) {
    return {
      tone: "wait",
      action: row.my_quote_amount != null ? "Send a new price" : "Send your price",
      line: row.my_quote_amount != null
        ? `They asked for a new price — you last quoted ${money(row.my_quote_amount)}`
        : "Waiting for your price",
    };
  }

  // A priced lane stays here (the desk can ask again, and a carrier can revise until
  // the award), so the status pill alone says QUOTING either way and the board read as
  // untouched the moment the carrier left the job screen. The amount and the time it
  // went in are what tell them the press landed.
  return {
    tone: "done",
    action: "Revise your price",
    line: `Quoted ${money(row.my_quote_amount)}${
      row.my_quote_submitted_at ? ` on ${fmtDateTime(row.my_quote_submitted_at)}` : ""
    } · waiting on their decision`,
  };
}
