import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Building2, Briefcase, CheckCircle2, ChevronRight, Clock, History, MapPin,
  MinusCircle, PackageCheck, RotateCcw, UserRound, XCircle,
} from "lucide-react";
import { Card, StatusPill } from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import type { DecisionLedger, DecisionLedgerItem } from "../types";

/**
 * The parts a decision ledger is drawn from, in one place because there are TWO
 * ledgers now and a colour or a word that means one thing on one of them and
 * something else on the other is worse than either.
 *
 * A regular indent is one decision on one document, and `DecisionLedgerPage` reads
 * top-down in the order a person asks the questions. A MONTHLY indent is not one
 * document to the approver who signed it — the Consolidation screen takes a whole
 * month in a single press — so `MonthlyCycleLedger` reads as the cycle. Both wear
 * the same outcome colours, the same chips and the same quantity rail, so arriving
 * on either from a green row in My Decisions lands on a green page.
 */

export const qty = (value?: number | null) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "Unavailable"
    : String(Number(value.toFixed(3)));

/** Quantities, the way every ledger row prints them: grouped, at most three
 *  decimals, and an em dash where there is no number at all. */
export const num = (value?: number | null) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—" : Number(value.toFixed(3)).toLocaleString("en-IN");

export const itemLabel = (line: { item_name?: string | null; item_code?: string | null; line_id?: number }) =>
  line.item_name ?? line.item_code ?? `Line #${line.line_id ?? "?"}`;

export interface Tone {
  label: string;
  icon: LucideIcon;
  /** Fill + text for a chip or an icon tile. */
  className: string;
  /**
   * The rail down the edge of a card, and the strip across the top of a hero:
   * the outcome at FULL strength.
   *
   * It was briefly a lighter tint, on the argument that a rail carries no fact of
   * its own -- the card states its outcome in a chip, in words, an inch to the
   * right -- so eleven saturated rails down a register read as eleven alarms. The
   * screen disagreed. Pale strips read as sugary and as though the page had not
   * finished loading, and the real complaint about eleven alarms was about how
   * WIDE they were, not how saturated. So the rails are the full colour and the
   * geometry went back to what it was: 1px down a card, 1.5px across a hero.
   *
   * `--color-*-rail` survives as a named role rather than call sites reaching for
   * `bg-ok` directly. It is one line in `index.css` and it is where a rail would
   * be made to differ from a chip's fill if one ever had to.
   */
  bar: string;
  /** The bare token at full strength, for a dot or a ring — anything small enough
   *  that lightening it would make it disappear rather than soften it. */
  solid: string;
}

const decisionTone: Record<string, Tone> = {
  WAITING: {
    label: "Waiting", icon: Clock,
    className: "bg-info-bg text-info", bar: "bg-info-rail", solid: "bg-info",
  },
  APPROVED: {
    label: "Approved", icon: CheckCircle2,
    className: "bg-ok-bg text-ok", bar: "bg-ok-rail", solid: "bg-ok",
  },
  PARTIALLY_APPROVED: {
    label: "Partially approved", icon: MinusCircle,
    className: "bg-warn-bg text-warn", bar: "bg-warn-rail", solid: "bg-warn",
  },
  DENIED: {
    label: "Denied", icon: XCircle,
    className: "bg-bad-bg text-bad", bar: "bg-bad-rail", solid: "bg-bad",
  },
  // Its OWN colour, not the amber it used to share with PARTIALLY_APPROVED. Those
  // are the two outcomes an approver most needs to tell apart at a glance — one
  // moved the document on with less on it, the other sent it back — and on a
  // register of eleven rows they were the same fill. The violet is the token
  // `index.css` already carries for exactly this ("a third decision outcome that is
  // neither good nor bad"), picked against the reject red with the dataviz
  // validator rather than by eye. It has a real `-bg` tint of its own now, set and
  // measured alongside the other four rather than mixed live at 12% opacity, which
  // was a colour nothing could check because nothing else used it.
  RETURNED: {
    label: "Returned", icon: RotateCcw,
    className: "bg-chart-returned-bg text-chart-returned",
    bar: "bg-chart-returned-rail", solid: "bg-chart-returned",
  },
};

