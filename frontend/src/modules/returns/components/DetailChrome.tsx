import type { ReactNode } from "react";
import { Card } from "@/shared/components";

/**
 * The chrome the return's detail screen is built out of — one card head, one fact, one
 * chip, defined once.
 *
 * Not a second design system: every one of these is a composition of `@/shared/components`
 * and the design tokens in `index.css`, and none of them restyles a shared primitive
 * (CLAUDE.md, "Frontend module pattern"). They exist because the detail screen carries
 * fourteen panels — the decision, the sign-off, the certificate, the trail, the paper
 * trail, the lines, the logistics leg — and each one had drawn its own heading, its own
 * padding and its own label typography. Fourteen slightly different cards read as an
 * unfinished screen however good each one is on its own.
 *
 * Wording never lives here. Every string is passed in by the panel that owns it.
 */

type CardTone = "plain" | "action" | "warn" | "bad";

const ICON_TILE: Record<CardTone, string> = {
  plain: "bg-content2 text-muted",
  action: "bg-brand/10 text-brand",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
};

const ACCENT: Record<CardTone, string> = {
  plain: "",
  // `bg-brand` is painted with the Bavya sweep (see the `.bg-brand` rule in index.css),
  // so the hairline over a card that wants something FROM the reader is the mark itself.
  action: "bg-brand",
  warn: "bg-warn",
  bad: "bg-bad",
};

/**
 * A panel: a titled head over a body, with an optional icon tile and an optional aside
 * (a count, a pill, a link) pinned to the right of the title.
 *
 * `tone` says whether the panel is something to READ or something to DO. A reference
 * panel takes the quiet uppercase head every list on the screen uses; a panel holding a
 * press takes a display-weight title and a hairline of the brand across its top edge, so
 * the one thing on a long document that is waiting for this reader is findable by
 * scrolling past it rather than by reading it.
 */
export function SectionCard({
  title,
  subtitle,
  icon,
  aside,
  tone = "plain",
  className = "",
  bodyClassName = "p-5",
  children,
}: {
  title: string;
  subtitle?: string | null;
  icon?: ReactNode;
  aside?: ReactNode;
  tone?: CardTone;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const quiet = tone === "plain";
  return (
    <Card className={`overflow-hidden ${className}`}>
      {!quiet && <div className={`h-[3px] w-full ${ACCENT[tone]}`} aria-hidden="true" />}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line/70 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && (
            <span
              aria-hidden="true"
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ICON_TILE[tone]}`}
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2
              className={
                quiet
                  ? "text-sm font-semibold uppercase tracking-wider text-ink"
                  : "font-display text-base font-bold leading-tight text-ink"
              }
            >
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </Card>
  );
}

/**
 * One label over one value. `dt`/`dd`, so a grid of these is a real definition list and a
 * screen reader reads the pair rather than two loose strings.
 *
 * The label stays 10px uppercase — the size it already was on this screen — because the
 * value is the thing being read and the label only says which field it is.
 */
export function Fact({
  label,
  value,
  icon,
  tone = "text-ink",
  note,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: string;
  note?: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      {icon && (
        <span aria-hidden="true" className="mt-[3px] shrink-0 text-muted">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          {label}
        </dt>
        <dd
          className={`mt-0.5 break-words text-sm font-medium leading-snug ${tone} ${
            mono ? "mono" : ""
          }`}
        >
          {value}
        </dd>
        {note && <p className="mt-0.5 break-words text-xs text-muted">{note}</p>}
      </div>
    </div>
  );
}

/**
 * A headline fact on the document band: the two or three numbers somebody opening a
 * return looks for before they read anything — what it is, what it is worth, what request
 * it answers.
 *
 * Bordered rather than filled: the band already sits on a white card, and a row of tinted
 * tiles across the top of a document competes with the status pill beside them, which is
 * the one colour on the screen that has to be read.
 */
export function MetaChip({
  label,
  value,
  icon,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-line bg-content2/50 px-3 py-2">
      {icon && (
        <span aria-hidden="true" className="shrink-0 text-muted">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <div className="text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">
          {label}
        </div>
        <div
          className={`truncate text-[13px] font-semibold leading-tight text-ink ${
            mono ? "mono" : "tabular"
          }`}
          title={typeof value === "string" ? value : undefined}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

/**
 * Where the material leaves from and where it is going, as one movement rather than as
 * two unrelated rows of a list.
 *
 * A return is a journey between two places, and the two warehouse strings this system
 * carries are long enough ("AP-104-MMU-Chilamathur -phc-AP39TL9499 - LIP") that reading
 * them off separate rows of a definition list left the reader working out which end was
 * which. An arrow between them says it without a word being added.
 *
 * `to` is optional and its absence is meaningful: after any outcome but "send it to a
 * point" nothing travelled, and the caller passes nothing rather than the point the
 * return was merely addressed to.
 */
export function RouteRibbon({
  fromLabel,
  from,
  toLabel,
  to,
}: {
  fromLabel: string;
  from: ReactNode;
  toLabel: string;
  to?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-content2/50 p-3 sm:flex-row sm:items-stretch">
      <div className="min-w-0 flex-1">
        <div className="text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">
          {fromLabel}
        </div>
        <div className="mt-0.5 break-words text-[13px] font-semibold leading-snug text-ink">
          {from}
        </div>
      </div>
      {to && (
        <>
          {/* The connector. A rotated chevron on a phone, where the two ends stack, and a
            * horizontal one from `sm` up — the arrow has to point the way the layout runs
            * or it argues with it. */}
          <div
            aria-hidden="true"
            className="flex items-center justify-center sm:w-8 sm:shrink-0"
          >
            <span className="h-px w-8 bg-line sm:hidden" />
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4 rotate-90 text-brand sm:rotate-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <span className="h-px w-8 bg-line sm:hidden" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">
              {toLabel}
            </div>
            <div className="mt-0.5 break-words text-[13px] font-semibold leading-snug text-ink">
              {to}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The person a document is attributed to, with their initials standing in for a photo. */
export function PersonBadge({
  name,
  meta,
}: {
  name: string;
  meta?: string | null;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand/10 text-[11px] font-bold text-brand"
      >
        {initials || "—"}
      </span>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-ink">{name}</div>
        {meta && <div className="mono truncate text-xs text-muted">{meta}</div>}
      </div>
    </div>
  );
}
