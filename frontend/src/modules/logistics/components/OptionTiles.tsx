import type { ReactNode } from "react";
import { Check } from "lucide-react";

/**
 * A choice made by pressing the thing you mean, instead of hunting it in a dropdown.
 *
 * Presentation only — it renders whatever options it is handed and reports the value
 * back, so the rules about WHICH options exist stay where they already live (the
 * backend's `/api/transport/modes`, and the carriage table beside it). Nothing here
 * knows what a mode is.
 *
 * Why a dropdown was the wrong control for these two questions: the mode and the type
 * decide the whole rest of the form, and their help text is the reason to pick one.
 * A `<select>` hides both the alternatives and the explanation until it is opened,
 * so the desk read four lines of prose under a closed box to learn what it had
 * already picked by default. Laid out as tiles, the choice, the alternatives and the
 * reason are one glance, and the caption stops being a wall of text under the field.
 *
 * Keyboard and screen readers get a real radio group: arrow keys move, Space picks,
 * and each tile announces its own label and caption rather than "button".
 */
export interface TileOption {
  value: string;
  label: string;
  /** One short line under the label — why you would pick this one. */
  help?: string;
  icon?: ReactNode;
  /** A word in the corner: what happens after you pick it. */
  badge?: string;
}

export function OptionTiles({
  value, onChange, options, ariaLabel, columns = 2, size = "md",
}: {
  value: string;
  onChange: (value: string) => void;
  options: TileOption[];
  ariaLabel: string;
  /** Tiles per row from `sm` up. One column below that, always. */
  columns?: 2 | 3 | 4;
  /** `sm` drops the caption — for a row of short, self-evident choices. */
  size?: "sm" | "md";
}) {
  const cols = {
    2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4",
  }[columns];

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`grid grid-cols-1 gap-2 ${cols}`}>
      {options.map((option) => {
        const picked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={picked}
            // Only the selected tile is in the tab order; the arrows move within the
            // group. That is how a radio group behaves, and it keeps a four-option
            // picker from costing four tab stops.
            tabIndex={picked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
              if (!keys.includes(event.key)) return;
              event.preventDefault();
              const at = options.findIndex((o) => o.value === value);
              const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
              const nextAt = (at + step + options.length) % options.length;
              const next = options[nextAt];
              if (!next) return;
              onChange(next.value);
              // The DOM focus travels with the selection. Without it the tile that is
              // now checked is not the tile the keyboard is standing on, and the next
              // arrow press moves from the wrong place.
              const sibling = event.currentTarget.parentElement?.children[nextAt];
              if (sibling instanceof HTMLElement) sibling.focus();
            }}
            className={`group relative flex min-h-11 items-start gap-3 rounded-xl border px-3 py-3 text-left
              transition-all duration-150 outline-none
              focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-1
              ${picked
                ? "border-brand bg-brand-050 shadow-sm ring-1 ring-brand/25"
                : "border-line bg-content1 hover:border-brand/45 hover:bg-brand-050/40 hover:shadow-sm"}`}
          >
            {option.icon && (
              <span
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors
                  ${picked
                    ? "bg-brand text-white"
                    : "bg-content2 text-muted group-hover:bg-brand/10 group-hover:text-brand"}`}
                aria-hidden
              >
                {option.icon}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className={`truncate text-sm font-semibold ${picked ? "text-brand" : "text-ink"}`}>
                  {option.label}
                </span>
                {option.badge && (
                  <span className="shrink-0 rounded-full bg-content2 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted">
                    {option.badge}
                  </span>
                )}
              </span>
              {size === "md" && option.help && (
                <span className="mt-0.5 block text-xs leading-snug text-muted">{option.help}</span>
              )}
            </span>
            {picked && (
              <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-brand" aria-hidden />
            )}
          </button>
        );
      })}
    </div>
  );
}
