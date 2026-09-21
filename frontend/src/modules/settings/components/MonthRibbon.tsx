/** The month, drawn — the one surface on this screen that is not a form.
 *
 *  Every setting on the Monthly Indent page is a day number: open on the 1st, close
 *  on the 30th, remind on the 21st, chase on the 25th. Four integers in four boxes
 *  never answered the two questions an admin actually has — does the reminder fall
 *  inside the collection window, and is the day it lands a working day — so the month
 *  is laid out instead, with the window as a band and every scheduled event as a mark
 *  on the day it fires.
 *
 *  It draws the dates `monthlyIndentPlan` computes, which mirror the server's own
 *  `calculate_cycle` / `_due_at`. That matters for the clamp: a reminder set for a day
 *  outside the window is not skipped by the server, it is pulled to the nearest edge —
 *  so the mark appears on the edge, wearing a ring that says it was moved, rather than
 *  sitting quietly outside the band pretending it will never run.
 *
 *  A wrapping cycle (opens 21st, closes 20th) genuinely spans two months, so the
 *  ribbon draws two. The band is painted per CELL rather than as one absolute strip,
 *  which is what lets it survive both the wrap and a phone reflowing 31 cells into
 *  four rows.
 */
import type { ReactNode } from "react";

import type { CycleWindow } from "../monthlyIndentPlan";
import { dateKey, daysInMonth, monthName, sameDay } from "../monthlyIndentPlan";

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

export interface DayMark {
  /** First nudges landing on this day. */
  remind: number;
  /** Follow-ups to a manager landing on this day. */
  chase: number;
  /** At least one of them was pulled here from a day outside the window. */
  moved: boolean;
}

export function MonthRibbon({
  window: win, marks, selected, today, onSelect,
}: {
  window: CycleWindow;
  marks: Map<string, DayMark>;
  selected: Date | null;
  today: Date;
  onSelect: (date: Date) => void;
}) {
  return (
    <div className="space-y-4">
      {win.months.map(({ year, month }) => (
        <div key={`${year}-${month}`}>
          {win.months.length > 1 && (
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {monthName(year, month)}
            </p>
          )}
          {/* Narrow cells and a hairline gap, so a whole 31-day month fits one row on
              a laptop and the highlighted days read as one continuous band rather than
              thirty-one separate pink tiles. It still wraps on a phone, which is the
              only reason this is auto-fit and not a fixed 31 columns. */}
          {/* auto-FILL, not auto-fit: fit collapses the empty tracks on a wrapped last
              row and the five leftover days then stretch to twice the width of the
              twenty-six above them. Fill keeps every cell the same size. */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(1.5rem,1fr))] gap-[2px]">
            {Array.from({ length: daysInMonth(year, month) }, (_, index) => {
              const date = new Date(year, month, index + 1);
              return (
                <DayCell
                  key={index}
                  date={date}
                  window={win}
                  mark={marks.get(dateKey(date))}
                  isToday={sameDay(date, today)}
                  isSelected={selected != null && sameDay(date, selected)}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        </div>
      ))}
      <Legend />
    </div>
  );
}

function DayCell({
  date, window: win, mark, isToday, isSelected, onSelect,
}: {
  date: Date;
  window: CycleWindow;
  mark?: DayMark;
  isToday: boolean;
  isSelected: boolean;
  onSelect: (date: Date) => void;
}) {
  const inWindow = date >= win.start && date <= win.end;
  const isOpen = sameDay(date, win.start);
  const isClose = sameDay(date, win.end);

  // The band is one background painted cell by cell; only its two ends are rounded,
  // so a run of days reads as a single bar rather than a row of separate tiles.
  const band = inWindow
    ? `bg-brand-050 ${isOpen ? "!rounded-l-lg" : ""} ${isClose ? "!rounded-r-lg" : ""}`
    : "";
  const ring = isSelected
    ? "ring-2 ring-inset ring-brand"
    : isToday
      ? "ring-1 ring-inset ring-ink/40"
      : isOpen || isClose ? "ring-1 ring-inset ring-brand/35" : "";

  const what = [
    isOpen ? "collection opens" : null,
    isClose ? "collection closes" : null,
    mark?.remind ? `${mark.remind} reminder${mark.remind === 1 ? "" : "s"}` : null,
    mark?.chase ? `${mark.chase} follow-up${mark.chase === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(", ");

  return (
    <button
      type="button"
      onClick={() => onSelect(date)}
      aria-pressed={isSelected}
      aria-label={`${date.getDate()} ${monthName(date.getFullYear(), date.getMonth())}${
        what ? ` — ${what}` : ""}`}
      title={what || undefined}
      className={`relative flex min-h-[2.85rem] flex-col items-center justify-center gap-[3px]
        rounded-[3px] px-0.5 py-1 transition-colors ${band} ${ring}
        hover:bg-content2 focus-visible:outline-none focus-visible:ring-2
        focus-visible:ring-brand/60`}
    >
      <span className={`text-[9px] font-semibold uppercase leading-none tracking-wide ${
        inWindow ? "text-brand/70" : "text-muted/70"}`}
      >
        {WEEKDAY[date.getDay()]}
      </span>
      <span className={`font-display text-sm font-bold leading-none tabular ${
        inWindow ? "text-ink" : "text-muted"}`}
      >
        {date.getDate()}
      </span>
      <span className="flex h-1.5 items-center gap-[3px]">
        {Array.from({ length: Math.min(mark?.remind ?? 0, 3) }, (_, i) => (
          <i key={`r${i}`} className="block h-1.5 w-1.5 rounded-full bg-brand" />
        ))}
        {Array.from({ length: Math.min(mark?.chase ?? 0, 3) }, (_, i) => (
          <i key={`c${i}`} className="block h-1.5 w-1.5 rounded-full bg-warn" />
        ))}
        {mark?.moved && <i className="block h-1.5 w-1.5 rounded-full ring-1 ring-warn" />}
      </span>
      {isToday && (
        <span className="absolute inset-x-1.5 bottom-[3px] h-[2px] rounded-full bg-ink/60" />
      )}
    </button>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted">
      <LegendItem swatch={
        <i className="block h-3 w-5 rounded bg-brand-050 ring-1 ring-inset ring-brand/35" />
      }>
        Collection window
      </LegendItem>
      <LegendItem swatch={<i className="block h-2 w-2 rounded-full bg-brand" />}>
        Reminder goes out
      </LegendItem>
      <LegendItem swatch={<i className="block h-2 w-2 rounded-full bg-warn" />}>
        Manager is told
      </LegendItem>
      <LegendItem swatch={<i className="block h-3 w-5 rounded ring-1 ring-inset ring-ink/40" />}>
        Today
      </LegendItem>
    </div>
  );
}

function LegendItem({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5">{swatch}{children}</span>;
}