export function toneFor(value: string): Tone {
  return decisionTone[value] ?? {
    label: value.replace(/_/g, " "), icon: History,
    className: "bg-neutral-bg text-neutral", bar: "bg-neutral-rail", solid: "bg-neutral",
  };
}

export function DecisionChip({ value, className = "" }: { value: string; className?: string }) {
  const meta = toneFor(value);
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${meta.className} ${className}`}>
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  );
}

/** The three-track grid the quantity column is built on: what reached you, the
 *  arrow, what you gave. The middle track is a FIXED 1rem in the heading and in
 *  every row, which is what makes the arrows form a line — an `auto` track would
 *  size to its own content and the heading's arrow is not the same glyph size as
 *  the rows'. Exported so a heading can wear the identical grid. */
export const QTY_GRID = "grid-cols-[1fr_1rem_1fr] gap-x-1";

/** `reached you -> approved`, the one figure every row on both ledgers leads with.
 *  Written ONCE because it was written three times and the three disagreed about
 *  what an undecided line looks like: a dash, a blank, and the word "pending". An
 *  approver scanning a register has to be able to tell "I gave them nothing" from
 *  "I have not answered yet", and only one of those three said it.
 *
 *  Colour is on the SECOND number alone. Both numbers tinted makes the row look
 *  like a change even where nothing changed, which is the common case.
 *
 *  `aligned` is for a COLUMN of these. Right-aligning the whole string put the two
 *  numbers wherever their own widths left them, so `10 -> 0` sat a character to the
 *  left of `10 -> 10` above it and a column of identical decisions read as ragged
 *  noise. Aligned, the left number ends at the arrow, the arrow holds one fixed
 *  track, and the right number starts after it — three columns, all three lining
 *  up down the list. It is opt-in because the same component also sits INLINE in a
 *  flowing row, where equal-width tracks would leave a gap after `40 -> pending`
 *  wide enough to read as a missing value. */
export function QtyArrow({ requested, approved, uom, aligned = false, className = "" }: {
  requested: number;
  approved?: number | null;
  uom?: string | null;
  aligned?: boolean;
  className?: string;
}) {
  const decided = approved !== null && approved !== undefined;
  const cut = decided && approved! < requested;
  const tone = !decided ? "font-semibold text-info" : cut ? "text-bad" : "text-ok";
  const unit = uom
    ? <span className="ml-1 text-xs font-medium text-muted">{uom}</span> : null;
  if (!aligned) {
    return (
      <span className={`tabular whitespace-nowrap font-bold text-ink ${className}`}>
        {num(requested)}
        <span className="mx-1 font-normal text-muted">&rarr;</span>
        <span className={tone}>{decided ? num(approved) : "pending"}</span>
        {unit}
      </span>
    );
  }
  return (
    <span className={`tabular grid items-baseline whitespace-nowrap font-bold text-ink ${QTY_GRID} ${className}`}>
      <span className="text-right">{num(requested)}</span>
      <span className="text-center font-normal text-muted" aria-hidden="true">&rarr;</span>
      <span className={`text-left ${tone}`}>
        {decided ? num(approved) : "pending"}{unit}
      </span>
    </span>
  );
}

/** The heading every panel on either ledger wears, so the eye can find the next one. */
export function SectionHead({ icon: Icon, title, right, subtitle }: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex min-w-0 items-center gap-2 font-display text-base font-bold text-ink">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-050 text-brand">
            <Icon className="h-4 w-4" />
          </span>
          {title}
        </h2>
        {subtitle && <p className="mt-1 pl-10 text-xs text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function DeltaLabel({ item }: { item: DecisionLedgerItem }) {
  const approved = item.approved_by_approver_quantity;
  if (approved === null || approved === undefined) {
    return <span className="text-muted">Decision quantity not recorded</span>;
  }
  const diff = approved - item.received_by_approver_quantity;
  const verb = diff < 0 ? "Reduced by" : diff > 0 ? "Increased by" : "No change";
  return (
    <span>
      Requested {qty(item.received_by_approver_quantity)} -&gt; Approved {qty(approved)}
      <span className="mx-1 text-muted">.</span>
      <span className={diff < 0 ? "text-bad" : diff > 0 ? "text-ok" : "text-muted"}>
        {verb}{diff === 0 ? "" : ` ${qty(Math.abs(diff))}`}
      </span>
    </span>
  );
}

/** One fact from the indent's header, as a chip. The four used to run together in
 *  one dash-separated line that read as a single unparseable string. */
export function MetaChips({ data }: { data: DecisionLedger }) {
  const chips: Array<{ icon: LucideIcon; text: string }> = [
    { icon: UserRound, text: data.indent.requester ?? "Requester unavailable" },
    ...(data.indent.department_name ? [{ icon: Building2, text: data.indent.department_name }] : []),
    ...(data.indent.office_name ? [{ icon: MapPin, text: data.indent.office_name }] : []),
    ...(data.indent.project_name ? [{ icon: Briefcase, text: data.indent.project_name }] : []),
  ];
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {chips.map(({ icon: Icon, text }) => (
        <span
          key={`${text}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-content2 px-2.5 py-1 text-xs font-medium text-body"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="truncate">{text}</span>
        </span>
      ))}
    </div>
  );
}

