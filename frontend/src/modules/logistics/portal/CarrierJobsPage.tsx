import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight, CalendarClock, ClipboardList, FileText, Handshake, Package,
  PackageCheck, Truck, XCircle,
} from "lucide-react";
import { ErrorBanner, StatusPill } from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { carrierPortalApi } from "../api";
import { load, money } from "../components/modeCopy";
import type { TRListRow } from "../transportTypes";
import {
  CardAction, CardSkeleton, EmptyQueue, Lane, MetaChip, PortalHeading, QueueChip,
  TONE, type Tone,
} from "./portalUi";

/** The carrier's own queues, in the order their day runs. Each one is a filter, and
 *  the label says what THEY have to do — not what status the shipment is in.
 *
 *  One rung of the transport ladder each, and every one of them ends in a press this
 *  board can actually make. AWAITING_CARRIER is deliberately NOT here: taking a job
 *  means naming the vehicle and the driver, which is the Acknowledgements screen's
 *  form and nothing this board can do — the chip was a second front door onto that
 *  same list whose only press was a link to it. What is left in its place is the
 *  banner below, which says how many are waiting and hands them straight over.
 */
const QUEUES = [
  { key: "QUOTING", label: "Quote for it", icon: ClipboardList },
  { key: "READY", label: "Collect", icon: Truck },
  { key: "IN_TRANSIT", label: "On the road", icon: ArrowRight },
  { key: "DELIVERED,ACKNOWLEDGED", label: "Delivered", icon: PackageCheck },
  // Not a status — an outcome, and the one queue that closes the loop. A carrier who
  // priced a lane and did not get it used to watch the shipment disappear off every
  // queue with nothing said, which reads as the portal having dropped it. The answer
  // is the last thing that happens on a tender, so it gets a place to be read.
  { key: "NOT_AWARDED", label: "Not awarded", icon: XCircle },
];

/** What an empty queue should say. Most of the five are empty on a normal day and each
 *  is empty for its own reason — "nothing here" on all of them taught a carrier
 *  nothing about whether they were waiting on us or we were waiting on them. */
const EMPTY: Record<string, string> = {
  QUOTING:
    "Nothing to price right now. A lane lands here the moment the logistics desk invites you to quote for it.",
  READY:
    "Nothing to collect. A job you accepted moves here once the warehouse has it packed.",
  IN_TRANSIT: "Nothing on the road under your name at the moment.",
  "DELIVERED,ACKNOWLEDGED":
    "Nothing delivered yet. Loads you report delivered stay here for your record.",
  NOT_AWARDED: "No closed tenders. Lanes you priced but did not win are listed here.",
};

/** The one quote status that means the job is theirs. Anything else on a settled
 *  request — outbid, declined, or never priced — is a tender they did not win. */
const WON = "AWARDED";

