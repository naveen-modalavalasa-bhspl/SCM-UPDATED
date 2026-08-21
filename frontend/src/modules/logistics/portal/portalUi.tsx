import type { ComponentType, ReactNode } from "react";
import { ChevronRight, Inbox } from "lucide-react";

/* ---------------------------------------------------------------------------
 * The partner portal's own presentation kit.
 *
 * Presentation ONLY — no fetching, no rules, no copy that carries a decision. It
 * exists because the carrier screens are not the internal console: the people on
 * them are outside the company, work one shipment at a time on a phone at a loading
 * bay, and never learn a menu. So the portal reads as its own product — a dark
 * identity band, one clear thing to press per card — while every number, permission
 * and route behind it stays exactly what the desk's screens use.
 *
 * Everything here is tokens (`ink`, `brand`, `line`, `muted`) and flexbox. Nothing
 * loads a font, an image or a chart library: the portal has to open on a 3G phone.
 * ------------------------------------------------------------------------- */

/** The four things a carrier's row can be, and how each one is tinted. A state is
 *  the carrier's OWN position on the shipment — waiting to price it, priced it, it
 *  is theirs, they lost it — never the shipment's status, which past the award is
 *  describing somebody else's truck.
 *
 *  Every tone is a LIGHT wash — a tinted pill with the colour carried by the fill,
 *  not by the words. Full-strength `text-signal` orange and `text-ok` green on white
 *  put two shouting lines on every card and made the board read as a screen full of
 *  warnings; on a phone in daylight the loudest thing on a card should be the one
 *  thing to press, not the sentence above it. The dot keeps the saturated colour, so
 *  the state is still tellable at arm's length. */
export type Tone = "wait" | "done" | "mine" | "lost" | "calm";

export const TONE: Record<Tone, { bar: string; chip: string; dot: string }> = {
  wait: { bar: "bg-signal/45", chip: "bg-warn-bg text-warn", dot: "bg-signal" },
  done: { bar: "bg-ok/40", chip: "bg-ok-bg text-ok", dot: "bg-ok" },
  mine: { bar: "bg-brand/45", chip: "bg-brand-050 text-brand", dot: "bg-brand" },
  lost: { bar: "bg-bad/35", chip: "bg-bad-bg text-bad", dot: "bg-bad/70" },
  calm: { bar: "bg-line", chip: "bg-surface text-muted", dot: "bg-muted" },
};

/** The heading every portal screen opens with. One shape, so Shipments and
 *  Acknowledgements do not each invent their own. */
export function PortalHeading(
  { title, subtitle, aside }: { title: string; subtitle: string; aside?: ReactNode },
) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-[26px] font-bold leading-tight text-ink">
          {title}
        </h1>
        <p className="mt-0.5 text-sm text-muted">{subtitle}</p>
      </div>
      {aside}
    </div>
  );
}

/**
 * One queue on the filter rail.
 *
 * A pill with its count on it rather than a KPI tile: five of the six queues are
 * empty on a normal day, and six big zeroes across the top read as a portal with no
 * work in it. The rail keeps the counts and gives the shipments the screen.
 */
export function QueueChip(
  { icon: Icon, label, count, active, onClick }: {
    icon: ComponentType<{ className?: string }>;
    label: string; count: number; active: boolean; onClick: () => void;
  },
) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm transition ${
        active
          ? "border-brand bg-brand text-white shadow-[0_6px_16px_-8px_rgba(62,99,221,0.7)]"
          : "border-line bg-content1 text-muted hover:border-brand/40 hover:text-body"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="font-medium whitespace-nowrap">{label}</span>
      <span
        className={`min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold tabular ${
          active ? "bg-white/20 text-white"
            : count ? "bg-brand-050 text-brand" : "bg-surface text-muted"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

/**
 * The lane, drawn.
 *
 * Where from and where to is the first thing a carrier reads on a card, and as two
 * plain strings with an arrow between them it was indistinguishable from the meta
 * text under it. Two nodes and a dashed run say "this is a journey" at a glance,
 * which is the one picture this portal needs. Both ends truncate: a warehouse name
 * is long and the card must never scroll sideways.
 */
export function Lane({ from, to }: { from: string; to: string }) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-content1 ring-2 ring-brand" />
      <span className="min-w-0 max-w-[42%] truncate text-sm text-muted">{from}</span>
      <span className="h-px w-5 shrink-0 border-t border-dashed border-line sm:w-10" />
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-brand/50" />
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{to}</span>
    </div>
  );
}

/** A fact about the load, in the card's footer strip. */
export function MetaChip(
  { icon: Icon, children, strong = false }: {
    icon?: ComponentType<{ className?: string }>;
    children: ReactNode; strong?: boolean;
  },
) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs ${
        strong ? "bg-ok-bg font-semibold tabular text-ok" : "text-muted"
      }`}
    >
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      {children}
    </span>
  );
}

/** What the carrier is about to open, said as the thing they will do there. The card
 *  navigates either way — this only tells them which press is waiting. */
export function CardAction({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-brand-050 px-2.5 py-1.5 text-xs font-semibold text-brand transition group-hover:bg-brand group-hover:text-white">
      {label}
      <ChevronRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
    </span>
  );
}

/** Cards while the queue loads — the same shape as the real ones, so the page does
 *  not jump when they arrive. */
export function CardSkeleton() {
  return (
    <ul className="space-y-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="h-[132px] animate-pulse rounded-2xl border border-line bg-content1/70"
        />
      ))}
    </ul>
  );
}

/** An empty queue is the normal state of most of them, so it is drawn as a resting
 *  place rather than an error. */
export function EmptyQueue({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-content1/60 px-6 py-12 text-center">
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface">
        <Inbox className="h-5 w-5 text-muted" />
      </span>
      <p className="font-display text-base font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{hint}</p>
    </div>
  );
}
