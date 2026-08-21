import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ScrollText } from "lucide-react";
import {
  Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader,
  ResponsiveList, StatCard, StatusPill, useAction, type Column,
} from "@/shared/components";
import { fmtDate, fmtTime } from "@/shared/datetime";
import { consignmentApi, transportApi } from "../api";
import { carriageLabel, carriageTint, load, modeLabel, modeTint, money } from "../components/modeCopy";
import type { Consignment, ConsignmentLink, TransportRequest } from "../transportTypes";

const SIZE = 20;

/**
 * The queue is a board, not a report.
 *
 * What it shows moves without anyone here touching it: the provider prices the job in
 * their own portal, they accept it, the driver's leg is marked in transit, the site
 * signs for it. None of that happens in this tab, so a queue that only loads once
 * shows yesterday's answer until somebody reloads the browser — which is exactly what
 * "waiting on a price" turning into "booked" ten minutes late looks like.
 *
 * So it polls, and it refetches the moment the tab is looked at again. Ten seconds is
 * the floor worth having: fast enough that a status settles while you are still
 * looking at the row, cheap enough that the whole page is two requests.
 */
const LIVE_MS = 10_000;

const destinationOf = (row: Consignment) =>
  row.destination_office_name
  ?? row.to_warehouse_name
  ?? row.customer_name
  ?? row.delivery_address
  ?? "—";

/**
 * Dispatch: how does this consignment travel, and with whom.
 *
 * Two questions, one press. The warehouse has already picked, packed and released it;
 * what is left is the decision this screen exists for, and everything the transport
 * needs — destination, contact, indent, every line with its carton weights — comes
 * off the consignment rather than being retyped.
 *
 * Third-party is the one mode with a round trip, and it is the reason the row does not
 * disappear after dispatching: choose a provider and the job lands in THEIR portal,
 * they send a price back, and the row here turns into "Flipkart quoted ₹4,500 —
 * accept, or ask again". Accept and it is booked and ready to leave. Every other mode
 * is settled the moment it is chosen, because a courier's rate is published, a company
 * vehicle costs nothing, and a hand-over hires nobody.
 *
 * The decision itself is `DispatchConfirmPage` — one screen, reached from here and
 * from the consignment. This is the QUEUE: what is packed, what is already moving,
 * and what is waiting on a price.
 */
