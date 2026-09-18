import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, Check, ChevronDown } from "lucide-react";
import {
  FILTER_CHEVRON, FILTER_CLEAR, FILTER_PANEL, FILTER_ROW, FILTER_ROW_OFF,
  FILTER_ROW_ON, FILTER_TOGGLE, FILTER_TOGGLE_OFF, FILTER_TOGGLE_ON,
} from "@/shared/components";

/**
 * The date filter on the returns queues: one labelled pill that SAYS which date it
 * bounds and what it is currently bounding it to.
 *
 * It replaces a pair of naked `<input type="date">` boxes (2026-09-08). Those worked,
 * and nobody could tell what they were for: two `dd-mm-yyyy` placeholders with a "to"
 * between them name neither the field they filter nor the range they are holding, and
 * the answer a desk actually wants — today's, this week's, the ones that have been
 * sitting a while — took two calendar pickers and eight clicks to express.
 *
 * So the presets are the control and the calendars are the fallback underneath them.
 * Both write the same two values, `from` and `to` as `YYYY-MM-DD`, which are the only
 * state: the pill works out which preset is showing by comparing against them rather
 * than remembering a mode of its own, so a range typed by hand, a preset and a range
 * restored from anywhere else all read back the same way and cannot disagree.
 *
 * Dressed entirely in `filterChrome` — the same capsule, tint, panel and rows as every
 * other filter in the app. Nothing here styles a primitive of its own (rule 12).
 */

/** A local calendar day as `YYYY-MM-DD`. Never `toISOString`, which converts to UTC
 *  first and hands back yesterday for anything before 05:30 in IST. */
const iso = (day: Date) =>
  `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(
    day.getDate(),
  ).padStart(2, "0")}`;

const daysAgo = (count: number) => {
  const day = new Date();
  day.setDate(day.getDate() - count);
  return day;
};

const startOfMonth = () => {
  const day = new Date();
  day.setDate(1);
  return day;
};

export interface RaisedRange {
  from: string;
  to: string;
}

/**
 * The answers worth one click.
 *
 * The last two are the desk's own question rather than a calendar's — "what has been
 * waiting on me for a while" — and they are expressible in the same two bounds, so they
 * cost the server nothing extra: everything raised on or before that day, with no lower
 * bound at all.
 */
const PRESETS: { key: string; label: string; hint?: string; range: () => RaisedRange }[] = [
  { key: "today", label: "Today", range: () => ({ from: iso(new Date()), to: iso(new Date()) }) },
  { key: "7", label: "Last 7 days", range: () => ({ from: iso(daysAgo(6)), to: iso(new Date()) }) },
  { key: "30", label: "Last 30 days", range: () => ({ from: iso(daysAgo(29)), to: iso(new Date()) }) },
  { key: "month", label: "This month", range: () => ({ from: iso(startOfMonth()), to: iso(new Date()) }) },
  {
    key: "aged3",
    label: "Waiting 3 days or more",
    hint: "raised on or before",
    range: () => ({ from: "", to: iso(daysAgo(3)) }),
  },
  {
    key: "aged7",
    label: "Waiting a week or more",
    hint: "raised on or before",
    range: () => ({ from: "", to: iso(daysAgo(7)) }),
  },
];

const dayFormatter = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" });

/** `2026-09-08` as `08 Sep`, parsed as a local day — a bare date string is UTC midnight
 *  to `new Date`, which prints the day before it in any negative offset. */
const shortDay = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return dayFormatter.format(new Date(year, month - 1, day));
};

export function RaisedDateFilter({
  from, to, onChange, label = "Raised",
}: {
  from: string;
  to: string;
  onChange: (range: RaisedRange) => void;
  /** Which date it bounds, as the screen calls it. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const set = Boolean(from || to);

  // Closing on an outside press and on Escape, because a panel that can only be shut
  // by pressing its own trigger again traps somebody who has moved on to the grid.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!shell.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // Derived, never stored: whichever preset the two dates currently spell, if any.
  const active = useMemo(
    () => PRESETS.find((preset) => {
      const range = preset.range();
      return range.from === from && range.to === to;
    }),
    [from, to],
  );

  const reading = !set
    ? "Any time"
    : active
      ? active.label
      : from && to
        ? `${shortDay(from)} – ${shortDay(to)}`
        : from
          ? `From ${shortDay(from)}`
          : `Up to ${shortDay(to)}`;

  return (
    <div className="relative" ref={shell}>
      <div
        className={`${FILTER_TOGGLE} ${set ? FILTER_TOGGLE_ON : FILTER_TOGGLE_OFF} ${
          set ? "pr-1" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="inline-flex h-full items-center gap-2 outline-none"
        >
          <Calendar className="h-4 w-4 shrink-0 opacity-70" />
          {/* The field is named on the pill, so the filter can be read without opening
            * it — "Raised: Last 7 days" rather than two empty date boxes. */}
          <span className="whitespace-nowrap">
            <span className={set ? "opacity-70" : ""}>{label}:</span> {reading}
          </span>
          <ChevronDown className={`${FILTER_CHEVRON} ${open ? "rotate-180" : ""}`} />
        </button>
        {set && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()} dates`}
            onClick={() => onChange({ from: "", to: "" })}
            className={FILTER_CLEAR}
          >
            <span aria-hidden className="text-base leading-none">&times;</span>
          </button>
        )}
      </div>

      {open && (
        <div
          role="dialog"
          aria-label={`${label} date filter`}
          className={`absolute left-0 top-[calc(100%+0.4rem)] z-20 w-[19rem] ${FILTER_PANEL} p-2`}
        >
          <button
            type="button"
            onClick={() => { onChange({ from: "", to: "" }); setOpen(false); }}
            className={`${FILTER_ROW} ${!set ? FILTER_ROW_ON : FILTER_ROW_OFF}`}
          >
            <span className="flex-1">Any time</span>
            {!set && <Check className="h-4 w-4 text-brand" />}
          </button>

          {PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => { onChange(preset.range()); setOpen(false); }}
              className={`${FILTER_ROW} ${
                active?.key === preset.key ? FILTER_ROW_ON : FILTER_ROW_OFF
              }`}
            >
              <span className="flex-1 truncate">{preset.label}</span>
              {active?.key === preset.key && <Check className="h-4 w-4 shrink-0 text-brand" />}
            </button>
          ))}

          {/* The calendars stay, one press below the answers most people want, with the
            * two ends actually labelled. Each bound is independent and both are
            * inclusive — the server does the "up to and including" arithmetic. */}
          <div className="mt-2 space-y-2 border-t border-line pt-2">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Exact dates
            </p>
            <div className="grid grid-cols-2 gap-2 px-1 pb-1">
              <label className="block text-xs font-medium text-muted">
                From
                <input
                  type="date"
                  aria-label={`${label} from`}
                  value={from}
                  max={to || undefined}
                  onChange={(event) => onChange({ from: event.target.value, to })}
                  className="mt-1 h-10 w-full rounded-lg border-2 border-line bg-content1 px-2 text-sm font-medium text-ink outline-none transition-colors hover:border-ink/30 focus:border-ink"
                />
              </label>
              <label className="block text-xs font-medium text-muted">
                To
                <input
                  type="date"
                  aria-label={`${label} to`}
                  value={to}
                  min={from || undefined}
                  onChange={(event) => onChange({ from, to: event.target.value })}
                  className="mt-1 h-10 w-full rounded-lg border-2 border-line bg-content1 px-2 text-sm font-medium text-ink outline-none transition-colors hover:border-ink/30 focus:border-ink"
                />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
