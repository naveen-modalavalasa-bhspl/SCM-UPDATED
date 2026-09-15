import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Clock, Send, Truck } from "lucide-react";
import {
  Button, Card, ErrorBanner, Input, KpiTiles, PageHeader, ResponsiveList, StatusPill,
  type Column, type KpiTileSpec,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { transportApi } from "../api";
import { CarrierComparison } from "../components/CarrierComparison";
import { load, modeLabel, modeTint, money } from "../components/modeCopy";
import type { ProviderBoardRow } from "../transportTypes";
import { ManifestTable } from "../components/ManifestTable";

const SIZE = 20;

/** The three views of this desk.
 *
 * `Open` is the working queue and stays the default — it is what the desk has to act
 * on today. The other two exist because awarding used to be the last time anyone ever
 * saw a shipment here: the moment a provider was fixed and the shipment moved on to
 * IN_TRANSIT it fell off the board, and "who did we award that to, and at what price"
 * had no screen left to answer it. An award is a purchasing decision; a decision you
 * cannot look up afterwards is not a record.
 *
 * The board is asked for its statuses explicitly rather than "everything" because the
 * endpoint falls back to the open three when nothing is named. */
const ALL_STATUSES = [
  "DRAFT", "PENDING_APPROVAL", "QUOTING", "AWAITING_CARRIER", "READY",
  "IN_TRANSIT", "DELIVERED", "ACKNOWLEDGED", "CLOSED", "REJECTED", "CANCELLED",
].join(",");

const VIEWS = [
  {
    key: "open",
    label: "Needs a decision",
    status: "QUOTING,AWAITING_CARRIER,READY",
    blurb: "Everything still waiting on a provider. Open a shipment to compare what "
      + "the partners quoted and award one.",
    empty: "Nothing waiting for a provider.",
  },
  {
    key: "awarded",
    // Every shipment whose provider is settled, right through to CLOSED — the record
    // of what this desk decided, not a second queue to work.
    label: "Awarded",
    status: "AWAITING_CARRIER,READY,IN_TRANSIT,DELIVERED,ACKNOWLEDGED,CLOSED",
    blurb: "Shipments with a provider fixed, including the ones already on the road "
      + "or delivered. Open one to see the quotes it was awarded against.",
    empty: "Nothing has been awarded yet.",
  },
  {
    key: "all",
    label: "All",
    status: ALL_STATUSES,
    blurb: "Every shipment the desk has seen, whatever became of it.",
    empty: "No shipments.",
  },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

/** Statuses at or past READY — the provider question has an answer. */
const SETTLED_STATUSES = new Set([
  "READY", "IN_TRANSIT", "DELIVERED", "ACKNOWLEDGED", "CLOSED",
]);

/**
 * Provider Selection — the RFQ desk. "Who is taking this, and at what price?"
 *
 * Three queues on one screen because they are one job: QUOTING is "prices still coming
 * in", AWAITING_CARRIER is "awarded, the carrier has not said yes yet", READY is
 * "settled, not yet gone". A desk works down all three, and a decline drops a shipment
 * straight back from the second to the first, so splitting them would mean watching
 * three places for one consignment.
 *
 * Awarding does not erase the row. The board opens on the working queue, and the
 * Awarded and All views keep every past decision reachable from the screen that made
 * it — see VIEWS.
 *
 * The RFQ lives HERE rather than on a screen of its own. Dispatch asks two or three
 * partners to price the same consignment; those prices are the answer to the question
 * this page already asked, so picking a row opens its comparison sheet in place —
 * every partner's quote side by side, the recommendation, and the award. A tender is
 * not a document, it is a decision, and the decision already had a page.
 *
 * Which shipment is open lives in the URL (`?tr=`), not in state: the desk is sent
 * here straight from Dispatch with a shipment named, and browser Back has to return
 * to the queue rather than out of the module.
 */
export function ProviderSelectionPage() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [viewKey, setViewKey] = useState<ViewKey>("open");
  // A narrower question INSIDE the open view, set by the KPI strip. Not a `?status=`:
  // that parameter already carries the view's whole status list.
  const [queue, setQueue] = useState<"" | "QUOTING" | "AWAITING_CARRIER" | "SETTLED">("");

  const view = VIEWS.find((v) => v.key === viewKey) ?? VIEWS[0];
  const openId = Number(params.get("tr") ?? 0);
  // FIX 2026-09-10: `?invite=1` is the intent the caller arrived with. The shipment's
  // "Invite carriers & award" press names inviting, so it must land on the partner
  // picker rather than on a tender sheet that has nothing on it yet.
  const wantsInvite = params.get("invite") === "1";

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport-provider-board", viewKey, page, search],
    queryFn: () => transportApi.providerBoard({
      page, size: SIZE, status: view.status, search: search.trim() || undefined,
    }),
    refetchInterval: 5_000,
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));
  const quoting = rows.filter((r) => r.status === "QUOTING").length;
  const awaiting = rows.filter((r) => r.status === "AWAITING_CARRIER").length;
  // READY and everything past it: the provider question is answered. Counted this way
  // rather than as READY alone so the card means the same thing on every view.
  const settled = rows.filter((r) => SETTLED_STATUSES.has(r.status)).length;

  // What the register shows. Separate from `rows` so the tiles keep counting the whole
  // view — pressing a tile must not change the number printed on it.
  const visible = queue === "" ? rows : rows.filter((r) => (
    queue === "SETTLED" ? SETTLED_STATUSES.has(r.status) : r.status === queue
  ));

  const open = (trId: number) => setParams({ tr: String(trId) });
  const closeSheet = () => setParams({});

  const columns: Column<ProviderBoardRow>[] = [
    {
      key: "tr",
      header: "Request",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.tr_no}</div>
          <div className="truncate text-[11px] text-muted">
            {r.consignment_no ? `${r.consignment_no} · ` : ""}
            {r.to_location_name ?? "—"}
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
      key: "replies",
      header: "Quotes in",
      className: "text-right",
      // 0 of 0 on a mode with no tender is not a gap: a courier booking was settled
      // at dispatch and has nothing to compare, so it says so rather than showing a
      // count that reads as "nobody has answered".
      render: (r) => (r.invited_count === 0 ? (
        <span className="text-sm text-muted">—</span>
      ) : (
        <span className={`text-sm font-semibold ${
          r.responded_count >= r.invited_count ? "text-emerald-600" : "text-amber-600"
        }`}>
          {r.responded_count} / {r.invited_count}
        </span>
      )),
    },
    {
      key: "best",
      header: "Best price",
      className: "text-right",
      render: (r) => (r.best_amount == null ? (
        <span className="text-sm text-muted">
          {r.invited_count > 0 ? "No price yet" : "—"}
        </span>
      ) : (
        <div>
          <div className="text-sm font-semibold text-ink">{money(r.best_amount)}</div>
          <div className="text-[11px] text-muted">
            {r.best_carrier_name ?? "—"}
            {r.best_transit_days != null && ` · ${r.best_transit_days}d`}
          </div>
        </div>
      )),
    },
    {
      key: "carrier",
      header: "Awarded to",
      // "Not chosen" is a prompt to act, so it is only shown while the decision is
      // still open. A delivered hand-over never had a carrier to name and is not a
      // gap on this desk.
      render: (r) => r.carrier_name ?? (
        SETTLED_STATUSES.has(r.status)
          ? <span className="text-muted">—</span>
          : <span className="text-amber-600">Not chosen</span>
      ),
    },
    {
      key: "due",
      header: "Needed by",
      hideOnNarrow: true,
      render: (r) => fmtDate(r.expected_delivery),
    },
  ];

  if (openId > 0) {
    return <ProviderSheet trId={openId} autoInvite={wantsInvite} onBack={closeSheet} />;
  }

  return (
    <div>
      <PageHeader eyebrow="Logistics" title="Provider Selection" />
      <p className="-mt-2 mb-4 text-sm text-muted">{view.blurb}</p>

      {/* Each tile narrows the register to the shipments it counted. Client-side:
          `?status=` on this endpoint is the VIEW's whole status list, and a tile asks a
          narrower question inside whichever view is open. Pressing the one already on
          clears it, so the strip can never disagree with the list. */}
      <KpiTiles label="Provider queues" className="mb-4" tiles={[
        {
          key: "quoting", label: "Out to partners", value: quoting, icon: Send,
          tone: quoting ? "brand" : "neutral", active: queue === "QUOTING",
          onPress: () => { setQueue((on) => (on === "QUOTING" ? "" : "QUOTING")); setPage(1); },
        },
        {
          key: "awaiting", label: "Awaiting the carrier", value: awaiting, icon: Clock,
          tone: awaiting ? "warn" : "neutral", active: queue === "AWAITING_CARRIER",
          onPress: () => {
            setQueue((on) => (on === "AWAITING_CARRIER" ? "" : "AWAITING_CARRIER"));
            setPage(1);
          },
        },
        {
          key: "settled", label: "Provider fixed", value: settled, icon: CheckCircle2,
          tone: settled ? "ok" : "neutral", active: queue === "SETTLED",
          onPress: () => { setQueue((on) => (on === "SETTLED" ? "" : "SETTLED")); setPage(1); },
        },
      ] satisfies KpiTileSpec[]} />

      <ErrorBanner error={error} />

      <Card className="p-2">
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2 pt-1">
          <div className="flex gap-1 rounded-lg bg-surface p-1">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => { setViewKey(v.key); setPage(1); }}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  v.key === viewKey
                    ? "bg-content1 text-ink shadow-sm"
                    : "text-muted hover:text-ink"}`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <Input
              value={search}
              placeholder="Request, consignment, indent or destination"
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
        </div>
        <ResponsiveList
          data={visible}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => open(r.id)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={view.empty}
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.tr_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.to_location_name ?? "—"}</div>
              <div className="text-xs text-muted">
                {modeLabel(r.mode)} · {r.total_packages} pkg ·{" "}
                {r.invited_count > 0
                  ? `${r.responded_count} of ${r.invited_count} quoted`
                  : (r.carrier_name ?? "no carrier yet")}
                {r.best_amount != null && ` · best ${money(r.best_amount)}`}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  One shipment's tender                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The RFQ sheet for one shipment: what is being priced, and every quote side by side.
 *
 * Rendered in place of the queue rather than under it. The queue is twenty rows and
 * the comparison is the thing being read — pushing it below the fold would mean
 * scrolling past the list to make the decision the list exists to reach.
 */
function ProviderSheet({ trId, autoInvite = false, onBack }: {
  trId: number;
  /** Arrived from a press that said "invite": open the partner picker straight away. */
  autoInvite?: boolean;
  onBack: () => void;
}) {
  const nav = useNavigate();

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["transport", String(trId)],
    queryFn: () => transportApi.get(trId),
    enabled: trId > 0,
    refetchInterval: 5_000,
  });

  // A carrier is picked and the shipment is waiting to have it confirmed. The status
  // is still QUOTING, but the tender is closed: awarding again would raise a second
  // award against a decision nobody has made yet.
  const awardPending = Boolean(doc?.awarded_at) && doc?.status === "QUOTING";

  if (isLoading || !doc) {
    return (
      <div>
        <PageHeader
          eyebrow="Logistics"
          title="Provider Selection"
          actions={
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" /> Back to the queue
            </Button>
          }
        />
        <ErrorBanner error={error} />
        <Card className="p-8 text-center text-sm text-muted">
          {isLoading ? "Loading…" : "That shipment could not be found."}
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Logistics"
        title={doc.tr_no}
        actions={
          <>
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" /> Back to the queue
            </Button>
            {/* Where the shipment goes once a provider is fixed: the transport
                request is the document that gets dispatched, tracked and signed for,
                and this desk's work ends at the award. */}
            <Button variant="subtle"
              onClick={() => nav(`/logistics/shipments/${doc.id}`)}>
              <Truck className="h-4 w-4" /> Open the shipment
            </Button>
          </>
        }
      />

      <ErrorBanner error={error} />

      <Card className="mb-4 p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StatusPill status={doc.status} />
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${modeTint(doc.mode)}`}>
            {modeLabel(doc.mode)}
          </span>
          {awardPending && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              Awaiting award confirmation
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Consignment</dt>
            <dd className="mt-1 font-mono text-xs text-body">
              {doc.consignment_no ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">From</dt>
            <dd className="mt-1 truncate text-body">{doc.from_warehouse_name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Going to</dt>
            <dd className="mt-1 truncate text-body">{doc.to_location_name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Needed by</dt>
            <dd className="mt-1 text-body">{fmtDate(doc.expected_delivery)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Load</dt>
            <dd className="mt-1 text-body">
              {load(doc.total_packages, doc.total_weight_kg)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Lines</dt>
            <dd className="mt-1 text-body">{doc.total_items}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Awarded to</dt>
            <dd className="mt-1 text-body">{doc.carrier_name ?? "Not yet"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Agreed freight</dt>
            <dd className="mt-1 text-body">
              {doc.freight_amount != null ? money(doc.freight_amount) : "—"}
            </dd>
          </div>
        </dl>

        {/* The award is only half the answer. A price quoted for a lane is not a
            promise of a vehicle on the day, so the winner still has to accept the job
            in their own portal before anything can be loaded. */}
        {doc.status === "AWAITING_CARRIER" && (
          <p className="mt-4 rounded-md border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200">
            Awarded to {doc.carrier_name}. They have not confirmed the job yet — a won
            tender is an offer, not a booking. Their answer, or the desk recording one
            on their behalf, is on the shipment.
          </p>
        )}
      </Card>

      {/* What the carriers are pricing, in the manifest panel every other logistics
        * screen uses. The heading it carries is the same one the carrier sees on
        * their job sheet, which is the point: a price is quoted against a load, and
        * the two sides must be reading the same statement of it. */}
      <ManifestTable className="mb-5" items={doc.items} status={doc.status} />

      {/* The prices themselves, and the press that settles them. Drawn off the
          INVITATIONS on the shipment rather than off its mode: a third-party tender
          and a courier asked for its rate both carry a quote row and both are decided
          here, while a manual courier, an own vehicle and a hand-over carry none
          because there was never anybody outside to ask. Keyed on the mode, a courier
          booked with a registered courier reached this desk with its price sitting on
          it and nothing to press. */}
      <Card className="p-5">
        <CarrierComparison
          trId={doc.id}
          status={doc.status}
          quotes={doc.quotes}
          awardPending={awardPending}
          autoInvite={autoInvite}
          compact
          onAwarded={(id) => nav(`/logistics/shipments/${id}`)}
        />
      </Card>
      {/* FIX 2026-09-10: it used to read "click Invite more above" — the name of a quiet
          ghost button in the corner of the card, and one that is not rendered at all for
          a login without `transport.award`. The picker is now offered inside the card,
          where the emptiness is, so this only has to say what the step is FOR. */}
      {doc.quotes.length === 0 && doc.status === "QUOTING" && (
        <Card className="mt-3 border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          No carriers invited yet. Pick 2–3 logistics vendors above and invite them to
          price this shipment — their quotes come back here for you to compare and award.
        </Card>
      )}
    </div>
  );
}
