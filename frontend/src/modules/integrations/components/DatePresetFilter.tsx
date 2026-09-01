import { useEffect, useRef, useState } from "react";
import { Calendar, Check, ChevronDown, X } from "lucide-react";
import {
  FILTER_CLEAR, FILTER_IDLE, FILTER_ON, FILTER_PANEL, FILTER_SHELL, FILTER_TRIGGER,
} from "@/shared/components";
import { todayIst } from "@/shared/datetime";

/**
 * "When did this arrive" — the date filter the indents rail uses, in the shape the
 * rest of the app already reads: five presets, a custom range behind the fifth, and
 * Clear / Apply.
 *
 * It is written here rather than imported because that control lives inside the
 * indents module and a module never reaches into another module's components. What
 * IS shared is the look: every class on the pill comes from
 * `shared/components/filterChrome`, so this moves with every other filter in the app
 * when those tokens move, and nothing about the dress is decided in this file.
 *
 * The presets resolve against the IST day, not the browser's — the same clock the
 * Received column is printed with, or "Today" would list yesterday's pushes for
 * anyone whose laptop is set to another zone.
 */
export type DatePreset = "all" | "today" | "this_week" | "this_month" | "custom";

export interface DateFilter {
  preset: DatePreset;
  /** Inclusive, `YYYY-MM-DD` in IST. Empty on `all`. */
  from: string;
  to: string;
}

export const ALL_DATES: DateFilter = { preset: "all", from: "", to: "" };

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "this_week", label: "This week" },
  { key: "this_month", label: "This month" },
  { key: "custom", label: "Custom range" },
];

const RANGE_ERROR = "To date must be the same as or later than From date.";

