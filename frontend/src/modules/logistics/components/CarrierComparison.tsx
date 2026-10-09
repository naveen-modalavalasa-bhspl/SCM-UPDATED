import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Award, Clock, IndianRupee, Trophy } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, Field, Select, StatusPill, useAction,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import { transportApi } from "../api";
import { money } from "./modeCopy";
import type {
  CarrierQuote, ComparisonRow, EvaluationMethod, Recommendation,
} from "../transportTypes";

/**
 * The tender sheet: what every invited carrier quoted, side by side, and the award.
 *
 * Carriers are COLUMNS, not rows. A comparison is read down one attribute at a time —
 * "who is cheapest", "who is quickest", "who charges what on top" — and a row-per-
 * carrier table makes every one of those questions a scan across the screen. The one
 * decision this screen exists for is a comparison between two or three offers, so the
 * offers sit beside each other and the attributes run down the side.
 *
 * The RANKING comes from the backend and is never re-sorted here. That matters: the
 * score stored against the winning quote is the justification for the award, so a
 * screen that ordered the columns itself could show a different winner from the one
 * the award check would accept. Changing the method in the dropdown is a query
 * parameter — looking at the quotes another way is not choosing one, and nothing is
 * written until Award.
 *
 * The recommendation is a recommendation. It names who the numbers point at and what
 * picking them costs against the alternatives; the Award button is live on every
 * submitted quote regardless, because the numbers do not know which carrier lost a
 * pallet last month.
 */
