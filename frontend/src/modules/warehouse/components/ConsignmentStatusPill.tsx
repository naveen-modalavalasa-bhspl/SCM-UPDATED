/**
 * The consignment's own status vocabulary, in colour.
 *
 * The shared `<StatusPill>` knows the procurement words (SUBMITTED, ORDERED,
 * RECEIVED, QC_PASSED…) and falls back to grey for anything it does not carry, so
 * five of the ten rungs a consignment actually travels — PACKED, DISPATCHED,
 * IN_TRANSIT, DELIVERED, ACKNOWLEDGED — rendered as the same neutral chip as DRAFT.
 * A status column where half the queue is one shade of grey says nothing at a
 * glance, which is the only job a status column has.
 *
 * Kept in the module rather than pushed into `shared/` (rule 4): this is the
 * warehouse's outward-leg vocabulary, composed from the design tokens, not a new
 * primitive. Same reasoning as `IndentStatusBadge` and this module's `FilterBar`.
 *
 * Every chip is a LIGHT tint — a tinted ground with the tone's own text on it. No
 * status gets a solid dark fill, however final it is: a filled chip in a column of
 * tinted ones reads as an alert, and a consignment being signed for is the ordinary
 * happy ending, not something to shout about.
 *
 * The colours track the PHASE of the journey, so the column reads as a progression
 * rather than as ten unrelated labels:
 *
 *   grey  → being written        DRAFT
 *   blue  → ready on the floor   PACKED
 *   amber → waiting on a person  PENDING_APPROVAL
 *   green → cleared              APPROVED
 *   indigo→ handed to a carrier  DISPATCHED
 *   orange→ on the road          IN_TRANSIT
 *   green → arrived / signed     DELIVERED, ACKNOWLEDGED
 *   red   → stopped              REJECTED, CANCELLED (cancelled sits on grey — it was
 *                                withdrawn, not refused by anybody)
 *
 * The three green rungs share a tint on purpose: green means the document is healthy
 * at this point, and which point that is, is what the word says.
 */

/** base classes, dot classes — the dot repeats the tone for anyone who cannot rely
 *  on the fill alone, and gives every chip the same left-hand anchor. */
const TONE: Record<string, [string, string]> = {
  DRAFT: ["bg-neutral-bg text-neutral ring-1 ring-inset ring-neutral/15", "bg-neutral/50"],
  PACKED: ["bg-info-bg text-info ring-1 ring-inset ring-info/20", "bg-info"],
  PENDING_APPROVAL: ["bg-warn-bg text-warn ring-1 ring-inset ring-warn/25", "bg-warn"],
  APPROVED: ["bg-ok-bg text-ok ring-1 ring-inset ring-ok/20", "bg-ok"],
  REJECTED: ["bg-bad-bg text-bad ring-1 ring-inset ring-bad/25", "bg-bad"],
  DISPATCHED: ["bg-brand-050 text-brand ring-1 ring-inset ring-brand/20", "bg-brand"],
  IN_TRANSIT: ["bg-signal/12 text-signal ring-1 ring-inset ring-signal/30", "bg-signal"],
  DELIVERED: ["bg-ok-bg text-ok ring-1 ring-inset ring-ok/20", "bg-ok"],
  ACKNOWLEDGED: ["bg-ok-bg text-ok ring-1 ring-inset ring-ok/30", "bg-ok"],
  CANCELLED: ["bg-neutral-bg text-bad ring-1 ring-inset ring-bad/15", "bg-bad/60"],
};

const FALLBACK: [string, string] = [
  "bg-neutral-bg text-neutral ring-1 ring-inset ring-neutral/15",
  "bg-neutral/50",
];

/** The tone a status carries, exported so a filter row can wear the same dot. */
export function statusTone(status: string) {
  return TONE[(status ?? "").trim().toUpperCase()] ?? FALLBACK;
}

export function ConsignmentStatusPill({ status }: { status: string }) {
  const [base, dot] = statusTone(status);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5
                  text-[11px] font-semibold uppercase tracking-wide ${base}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      {(status ?? "").replace(/_/g, " ")}
    </span>
  );
}