const pad = (value: number) => String(value).padStart(2, "0");
const asDay = (value: Date) =>
  `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;

/** Today in IST, as a Date built from its own parts — arithmetic below is calendar
 *  arithmetic, so the browser's zone never enters into it. */
function istToday(): Date {
  const [year, month, day] = todayIst().split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** The window a preset means, both ends inclusive. `all` and `custom` carry none. */
export function rangeForPreset(preset: DatePreset): { from: string; to: string } {
  if (preset === "all" || preset === "custom") return { from: "", to: "" };
  const today = istToday();
  if (preset === "today") return { from: asDay(today), to: asDay(today) };
  if (preset === "this_week") {
    // Monday start, as the indents rail counts a week.
    const back = today.getDay() === 0 ? 6 : today.getDay() - 1;
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    return { from: asDay(monday), to: asDay(today) };
  }
  return {
    from: asDay(new Date(today.getFullYear(), today.getMonth(), 1)),
    to: asDay(today),
  };
}

/** What the pill says once it is holding something, so the bar can be read without
 *  opening it. */
function summarise(value: DateFilter, label: string): string {
  if (value.preset === "all") return label;
  const named = PRESETS.find((option) => option.key === value.preset);
  if (value.preset !== "custom") return named?.label ?? label;
  if (value.from && value.to) {
    return value.from === value.to ? value.from : `${value.from} → ${value.to}`;
  }
  return "Custom range";
}

export function DatePresetFilter({ label, description, value, onChange }: {
  label: string;
  description: string;
  value: DateFilter;
  onChange: (next: DateFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateFilter>(value);
  const [problem, setProblem] = useState("");
  const shell = useRef<HTMLDivElement>(null);

  const active = value.preset !== "all";
  const isCustom = draft.preset === "custom";
  const cannotApply = isCustom && (!draft.from || !draft.to || Boolean(problem));

  // Opening reloads the draft from what is applied, so a cancelled edit leaves
  // nothing behind for the next open to inherit.
  useEffect(() => {
    if (open) { setDraft(value); setProblem(""); }
  }, [open, value]);

  // A filter panel left open behind a click somewhere else is the one thing every
  // dropdown in this app agrees on.
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

  const pick = (preset: DatePreset) => {
    setProblem("");
    if (preset === "custom") {
      setDraft({ preset, from: "", to: "" });
      return;
    }
    setDraft({ preset, ...rangeForPreset(preset) });
  };

  return (
    <div className="relative" ref={shell}>
      <div className={`${FILTER_SHELL} gap-1 ${active ? FILTER_ON : FILTER_IDLE}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
          className={`${FILTER_TRIGGER} gap-2 pl-3.5 ${active ? "pr-2" : "pr-3.5"}`}
        >
          <Calendar className={`h-4 w-4 ${active ? "text-brand" : "text-muted"}`} />
          {summarise(value, label)}
          <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform duration-150 ${
            open ? "rotate-180" : ""}`} />
        </button>
        {active && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => { onChange(ALL_DATES); setOpen(false); }}
            className={FILTER_CLEAR}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div
          role="dialog"
          aria-label={`${label} filter`}
          className={`${FILTER_PANEL} absolute right-0 top-full z-50 mt-2 w-[calc(100vw-2rem)]
                      max-w-96 overflow-y-auto p-3.5 text-xs sm:w-96`}
        >
          <div className="mb-3 flex items-start justify-between gap-4 border-b border-line/60 pb-3">
            <div>
              <h3 className="text-sm font-bold tracking-tight text-ink">{label}</h3>
              <p className="mt-0.5 text-[11px] leading-4 text-muted">{description}</p>
            </div>
            <button
              type="button"
              aria-label={`Close ${label} filter`}
              onClick={() => setOpen(false)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted
                         transition hover:bg-content2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PRESETS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => pick(option.key)}
                className={`flex min-h-10 items-center justify-between rounded-xl px-3 py-2
                            text-left text-[13px] font-semibold ring-1 ring-inset
                            transition-all duration-150 ${
                  draft.preset === option.key
                    ? "bg-brand text-white ring-brand shadow-[0_2px_8px_-2px_rgba(62,99,221,0.45)]"
                    : "bg-content2/70 text-body ring-transparent hover:bg-content2 hover:ring-line"}`}
              >
                <span>{option.label}</span>
                {draft.preset === option.key && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>

          {isCustom && (
            <div className="mt-3 rounded-xl border border-line/60 bg-content2/40 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">
                    From
                  </span>
                  <input
                    aria-label={`${label} from`}
                    type="date"
                    value={draft.from}
                    max={draft.to || undefined}
                    onChange={(event) => {
                      const from = event.target.value;
                      setDraft({ ...draft, from });
                      setProblem(from && draft.to && from > draft.to ? RANGE_ERROR : "");
                    }}
                    className="h-10 w-full rounded-lg border-0 bg-content1 px-2.5 text-xs
                               font-medium text-body outline-none ring-1 ring-inset ring-line
                               transition focus:ring-2 focus:ring-brand/50"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">
                    To
                  </span>
                  <input
                    aria-label={`${label} to`}
                    type="date"
                    value={draft.to}
                    min={draft.from || undefined}
                    onChange={(event) => {
                      const to = event.target.value;
                      setDraft({ ...draft, to });
                      setProblem(draft.from && to && to < draft.from ? RANGE_ERROR : "");
                    }}
                    className={`h-10 w-full rounded-lg border-0 bg-content1 px-2.5 text-xs
                                font-medium text-body outline-none ring-1 ring-inset transition
                                focus:ring-2 ${problem
                                  ? "ring-bad focus:ring-bad/60"
                                  : "ring-line focus:ring-brand/50"}`}
                  />
                </label>
              </div>
              {problem && <p className="mt-2 text-xs font-medium text-bad">{problem}</p>}
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2 border-t border-line/60 pt-3">
            <button
              type="button"
              onClick={() => { onChange(ALL_DATES); setOpen(false); }}
              className="min-h-10 rounded-xl px-4 text-[13px] font-semibold text-muted
                         transition hover:bg-bad-bg hover:text-bad"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={cannotApply}
              onClick={() => {
                if (cannotApply) return;
                onChange(draft.preset === "all" ? ALL_DATES : draft);
                setOpen(false);
              }}
              className="min-h-10 rounded-xl bg-brand px-5 text-[13px] font-semibold text-white
                         shadow-[0_2px_10px_-2px_rgba(62,99,221,0.5)] transition
                         hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40
                         disabled:shadow-none"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