export function CarrierComparison({
  trId, status, quotes, awardPending = false, autoInvite = false, compact = false,
  onAwarded,
}: {
  trId: number;
  status: string;
  quotes: CarrierQuote[];
  /** An award on this request is made and not yet confirmed. The status is still
   *  QUOTING, but the tender is closed: inviting or awarding again would raise a
   *  second award against a decision nobody has made yet. */
  awardPending?: boolean;
  /** The caller arrived on a press that said "invite" — open the partner picker at
   *  once instead of making the reader find it. FIX 2026-09-10. */
  autoInvite?: boolean;
  /** Drop the card chrome — the host screen supplies its own heading. */
  compact?: boolean;
  /** Where the award goes next. Provider Selection sends it on to the shipment: once
   *  a carrier is fixed the work is dispatch and tracking, and leaving the desk on a
   *  comparison sheet it can no longer act on is a dead end. The shipment screen has
   *  no next hop, so it passes nothing and stays put. */
  onAwarded?: (trId: number) => void;
}) {
  const { can } = useAuth();
  const [method, setMethod] = useState("");
  // FIX 2026-09-10: opens with the picker already up when the press that got here said
  // "invite". Only for a login that may actually award — the backend refuses the rest,
  // and a form nobody can submit is worse than no form.
  const mayAward = can("transport.award");
  const [inviting, setInviting] = useState(autoInvite && mayAward);
  const [chosen, setChosen] = useState<number[]>([]);

  const { data: methods } = useQuery({
    queryKey: ["transport-eval-methods"],
    queryFn: transportApi.evaluationMethods,
  });
  const { data: carriers } = useQuery({
    queryKey: ["transport-carriers"],
    queryFn: () => transportApi.carriers(),
  });
  const { data: comparison, error } = useQuery({
    queryKey: ["transport-comparison", trId, method],
    queryFn: () => transportApi.comparison(trId, method || undefined),
    enabled: quotes.length > 0,
    refetchInterval: 5_000,
  });

  const invalidates = [["transport", String(trId)], ["transport-comparison", trId],
    ["transport-provider-board"], ["transport-summary"]];

  const invite = useAction({
    run: () => transportApi.invite(trId, chosen, method || undefined),
    success: "Carriers invited to quote",
    invalidates,
    onDone: () => { setInviting(false); setChosen([]); },
  });
  const award = useAction({
    run: (quoteId: number) => transportApi.award(trId, quoteId),
    // Awarded, NOT yet offered: the shipment lands on the Provider accepts rung and
    // waits there to be confirmed. Saying "waiting for the carrier" here told the desk
    // the ball was in somebody else's court while the only press left was its own.
    success: "Awarded — confirm it on the shipment to send it to the provider",
    invalidates,
    onDone: () => onAwarded?.(trId),
  });

  const canTender = status === "QUOTING" && !awardPending;
  const rows = comparison?.rows ?? [];
  const rec = comparison?.recommendation ?? null;
  const methodLabel = methods?.find(
    (m) => m.value === (method || comparison?.evaluation_method))?.label
    ?? (comparison?.evaluation_method ?? "").replace(/_/g, " ").toLowerCase();

  const body = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">
            Quotations comparison
          </h2>
          <p className="text-xs text-muted">
            {comparison
              ? `${comparison.responded} of ${comparison.invited} invited partners have quoted`
              : "No partners invited yet"}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-56">
            <Select
              value={method || comparison?.evaluation_method || ""}
              placeholder="Rank by…"
              options={(methods ?? []).map((m: EvaluationMethod) => ({
                value: m.value, label: m.label,
              }))}
              onChange={setMethod}
              ariaLabel="Rank the quotes by"
            />
          </div>
          {canTender && (
            <Can do="transport.award">
              <Button variant="ghost" onClick={() => setInviting(true)}>
                Invite more
              </Button>
            </Can>
          )}
        </div>
      </div>

      <ErrorBanner error={error ?? invite.error ?? award.error} />

      {rec && <RecommendationBanner rec={rec} methodLabel={methodLabel} />}

      {comparison && !comparison.meets_three_quote_norm && comparison.responded > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          Only {comparison.responded} quote{comparison.responded === 1 ? "" : "s"} on
          file. The standard is three — award anyway if this is a single-carrier lane.
        </p>
      )}

      {/* FIX 2026-09-10: the empty state carries the press. "Invite the partners who
          should price this shipment" named the next step and then left the reader to
          hunt for a ghost button in the header — which is how "Invite carriers & award"
          on the shipment landed on what looked like a blank page. A login that cannot
          award is told who does it instead of being shown a dead button. */}
      {rows.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-muted">
            {quotes.length === 0
              ? "No partner has been asked to price this shipment yet."
              : "Nobody has sent a price yet."}
          </p>
          {quotes.length === 0 && canTender && !inviting && (
            mayAward ? (
              <Button className="mt-3" onClick={() => setInviting(true)}>
                Invite carriers to quote
              </Button>
            ) : (
              <p className="mt-2 text-xs text-muted">
                Inviting partners is the provider desk's press — ask whoever holds
                logistics award rights to send the price request.
              </p>
            )
          )}
        </div>
      ) : (
        <>
          <QuoteMatrix
            rows={rows}
            awardedQuoteId={comparison?.awarded_quote_id ?? null}
            canAward={canTender}
            busy={award.isPending}
            onAward={(quoteId) => award.mutate(quoteId)}
          />
          <QuoteCards
            rows={rows}
            awardedQuoteId={comparison?.awarded_quote_id ?? null}
            canAward={canTender}
            busy={award.isPending}
            onAward={(quoteId) => award.mutate(quoteId)}
          />
        </>
      )}

      {inviting && (
        <div className="rounded-lg border border-line p-4">
          <Field label="Partners to invite" required>
            <Select
              value=""
              placeholder="Add a partner"
              options={(carriers ?? [])
                .filter((c) => !chosen.includes(c.id)
                  && !quotes.some((q) => q.carrier_id === c.id))
                .map((c) => ({ value: c.id, label: c.name }))}
              onChange={(value) => setChosen([...chosen, Number(value)])}
              ariaLabel="Partner to invite"
            />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            {chosen.map((carrierId) => (
              <span
                key={carrierId}
                className="rounded-full bg-content2 px-2.5 py-1 text-xs text-body"
              >
                {carriers?.find((c) => c.id === carrierId)?.name ?? carrierId}
                <button
                  className="ml-1.5 text-muted"
                  onClick={() => setChosen(chosen.filter((c) => c !== carrierId))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" onClick={() => { setInviting(false); setChosen([]); }}>
              Cancel
            </Button>
            <Button
              onClick={() => invite.mutate()}
              disabled={!chosen.length || invite.isPending}
            >
              Invite {chosen.length || ""}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  return compact ? body : <Card className="p-5">{body}</Card>;
}

/* -------------------------------------------------------------------------- */
/*  The recommendation                                                         */
/* -------------------------------------------------------------------------- */

/** What the recommendation means, in a sentence a buyer would say out loud.
 *
 * Composed here rather than served: the backend supplies the facts (who won, what it
 * saves, how many days it gives away) and the money format lives beside the rest of
 * this module's presentation. What it must never do is sound like a decision — the
 * award is a press somebody still has to make.
 */
function recommendationText(rec: Recommendation, methodLabel: string): string[] {
  const name = rec.carrier_name ?? "This partner";
  const lines: string[] = [];

  if (rec.is_cheapest && rec.is_fastest) {
    lines.push(`${name} is both the cheapest and the quickest — there is nothing to trade off here.`);
  } else if (rec.is_cheapest) {
    lines.push(`${name} is the cheapest on the sheet at ${money(rec.landed_cost)}.`);
  } else if (rec.is_fastest) {
    lines.push(`${name} is the quickest at ${rec.transit_days} day${rec.transit_days === 1 ? "" : "s"}.`);
  } else {
    lines.push(`${name} scores best under ${methodLabel}.`);
  }

  if (rec.saving != null && rec.saving > 0 && rec.runner_up) {
    lines.push(`${money(rec.saving)} less than ${rec.runner_up.carrier_name ?? "the next quote"}.`);
  } else if (rec.saving != null && rec.saving < 0 && rec.cheapest) {
    // Ranked by speed, the winner can be the dearest quote. Saying so is the point —
    // a premium presented as a saving is a comparison sheet that argues with itself.
    lines.push(`${money(-rec.saving)} more than ${rec.cheapest.carrier_name ?? "the cheapest quote"}.`);
  }
  if (rec.days_slower != null && rec.days_slower > 0 && rec.fastest) {
    lines.push(`${rec.days_slower} day${rec.days_slower === 1 ? "" : "s"} slower than ${rec.fastest.carrier_name ?? "the quickest"}, who quoted ${money(rec.fastest.landed_cost)}.`);
  }
  if (rec.is_trade_off && !(rec.is_cheapest && rec.is_fastest)) {
    lines.push("Cheapest and quickest are different partners — the call is yours.");
  }
  return lines;
}

function RecommendationBanner({ rec, methodLabel }: {
  rec: Recommendation; methodLabel: string;
}) {
  return (
    <div className="rounded-lg border border-emerald-300/60 bg-emerald-50 px-4 py-3 dark:border-emerald-700/40 dark:bg-emerald-900/15">
      <div className="flex items-start gap-3">
        <Trophy className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
              Recommended: {rec.carrier_name ?? `Carrier ${rec.carrier_id}`}
            </span>
            <span className="text-xs text-emerald-700/80 dark:text-emerald-300/80">
              {money(rec.landed_cost)}
              {rec.transit_days != null && ` · ${rec.transit_days} day${rec.transit_days === 1 ? "" : "s"}`}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-emerald-900/80 dark:text-emerald-100/80">
            {recommendationText(rec, methodLabel).join(" ")}
          </p>
          <p className="mt-1 text-[11px] text-emerald-700/70 dark:text-emerald-300/70">
            A suggestion, not a decision — award whichever partner you judge right.
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The sheet                                                                  */
/* -------------------------------------------------------------------------- */

/** One badge — "Best price", "Fastest", "Recommended". */
function Chip({ tone, icon, children }: {
  tone: "money" | "time" | "win"; icon: ReactNode; children: ReactNode;
}) {
  const tint = {
    money: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    time: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
    win: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tint}`}>
      {icon}{children}
    </span>
  );
}

interface SheetProps {
  rows: ComparisonRow[];
  awardedQuoteId: number | null;
  canAward: boolean;
  busy: boolean;
  onAward: (quoteId: number) => void;
}

/** Desktop: attributes down the side, one column per partner. */
function QuoteMatrix({ rows, awardedQuoteId, canAward, busy, onAward }: SheetProps) {
  const colTint = (row: ComparisonRow) =>
    row.quote_id === awardedQuoteId
      ? "bg-amber-50/70 dark:bg-amber-900/15"
      : row.is_recommended
        ? "bg-emerald-50/60 dark:bg-emerald-900/10"
        : "";

  return (
    <div className="hidden overflow-x-auto rounded-lg border border-line md:block">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line bg-content2/60">
            <th className="w-44 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted">
              Quotation
            </th>
            {rows.map((row) => (
              <th key={row.quote_id}
                className={`px-4 py-3 text-left align-top ${colTint(row)}`}>
                <div className="space-y-1.5">
                  <div className="font-display text-sm font-semibold text-ink">
                    {row.carrier_name ?? `Carrier ${row.carrier_id}`}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill status={row.status} />
                    {row.is_recommended && (
                      <Chip tone="win" icon={<Trophy className="h-3 w-3" />}>
                        Recommended
                      </Chip>
                    )}
                  </div>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <Row label="Rank" rows={rows} tint={colTint}
            cell={(r) => <span className="font-semibold text-ink">#{r.rank}</span>} />
          <Row label="Freight" rows={rows} tint={colTint}
            cell={(r) => money(r.freight_amount)} />
          <Row label="Other charges" rows={rows} tint={colTint}
            cell={(r) => money(r.other_charges)} />
          <Row label="Tax" rows={rows} tint={colTint}
            cell={(r) => `${Number(r.tax_percent ?? 0)}%`} />
          {/* The one number the award is actually made on: price plus everything on
              top of it. Emphasised for that reason, and badged where it is lowest. */}
          <Row label="Landed cost" strong rows={rows} tint={colTint} cell={(r) => (
            <div className="space-y-1">
              <div className="font-display text-base font-bold text-ink">
                {money(r.landed_cost)}
              </div>
              {r.is_cheapest && (
                <Chip tone="money" icon={<IndianRupee className="h-3 w-3" />}>
                  Best price
                </Chip>
              )}
            </div>
          )} />
          <Row label="Delivery" rows={rows} tint={colTint} cell={(r) => (
            <div className="space-y-1">
              <div className="text-body">
                {r.transit_days != null
                  ? `${r.transit_days} day${r.transit_days === 1 ? "" : "s"}`
                  : "Not stated"}
              </div>
              {r.is_fastest && (
                <Chip tone="time" icon={<Clock className="h-3 w-3" />}>Fastest</Chip>
              )}
            </div>
          )} />
          <Row label="Vehicle" rows={rows} tint={colTint}
            cell={(r) => r.vehicle_type ?? "—"} />
          <Row label="Quote valid till" rows={rows} tint={colTint}
            cell={(r) => (r.valid_until ? fmtDate(r.valid_until) : "—")} />
          <Row label="Score" rows={rows} tint={colTint}
            cell={(r) => r.score.toFixed(2)} />
          <Row label="Remarks" rows={rows} tint={colTint} cell={(r) => (
            <span className="text-xs text-muted">{r.remarks || "—"}</span>
          )} />
          <tr>
            <td className="border-t border-line px-4 py-3" />
            {rows.map((row) => (
              <td key={row.quote_id}
                className={`border-t border-line px-4 py-3 ${colTint(row)}`}>
                <AwardCell row={row} awardedQuoteId={awardedQuoteId}
                  canAward={canAward} busy={busy} onAward={onAward} />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Row({ label, rows, cell, tint, strong = false }: {
  label: string;
  rows: ComparisonRow[];
  cell: (row: ComparisonRow) => ReactNode;
  tint: (row: ComparisonRow) => string;
  strong?: boolean;
}) {
  return (
    <tr className={`border-t border-line/60 ${strong ? "bg-content2/30" : ""}`}>
      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted">{label}</th>
      {rows.map((row) => (
        <td key={row.quote_id} className={`px-4 py-2.5 align-top ${tint(row)}`}>
          {cell(row)}
        </td>
      ))}
    </tr>
  );
}

function AwardCell({ row, awardedQuoteId, canAward, busy, onAward }: {
  row: ComparisonRow; awardedQuoteId: number | null; canAward: boolean;
  busy: boolean; onAward: (quoteId: number) => void;
}) {
  if (row.quote_id === awardedQuoteId) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
        <Award className="h-4 w-4" /> Awarded
      </span>
    );
  }
  if (!canAward || row.status !== "SUBMITTED") {
    return <span className="text-xs text-muted">—</span>;
  }
  return (
    <Can do="transport.award">
      <Button variant={row.is_recommended ? "primary" : "subtle"} disabled={busy}
        onClick={() => onAward(row.quote_id)}>
        Award
      </Button>
    </Can>
  );
}

/** Under 768px the matrix stops being readable, so each partner becomes a card and
 *  the attributes are read down inside it. Same data, same order, same badges. */
function QuoteCards({ rows, awardedQuoteId, canAward, busy, onAward }: SheetProps) {
  return (
    <div className="space-y-3 md:hidden">
      {rows.map((row) => (
        <div key={row.quote_id}
          className={`rounded-lg border p-4 ${
            row.quote_id === awardedQuoteId
              ? "border-amber-300 bg-amber-50/70 dark:border-amber-700/50 dark:bg-amber-900/15"
              : row.is_recommended
                ? "border-emerald-300 bg-emerald-50/60 dark:border-emerald-700/40 dark:bg-emerald-900/10"
                : "border-line"
          }`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-display text-sm font-semibold text-ink">
                #{row.rank} {row.carrier_name ?? `Carrier ${row.carrier_id}`}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <StatusPill status={row.status} />
                {row.is_recommended && (
                  <Chip tone="win" icon={<Trophy className="h-3 w-3" />}>Recommended</Chip>
                )}
                {row.is_cheapest && (
                  <Chip tone="money" icon={<IndianRupee className="h-3 w-3" />}>Best price</Chip>
                )}
                {row.is_fastest && (
                  <Chip tone="time" icon={<Clock className="h-3 w-3" />}>Fastest</Chip>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="font-display text-base font-bold text-ink">
                {money(row.landed_cost)}
              </div>
              <div className="text-[11px] text-muted">
                {row.transit_days != null
                  ? `${row.transit_days} day${row.transit_days === 1 ? "" : "s"}`
                  : "Days not stated"}
              </div>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted">Freight</dt>
            <dd className="text-right text-body">{money(row.freight_amount)}</dd>
            <dt className="text-muted">Other charges</dt>
            <dd className="text-right text-body">{money(row.other_charges)}</dd>
            <dt className="text-muted">Tax</dt>
            <dd className="text-right text-body">{Number(row.tax_percent ?? 0)}%</dd>
            <dt className="text-muted">Vehicle</dt>
            <dd className="text-right text-body">{row.vehicle_type ?? "—"}</dd>
            <dt className="text-muted">Score</dt>
            <dd className="text-right text-body">{row.score.toFixed(2)}</dd>
          </dl>
          <div className="mt-3">
            <AwardCell row={row} awardedQuoteId={awardedQuoteId} canAward={canAward}
              busy={busy} onAward={onAward} />
          </div>
        </div>
      ))}
    </div>
  );
}
