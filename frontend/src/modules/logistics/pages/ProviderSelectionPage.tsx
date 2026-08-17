import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Truck } from "lucide-react";
import {
  Button, Card, ErrorBanner, Input, PageHeader, ResponsiveList, StatCard, StatusPill,
  type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { transportApi } from "../api";
import { CarrierComparison } from "../components/CarrierComparison";
import { load, modeLabel, modeTint, money } from "../components/modeCopy";
import type { ProviderBoardRow } from "../transportTypes";

const SIZE = 20;

/**
 * Provider Selection — the RFQ desk. "Who is taking this, and at what price?"
 *
 * Three queues on one screen because they are one job: QUOTING is "prices still coming
 * in", AWAITING_CARRIER is "awarded, the carrier has not said yes yet", READY is
 * "settled, not yet gone". A desk works down all three, and a decline drops a shipment
 * straight back from the second to the first, so splitting them would mean watching
 * three places for one consignment.
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

  const openId = Number(params.get("tr") ?? 0);

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport-provider-board", page, search],
    queryFn: () => transportApi.providerBoard({
      page, size: SIZE, search: search.trim() || undefined,
    }),
    refetchInterval: 5_000,
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));
  const quoting = rows.filter((r) => r.status === "QUOTING").length;
  const awaiting = rows.filter((r) => r.status === "AWAITING_CARRIER").length;
  const ready = rows.filter((r) => r.status === "READY").length;

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
      render: (r) => r.carrier_name ?? (
        <span className="text-amber-600">Not chosen</span>
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
    return <ProviderSheet trId={openId} onBack={closeSheet} />;
  }

  return (
    <div>
      <PageHeader eyebrow="Logistics" title="Provider Selection" />
      <p className="-mt-2 mb-4 text-sm text-muted">
        Everything still waiting on a provider. Open a shipment to compare what the
        partners quoted and award one.
      </p>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Out to partners" value={quoting} />
        <StatCard
          label="Awaiting the carrier"
          value={awaiting}
          tone={awaiting ? "text-amber-600" : "text-ink"}
        />
        <StatCard label="Confirmed, awaiting dispatch" value={ready} />
      </div>

      <ErrorBanner error={error} />

      <Card className="p-2">
        <div className="px-2 pb-2 pt-1 sm:max-w-xs">
          <Input
            value={search}
            placeholder="Request, consignment, indent or destination"
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => open(r.id)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty="Nothing waiting for a provider."
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
function ProviderSheet({ trId, onBack }: { trId: number; onBack: () => void }) {
  const nav = useNavigate();

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["transport", String(trId)],
    queryFn: () => transportApi.get(trId),
    enabled: trId > 0,
    refetchInterval: 5_000,
  });

  // An award that has gone to the CARRIER_AWARD ladder and is still sitting there.
  // The status is back on QUOTING, but the tender is closed: awarding again would
  // raise a second award against a decision nobody has made yet.
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
              onClick={() => nav(`/logistics/transport/${doc.id}`)}>
              <Truck className="h-4 w-4" /> Open the transport request
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
              Award in approval
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
            on their behalf, is on the transport request.
          </p>
        )}
      </Card>

      <h2 className="mb-2 text-sm font-semibold text-ink">What is being priced</h2>
      <Card className="mb-5 p-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-2">Item</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Packages</th>
                <th className="py-2 text-right">Weight</th>
              </tr>
            </thead>
            <tbody>
              {doc.items.map((line) => (
                <tr key={line.id} className="border-b border-line/50">
                  <td className="py-2">
                    <div className="text-body">{line.item_name ?? "—"}</div>
                    <div className="font-mono text-[11px] text-muted">
                      {line.item_code ?? ""}
                    </div>
                    {line.is_fragile && (
                      <span className="text-[11px] text-amber-600">Fragile</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {Number(line.quantity)} {line.uom_code ?? ""}
                  </td>
                  <td className="py-2 text-right">{line.package_count}</td>
                  <td className="py-2 text-right">
                    {line.weight_kg != null ? `${Number(line.weight_kg)} kg` : "—"}
                  </td>
                </tr>
              ))}
              {doc.items.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-sm text-muted">
                    No lines on this shipment.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* The tender itself. Only a quoted mode has one — a courier booking and a
          hand-over were settled the moment the mode was chosen. */}
      {doc.mode === "THIRD_PARTY" ? (
        <Card className="p-5">
          <CarrierComparison
            trId={doc.id}
            status={doc.status}
            quotes={doc.quotes}
            awardPending={awardPending}
            compact
            // Awarding ends this desk's work: the shipment now has a provider and
            // everything after it — dispatch, the LR, tracking — is the transport
            // request's. Landing there is the next press, not a search for it.
            onAwarded={(id) => nav(`/logistics/transport/${id}`)}
          />
        </Card>
      ) : (
        <Card className="p-6 text-center text-sm text-muted">
          A {modeLabel(doc.mode).toLowerCase()} shipment is not tendered — the provider
          was settled when the mode was chosen. Set or change it on the transport
          request.
        </Card>
      )}
    </div>
  );
}