export function SummaryHeader({ data }: { data: DecisionLedger }) {
  const tone = toneFor(data.decision.decision_label);
  const Icon = tone.icon;
  return (
    <Card className="overflow-hidden">
      {/* The outcome, before a word is read. */}
      <div aria-hidden="true" className={`h-1.5 w-full ${tone.bar}`} />
      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_290px]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="mono rounded-md bg-content2 px-2 py-1 text-sm font-bold text-ink">
              {data.indent.indent_no}
            </span>
            <span className="rounded-md bg-content2 px-2 py-1 text-xs font-semibold text-muted">
              {data.indent.type}
            </span>
            <StatusPill status={data.indent.status} />
          </div>
          <h2 className="font-display text-xl font-bold leading-snug text-ink sm:text-2xl">
            {data.decision.summary}
          </h2>
          <MetaChips data={data} />
          {data.indent.purpose && (
            <p className="mt-3 rounded-lg border-l-2 border-brand/40 bg-content2 px-3 py-2 text-sm italic text-body">
              {data.indent.purpose}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-line bg-content2 p-3">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Your decision
          </p>
          <div className="flex items-center gap-2.5">
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tone.className}`}>
              <Icon className="h-5 w-5" />
            </span>
            <span className="min-w-0 font-display text-[17px] font-bold leading-tight text-ink">
              {tone.label}
            </span>
          </div>
          <dl className="mt-3 divide-y divide-line/70 border-t border-line/70 text-sm">
            <FactRow label="Stage" value={data.decision.stage_name ?? "Unavailable"} />
            <FactRow
              label="When"
              value={data.decision.decided_at ? fmtDateTime(data.decision.decided_at) : "Waiting now"}
            />
            <FactRow label="Current stage" value={data.indent.current_stage_name ?? "Complete"} />
          </dl>
        </div>
      </div>
    </Card>
  );
}

export function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink">{value}</dd>
    </div>
  );
}

/** A strip of labelled numbers. One border around the group, hairlines between —
 *  five filled boxes made the arithmetic look like the point of the row.
 *
 *  The border and fill COLOURS come from the caller, never from a default here that
 *  the caller then overrides: two `border-*` utilities on one element are settled by
 *  stylesheet order, which is not something a call site can see. */
export function StatRail({ stats, className }: {
  stats: Array<{ label: string; value: string; tone?: string }>;
  className: string;
}) {
  return (
    <div className={`flex min-w-0 items-stretch divide-x divide-line rounded-lg border ${className}`}>
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0 flex-1 px-2.5 py-1.5">
          <p className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted">
            {stat.label}
          </p>
          <p className={`tabular mt-0.5 text-sm font-bold ${stat.tone ?? "text-ink"}`}>
            {stat.value}
          </p>
        </div>
      ))}
    </div>
  );
}

export function ItemRow({ item, outcomeLabel }: {
  item: DecisionLedgerItem;
  /** Served. A scoped reader's last column is their OWN stage's number, so calling
   *  it "Final approved" would claim the document ended where they left it. */
  outcomeLabel: string;
}) {
  const hasHistory = item.quantity_history.length > 0;
  const tone = toneFor(item.decision);
  const change = item.change_quantity;
  const changeTone = change == null || change === 0
    ? "text-muted" : change < 0 ? "text-bad" : "text-ok";
  return (
    <div className="flex overflow-hidden rounded-xl border border-line bg-content1">
      <span aria-hidden="true" className={`w-1 shrink-0 ${tone.bar}`} />
      <div className="min-w-0 flex-1 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-ink">{itemLabel(item)}</p>
            <p className="mono text-xs text-muted">
              {item.item_code ?? "No code"}{item.uom_code ? ` - ${item.uom_code}` : ""}
            </p>
          </div>
          <DecisionChip value={item.decision} />
        </div>

        {/* The sentence first. It is the whole row in words, and it is the only part
            of it somebody who has never approved an indent can read at a glance. */}
        <p className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-content2 px-3 py-2 text-sm font-medium text-body">
          <PackageCheck className="h-4 w-4 shrink-0 text-brand" />
          <DeltaLabel item={item} />
        </p>

        <div className="mt-2.5 flex flex-col gap-2 lg:flex-row">
          <StatRail
            className="flex-3 border-line"
            stats={[
              { label: "Originally requested", value: qty(item.requested_quantity) },
              { label: "Received by approver", value: qty(item.received_by_approver_quantity) },
              { label: "Approved by approver", value: qty(item.approved_by_approver_quantity) },
            ]}
          />
          <StatRail
            className="flex-2 border-brand/25 bg-brand-050/40"
            stats={[
              {
                label: "Change",
                value: change == null ? "Unavailable" : qty(change),
                tone: changeTone,
              },
              { label: outcomeLabel, value: qty(item.final_approved_quantity) },
            ]}
          />
        </div>

        {/* No "changed by" line here, deliberately. `changed_by_name`/`changed_at`
            are the LINE's last writer, so a cut made by the OE was read back under
            the DM's name the moment the DM signed it — the row and the audit under
            it disagreed, and the row was the wrong one. Who changed what is stated
            ONCE, per change, in the audit below, where it is stamped with its own
            actor and stage and cannot drift. */}
        {item.reason && (
          <p className="mt-2.5 text-xs text-muted">Reason: {item.reason}</p>
        )}

        {/* Closed by default, always. A disclosure that opens itself onto one line
            saying the detail does not exist is noise on every row that has none. */}
        <details className="group mt-2">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-brand transition-colors hover:bg-brand-050 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            {/* An empty audit means two different things and used to say only one of
                them. A line nobody changed has no rows to show and is not legacy
                data; saying so stops a clean line reading as a broken one. */}
            Quantity audit {hasHistory
              ? `(${item.quantity_history.length})`
              : change === 0 ? "(no change to this line)" : "(legacy detail unavailable)"}
          </summary>
          {hasHistory ? (
            <div className="mt-2 space-y-2">
              {item.quantity_history.map((change2) => (
                <div key={change2.audit_id} className="rounded-lg border border-line bg-content2 p-2 text-sm">
                  <p className="tabular font-medium text-ink">
                    {qty(change2.previous_quantity)} -&gt; {qty(change2.new_quantity)}
                    {change2.reduction > 0 ? ` - Reduced by ${qty(change2.reduction)}` : ""}
                  </p>
                  <p className="text-xs text-muted">
                    {change2.actor_name ?? "Actor unavailable"}
                    {change2.stage_name ? ` - ${change2.stage_name}` : ""}
                    {change2.changed_at ? ` - ${fmtDateTime(change2.changed_at)}` : ""}
                  </p>
                  {change2.reason && <p className="mt-1 text-xs text-body">{change2.reason}</p>}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 px-2 text-sm text-muted">
              This line predates item-level before/after audit capture.
            </p>
          )}
        </details>
      </div>
    </div>
  );
}

/** The indent as it was RAISED: one line, one quantity, and no decision on it.
 *  Every other number on this page is the ladder's arithmetic, and once two or
 *  three approvers have been over a line, "what did they actually ask for" stops
 *  being readable from it. This view answers that one question and nothing else. */
export function RequestedRow({ item }: { item: DecisionLedgerItem }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-content1 p-3">
      <div className="min-w-0">
        <p className="font-semibold text-ink">{itemLabel(item)}</p>
        <p className="mono text-xs text-muted">
          {item.item_code ?? "No code"}{item.uom_code ? ` - ${item.uom_code}` : ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Requested
        </p>
        <p className="tabular text-base font-bold text-ink">
          {qty(item.requested_quantity)}
          {item.uom_code ? <span className="ml-1 text-xs font-medium text-muted">{item.uom_code}</span> : null}
        </p>
      </div>
    </div>
  );
}

/** Two letters, so a name on a waiting list has a face beside it rather than
 *  another line of grey text. */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function PendingNow({ data }: { data: DecisionLedger }) {
  return (
    <Card className="p-4">
      <SectionHead icon={UserRound} title="What is pending now" />
      {data.pending_now.length ? (
        <div className="space-y-2">
          {data.pending_now.map((row) => {
            const name = row.approver_name ?? `Employee #${row.approver_id}`;
            return (
              <div
                key={`${row.approver_id}:${row.stage_sequence}`}
                className="flex items-center gap-2.5 rounded-lg border border-line bg-content2/60 p-2.5"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warn-bg text-xs font-bold text-warn">
                  {initials(name)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{name}</p>
                  <p className="text-xs text-muted">
                    Stage {row.stage_sequence}
                    {row.created_at ? ` - waiting since ${fmtDateTime(row.created_at)}` : ""}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
          Nothing is pending on this indent right now.
        </p>
      )}
    </Card>
  );
}

export function LoadingLedger() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <div className="h-40 animate-pulse rounded-2xl bg-content2" />
        <div className="h-64 animate-pulse rounded-2xl bg-content2" />
      </div>
      <div className="h-48 animate-pulse rounded-2xl bg-content2" />
    </div>
  );
}

/** The view switch. One of N, so it reads as a switch and not as a filter — the
 *  same control My Decisions uses for the indent-type axis. */
export function Segment<T extends string>({
  value, options, onChange, ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: LucideIcon; count?: number }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex w-full flex-wrap gap-1 rounded-full border border-line bg-content2 p-1 sm:w-auto"
    >
      {options.map((option) => {
        const active = value === option.value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm font-semibold transition-colors sm:flex-none ${
              active
                ? "bg-content1 text-ink shadow-sm ring-1 ring-line"
                : "text-muted hover:text-ink"
            }`}
          >
            {Icon && <Icon className="h-4 w-4" />}
            {option.label}
            {option.count !== undefined && (
              <span className={`tabular rounded-full px-1.5 text-xs font-bold ${
                active ? "bg-brand-050 text-brand" : "bg-content1 text-muted"
              }`}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
