import { TONES, type Tone } from "./KpiStrip";

/**
 * The signature status vocabulary. Used across every list and detail screen.
 *
 * DRAWN FROM THE OUTCOME TOKENS, not from HeroUI's palette (2026-09-21).
 *
 * It was a HeroUI `<Chip color="success">`, which resolves to `bg-success/20
 * text-success-700` off `hero.ts` — a SECOND, independent palette that nothing
 * measured against the first. So the product shipped two greens, two ambers and
 * two reds for the same five meanings, and they met each other on one screen: the
 * Monthly Cycle Ledger draws a decision chip off `--color-ok` (#167a4b) and the
 * indent's own status pill off HeroUI's success (#30a46c, a full fifteen points
 * lighter in L*) an inch to its right. `KpiStrip.TONES` has carried the comment
 * "these are the same tokens StatusPill uses" since it was written; this is the
 * change that makes that true, and it is why the map is IMPORTED rather than
 * restated here -- one definition, so the KPI tile, the status pill and the
 * ledger's chip cannot drift again.
 *
 * The tokens are also the measured ones: every fill clears 4.5:1 on white and on
 * its own tint (see the long note in `index.css`). HeroUI's flat chip did not --
 * `text-success-700` on `bg-success/20` was never checked against anything.
 *
 * WHAT MOVED, beyond the shade: the four "in flight" statuses (ORDERED,
 * PARTIALLY_ORDERED, SENT_TO_VENDOR, PARTIALLY_RECEIVED) were `primary`, which is
 * the brand crimson #CC004C -- three points of hue from the danger red #e5484d
 * they sat beside. "ORDERED" and "REJECTED" were effectively the same pill at a
 * glance, on the one screen a buyer scans fastest. They are `info` blue now, which
 * is the token this system already uses for "in play, nobody has done anything
 * wrong", and the brand is left to mean the brand.
 */
type Outcome = Extract<Tone, "ok" | "warn" | "bad" | "info" | "neutral">;

const TONE: Record<string, Outcome> = {
  DRAFT: "neutral",
  SUBMITTED: "warn",
  PENDING_APPROVAL: "warn",
  APPROVED: "ok",
  REJECTED: "bad",
  PARTIALLY_ORDERED: "info",
  ORDERED: "info",
  SENT_TO_VENDOR: "info",
  ACCEPTED_BY_SUPPLIER: "ok",
  PARTIALLY_RECEIVED: "info",
  RECEIVED: "ok",
  QC_PASSED: "ok",
  QC_FAILED: "bad",
  ISSUED: "ok",
  CANCELLED: "bad",
  CLOSED: "neutral",
  IN_PROGRESS: "warn",
};

/** The full-strength fill, for `variant="solid"`. Every one of these is L*45, so
 *  white on it clears 4.5:1 -- which the HeroUI solid chip it replaces did not:
 *  white on #30a46c measures 2.9:1. */
const SOLID: Record<Outcome, string> = {
  ok: "bg-ok text-white",
  warn: "bg-warn text-white",
  bad: "bg-bad text-white",
  info: "bg-info text-white",
  neutral: "bg-neutral text-white",
};

/** The word alone, for `variant="light"`. */
const TEXT: Record<Outcome, string> = {
  ok: "text-ok", warn: "text-warn", bad: "text-bad",
  info: "text-info", neutral: "text-neutral",
};

/** The 1px edge, for `variant="bordered"`. */
const BORDERED: Record<Outcome, string> = {
  ok: "border border-ok/45 text-ok",
  warn: "border border-warn/45 text-warn",
  bad: "border border-bad/45 text-bad",
  info: "border border-info/45 text-info",
  neutral: "border border-neutral/45 text-neutral",
};

/**
 * `label` overrides the words WITHOUT touching the status.
 *
 * The supplier portal needs it: our internal "SENT_TO_VENDOR" reads as nonsense on the
 * vendor's own screen — from where they are sitting that order is simply new. The
 * status itself must not be renamed for them, because it is the same document our desk
 * is looking at, so only the wording moves and the tone still comes from the real
 * status.
 *
 * `variant` is kept for the two call sites that pass it. Anything other than the
 * three drawn here falls back to the flat tint, which is the pill this product
 * means by "a status" -- a pill wearing a variant nobody defined is a worse
 * answer than the default one.
 */
export function StatusPill({ status, label, variant = "flat" }: { status: string; label?: string; variant?: "solid" | "bordered" | "light" | "flat" | "faded" | "shadow" | "dot" }) {
  const tone = TONE[status] ?? "neutral";
  const skin = variant === "solid" ? SOLID[tone]
    : variant === "bordered" ? BORDERED[tone]
    : variant === "light" ? TEXT[tone]
    : TONES[tone];
  return (
    <span
      className={`inline-flex h-6 max-w-fit items-center justify-center whitespace-nowrap rounded-full px-2.5 text-[11px] font-semibold uppercase tracking-wide ${skin}`}
    >
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}