/**
 * Everything this carrier has been invited to, and nothing else.
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
    READY: summary?.to_pick_up ?? 0,
    IN_TRANSIT: summary?.on_the_road ?? 0,
    "DELIVERED,ACKNOWLEDGED": summary?.delivered ?? 0,
    NOT_AWARDED: summary?.not_awarded ?? 0,
  };
  // Awards waiting on their yes. Not a queue on this board — accepting one means
  // naming the vehicle and the driver, and that form is the Acknowledgements screen —
  // but it is the most urgent thing a carrier can have outstanding, so it is said at
  // the top and handed straight over.
  const toAcknowledge = summary?.to_confirm ?? 0;
  // Everything somebody on our side is waiting on THEM for. Said once at the top,
  // because a carrier opening the portal wants to know whether they owe us anything
  // before they read a single card.
  const owed = counts.QUOTING + toAcknowledge;

  return (
    <div>
      <PortalHeading
        title="Shipments"
        subtitle="Price a lane, take the job, and tell us where it is."
        aside={
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-content1 px-3 py-1.5 text-xs font-medium text-muted">
            <span className={`h-2 w-2 rounded-full ${owed ? "bg-signal" : "bg-ok"}`} />
            {owed ? `${owed} waiting on you` : "Nothing waiting on you"}
          </span>
        }
      />

      {/* The one thing this board cannot finish itself. A won lane needs the vehicle
          and the driver named before it can go to READY, so the press hands over to
          the screen that asks for them rather than opening a queue that would only
          link there again. Drawn as a light wash, not a red alert: it is work waiting,
          not something gone wrong. */}
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

      {/* The rail scrolls sideways inside its own box rather than wrapping to two
          rows of tiles: on a phone the shipments have to start above the fold. */}
      <div className="-mx-4 mb-5 overflow-x-auto px-4 pb-1">
        <div className="flex w-max gap-2">
          {QUEUES.map((item) => (
            <QueueChip
              key={item.key}
              icon={item.icon}
              label={item.label}
              count={counts[item.key] ?? 0}
              active={queue === item.key}
              onClick={() => setQueue(item.key)}
            />
          ))}
        </div>
      </div>

      <ErrorBanner error={error} />

      {isLoading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <EmptyQueue
          title="Nothing in this queue"
          hint={EMPTY[queue] ?? "Nothing in this queue right now."}
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
 * One shipment, as the carrier's own position on it.
 *
 * The whole card is the press — a driver on a phone should not have to find a link
 * inside it — and the edge colour, the state line and the action label are all read
 * off the same `state()` call, so a card can never say "waiting for your price" in
 * amber next to a press that offers to accept the job.
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
          {/* On a lost row the shipment's status is describing another carrier's
              truck — IN TRANSIT here would read as this carrier's load being on the
              road. What they are shown is their own answer. */}
          <StatusPill status={view.lost ? "NOT_AWARDED" : row.status} />
        </div>

        {view.line && (
          <p className={`mt-2 inline-flex items-start gap-1.5 rounded-lg px-2 py-1 text-xs font-medium ${tone.chip}`}>
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
            {view.line}
          </p>
        )}

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

/** A tender this carrier did not win: their own quote says so, not the shipment.
 *  A shipment they ARE running carries either an AWARDED quote or (a single-provider
 *  dispatch, which never opened a tender) no quote at all. */
function lost(row: TRListRow) {
  return !!row.my_quote_status && row.my_quote_status !== WON
    && row.status !== "QUOTING";
}

/**
 * Where this carrier stands on this shipment — the line the card prints, the tint it
 * wears and the press it offers, decided once.
 *
 * Nothing here is new information: it is the row's status and the carrier's own quote,
 * read the way the job screen reads them, so the card promises exactly the press that
 * screen is about to show. Nothing of the winner's is on a lost row to show — the
 * portal blanks the price, the carrier and the tracking before it serves one — so
 * what is left is their own bid and what became of it.
 */
function state(row: TRListRow): {
  tone: Tone; line: string; action: string; lost: boolean;
} {
  if (lost(row)) {
    return {
      tone: "lost",
      lost: true,
      action: "See what happened",
      line: row.my_quote_status === "DECLINED"
        ? "You declined this job — it went to another carrier"
        : row.my_quote_status === "INVITED"
          ? "The tender closed before your price came in"
          : row.my_quote_amount != null
            ? `Not awarded — you quoted ${money(row.my_quote_amount)}`
            : "Not awarded — it went to another carrier",
    };
  }

  if (row.status === "QUOTING") {
    // INVITED with a price on it is the desk sending it back for a better number: it
    // is an open ask again, not a quote in hand, and it has to read as one.
    const answered = row.my_quote_status && row.my_quote_status !== "INVITED";
    if (!answered) {
      return {
        tone: "wait",
        lost: false,
        action: row.my_quote_amount != null ? "Send a new price" : "Send your price",
        line: row.my_quote_amount != null
          ? `They asked for a new price — you last quoted ${money(row.my_quote_amount)}`
          : "Waiting for your price",
      };
    }
    // A priced lane stays on "Quote for it" (the desk can ask again, and a carrier can
    // revise until the award), so the status pill alone says QUOTING either way and
    // the board read as untouched the moment the carrier left the job screen. The
    // amount and the time it went in are what tell them the press landed.
    return {
      tone: "done",
      lost: false,
      action: "Revise your price",
      line: `Quoted ${money(row.my_quote_amount)}${
        row.my_quote_submitted_at ? ` on ${fmtDateTime(row.my_quote_submitted_at)}` : ""
      } · waiting on their decision`,
    };
  }

  switch (row.status) {
    case "AWAITING_CARRIER":
      return {
        tone: "mine", lost: false, action: "Accept the job",
        line: "This lane is yours — confirm the vehicle and the driver",
      };
    case "READY":
      return {
        tone: "mine", lost: false, action: "Add the LR number",
        line: "Ready to collect — the warehouse has it packed",
      };
    case "IN_TRANSIT":
      return {
        tone: "mine", lost: false, action: "Report it delivered",
        line: "On the road — tell us when it lands",
      };
    case "DELIVERED":
      return {
        tone: "done", lost: false, action: "View shipment",
        line: "Delivered — waiting for the site to sign for it",
      };
    case "ACKNOWLEDGED":
    case "CLOSED":
      return {
        tone: "done", lost: false, action: "View shipment",
        line: "Signed for by the site",
      };
    default:
      return { tone: "calm", lost: false, action: "View shipment", line: "" };
  }
}