export function DispatchPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [asking, setAsking] = useState<ConsignmentLink | null>(null);
  const [askNote, setAskNote] = useState("");

  const { data, isLoading, error, isFetching: queueFetching } = useQuery({
    queryKey: ["lgs-dispatch-queue", search, page],
    queryFn: () => consignmentApi.list({
      status: "PACKED", search: search.trim() || undefined, page, size: SIZE,
    }),
    // A poll must never blank the board it is refreshing: keeping the previous page
    // on screen is what makes ten-second refreshes invisible instead of a flicker.
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: true,
  });

  const rows = data?.items ?? [];
  const ids = rows.map((row) => row.id);

  // One call for the whole page: which of these already have transport, and where it
  // has got to. Never one lookup per row.
  const {
    data: links, isPending: linksPending, isPlaceholderData: linksAreOld,
    isFetching: linksFetching, dataUpdatedAt,
  } = useQuery({
    queryKey: ["lgs-consignment-links", ids.join(",")],
    queryFn: () => transportApi.forConsignments(ids),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: true,
  });
  const { data: quoted } = useQuery({
    queryKey: ["transport", String(asking?.tr_id ?? "")],
    queryFn: () => transportApi.get(asking!.tr_id),
    enabled: Boolean(asking),
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: true,
  });
  // Only fetched while a quote is on the table, and only for that one shipment — but
  // polled while it is open, because the price the desk is looking at is one the
  // provider can revise from their portal mid-decision.
  const linkOf = (row: Consignment) =>
    links?.find((link) => link.dispatch_id === row.id);

  // "This consignment has no transport" and "we do not know yet" are different
  // answers, and the screen used to give the first one for both: for the beat between
  // the consignment list landing and its transport landing, every already-dispatched
  // row read "Not dispatched yet" with a Dispatch button under it, then snapped to
  // Third-party / IN TRANSIT. `links` is stale-but-shown during a page or search
  // change (keepPreviousData), so a stale answer counts as not-known too.
  const linksKnown = ids.length === 0 || (!linksPending && !linksAreOld);

  // WHICH rows the answer on screen actually covers.
  //
  // `links` is stale-but-shown while a new page's answer is in flight, and the whole
  // board was being held on a placeholder for it: one consignment getting packed
  // changes the id set, the key changes with it, and every row without transport went
  // back to a grey bar — including the row the desk was about to press Dispatch on.
  // A row the current answer already asked about keeps that answer; only a row it has
  // never asked about is genuinely unknown, and only that row waits.
  const covered = useRef<Set<number>>(new Set());
  if (links && !linksAreOld) covered.current = new Set(ids);
  const rowKnown = (row: Consignment) => linksKnown || covered.current.has(row.id);

  const invalidates = [["lgs-dispatch-queue"], ["lgs-consignment-links"],
    ["lgs-packed-consignments"], ["transport"], ["transport-summary"]];

  const patchLink = (tr: TransportRequest) =>
    qc.setQueriesData<ConsignmentLink[]>(
      { queryKey: ["lgs-consignment-links"] },
      (old) => old?.map((link) => (link.tr_id === tr.id
        ? {
          ...link,
          status: tr.status,
          mode: tr.mode,
          carrier_name: tr.carrier_name ?? link.carrier_name,
          lr_no: tr.lr_no ?? link.lr_no,
        }
        : link)),
    );

  /**
   * Move the row the instant the server answers, rather than one round trip later.
   *
   * Invalidating is right but it is not immediate — it fires a refetch and the row sits
   * on its old status until that returns. The response to the press already carries the
   * new status, so write it into the queue's own cache; the refetch that follows
   * confirms it.
   */
  /** The decision screen, with this consignment already chosen. */
  const dispatch = (row: Consignment) =>
    nav(`/logistics/dispatch/new?consignment_id=${row.id}`);

  const accept = useAction({
    run: (trId: number) => transportApi.acceptQuote(trId),
    // Accepting the price is our half. The provider still has to say they have a
    // vehicle for that date, and until they do nothing may be loaded against it.
    success: "Price accepted — waiting for the provider to confirm the job",
    invalidates,
    // Close on the way out: the modal used to stay open over the accepted quote, so
    // the one row that had just changed was the one row hidden behind it.
    onDone: (tr) => { patchLink(tr); setAsking(null); setAskNote(""); },
  });

  const askAgain = useAction({
    run: () => transportApi.askRevisedQuote(asking!.tr_id, askNote),
    success: "Sent back to the provider", invalidates,
    onDone: (tr) => { patchLink(tr); setAsking(null); setAskNote(""); },
  });

  const refreshing = queueFetching || linksFetching;
  const refreshNow = () => {
    qc.invalidateQueries({ queryKey: ["lgs-dispatch-queue"] });
    qc.invalidateQueries({ queryKey: ["lgs-consignment-links"] });
  };

  const open = (row: Consignment) => dispatch(row);

  const columns: Column<Consignment>[] = [
    {
      key: "no",
      header: "Consignment",
      render: (row) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{row.dispatch_no}</div>
          <div className="text-[11px] text-muted">
            {fmtDate(row.dispatch_date)}{row.ref_no ? ` · ${row.ref_no}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "to",
      header: "Going to",
      render: (row) => (
        <div className="min-w-0 text-sm">
          <div className="truncate text-body">{destinationOf(row)}</div>
          <div className="truncate text-[11px] text-muted">
            from {row.warehouse_name ?? "—"}
          </div>
        </div>
      ),
    },
    {
      key: "load",
      header: "Load",
      className: "text-right",
      hideOnNarrow: true,
      render: (row) => (
        <span className="text-sm text-body">
          {load(row.total_packages, row.total_weight_kg)}
        </span>
      ),
    },
    {
      key: "transport",
      header: "Transport",
      render: (row) => {
        const link = linkOf(row);
        if (!link) {
          if (!rowKnown(row)) {
            return (
              <span className="text-xs text-muted">Checking…</span>
            );
          }
          return <span className="text-xs text-muted">Not dispatched yet</span>;
        }
        return (
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${carriageTint(link.carriage_mode)}`}>
                {carriageLabel(link.carriage_mode)}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${modeTint(link.mode)}`}>
                {modeLabel(link.mode)}
              </span>
              <StatusPill status={link.status} />
            </div>
            <div className="truncate text-[11px] text-muted">
              {link.carrier_name ?? link.tr_no}
              {link.lr_no ? ` · ${link.lr_no}` : ""}
            </div>
            {/* Who is coming for it. On a tender the desk never typed this — it is the
                carrier's own answer, written when they acknowledged the award — so the
                queue is where it is first read, and a row that says READY without a
                vehicle against it is a row nobody can meet at the gate. */}
            {(link.driver_name || link.vehicle_number) && (
              <div className="truncate text-[11px] text-muted">
                {[link.driver_name, link.vehicle_number].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "act",
      header: "",
      className: "text-right",
      render: (row) => {
        const link = linkOf(row);
        if (!link) {
          // Offering Dispatch before the lookup lands is how a consignment gets a
          // second transport request for one physical load.
          if (!rowKnown(row)) {
            return (
              <span className="ml-auto block h-8 w-20 animate-pulse rounded-lg bg-content2" />
            );
          }
          return (
            <Can do="transport.create">
              <Button onClick={() => dispatch(row)}>Dispatch</Button>
            </Can>
          );
        }
        if (link.status === "QUOTING") {
          return (
            <Can do="transport.create">
              <Button onClick={() => dispatch(row)}>Dispatch</Button>
            </Can>
          );
        }
        // Our yes is in; theirs is not. The row stays on the queue rather than
        // reading as booked, because nothing may be loaded against it yet.
        if (link.status === "AWAITING_CARRIER") {
          return (
            <Can do="transport.create">
              <Button onClick={() => dispatch(row)}>Dispatch</Button>
            </Can>
          );
        }
        return (
          <div className="flex items-center justify-end gap-1">
            {/* This consignment's own trail, scoped by the warehouse document rather
                than by the transport number — the desk knows the consignment it is
                chasing, not the TR it grew into. */}
            <Button onClick={() => dispatch(row)}>Dispatch</Button>
          </div>
        );
      },
    },
  ];

  const waitingOnPrice = (links ?? []).filter((l) => l.status === "QUOTING").length;
  // Priced and accepted, waiting on the provider's yes. Counted apart from "booked"
  // on purpose: these are the ones a chased phone call turns into a truck.
  const awaitingCarrier = (links ?? []).filter(
    (l) => l.status === "AWAITING_CARRIER").length;
  const moving = (links ?? []).filter(
    (l) => ["READY", "IN_TRANSIT"].includes(l.status)).length;

  return (
    <div>
      <PageHeader
        eyebrow="Logistics"
        title="Dispatch"
        actions={
          <>
            {/* Says out loud that the board is live and when it last heard, so a row
                that has not moved reads as "nothing has happened" rather than as
                "this screen is stuck". */}
            <span className="text-[11px] text-muted">
              {refreshing
                ? "Refreshing…"
                : dataUpdatedAt ? `Updated ${fmtTime(dataUpdatedAt)}` : ""}
            </span>
            <Button variant="ghost" onClick={refreshNow} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {/* The board says where each consignment stands right now; the ledger says
                how it got there — who approved it, who quoted, who was awarded it and
                what they charged. Reached from here because this is the screen the
                question is asked on. */}
            <Button variant="ghost" onClick={() => nav("/logistics/activity")}>
              <ScrollText className="h-4 w-4" />
              Activity ledger
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Packed, on this page" value={rows.length} />
        <StatCard
          label="Waiting on a price"
          value={waitingOnPrice}
          tone={waitingOnPrice ? "text-amber-600" : "text-ink"}
        />
        <StatCard
          label="Awaiting the provider"
          value={awaitingCarrier}
          tone={awaitingCarrier ? "text-amber-600" : "text-ink"}
        />
        <StatCard label="Booked or gone" value={moving} />
      </div>

      <div className="mb-4 max-w-xs">
        <Input
          value={search}
          placeholder="Consignment, issue or destination…"
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      <ErrorBanner error={error ?? accept.error ?? askAgain.error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(row) => row.id}
          loading={isLoading}
          onRowClick={open}
          page={page}
          totalPages={Math.max(1, Math.ceil((data?.total ?? 0) / SIZE))}
          onPageChange={setPage}
          empty="Nothing packed and waiting to go out."
          renderCard={(row) => {
            const link = linkOf(row);
            return (
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-ink">
                    {row.dispatch_no}
                  </span>
                  {link ? <StatusPill status={link.status} /> : null}
                  {!link && !rowKnown(row) ? (
                    <span className="block h-4 w-20 animate-pulse rounded bg-content2" />
                  ) : null}
                </div>
                <div className="text-sm text-body">{destinationOf(row)}</div>
                <div className="text-xs text-muted">
                  {load(row.total_packages, row.total_weight_kg)}
                  {link?.carrier_name ? ` · ${link.carrier_name}` : ""}
                </div>
              </div>
            );
          }}
        />
      </Card>

      {/* The price came back. Accept it, or send it back with a note. */}
      <ConfirmModal
        isOpen={Boolean(asking)}
        title={`${asking?.carrier_name ?? "The provider"} · ${asking?.tr_no ?? ""}`}
        message="Accept the price and the job goes back to them to confirm, or ask
                 them to quote again. Nothing is loaded until they say yes."
        confirmLabel="Accept the price"
        busy={accept.isPending}
        confirmDisabled={!quoted?.quotes.some((q) => q.status === "SUBMITTED")}
        onConfirm={() => accept.mutate(asking!.tr_id)}
        onClose={() => { setAsking(null); setAskNote(""); }}
      >
        <div className="space-y-3">
          {quoted?.quotes.map((quote) => (
            <div key={quote.id} className="rounded-lg border border-line p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-ink">
                  {quote.carrier_name}
                </span>
                <span className="font-display text-xl font-bold text-ink">
                  {quote.freight_amount != null
                    ? money(Number(quote.freight_amount) + Number(quote.other_charges ?? 0))
                    : "—"}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {quote.status === "SUBMITTED"
                  ? `${quote.transit_days ?? "?"} day(s) · ${quote.vehicle_type ?? "vehicle not stated"}`
                  : "Waiting for them to send a price"}
              </div>
              {quote.remarks && (
                <p className="mt-1 text-xs text-body">{quote.remarks}</p>
              )}
            </div>
          ))}

          <Field label="Not happy with it? Say what to change">
            <Input value={askNote} placeholder="Can you do it for 4,000?"
              onChange={(e) => setAskNote(e.target.value)} />
          </Field>
          <Button
            variant="dangerSoft"
            onClick={() => askAgain.mutate()}
            disabled={askAgain.isPending || !askNote.trim()}
          >
            Send back for a new price
          </Button>
        </div>
      </ConfirmModal>
    </div>
  );
}
