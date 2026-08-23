import { type ReactNode } from "react";
import { Calendar, Search, SlidersHorizontal, X } from "lucide-react";
import { selectOnFocus } from "./ui";
import {
  FILTER_CLEAR, FILTER_FIELD, FILTER_H, FILTER_IDLE, FILTER_ON, FILTER_RAIL, FILTER_SHELL,
} from "./filterChrome";

/**
 * The one filter strip. Inventory, warehouse and procurement all sit under this.
 *
 * NEW 2026-08-22. There were three of these — inventory's, warehouse's, and a fourth
 * copy hand-rolled inline on each of six procurement screens — so the same row of
 * controls had three different heights, three different search boxes and three
 * different ideas of where "Clear" goes. The two module bars are now thin wrappers
 * over this one (they keep their own prop names, so no screen had to change), and the
 * procurement screens call it directly.
 *
 * What goes in it: everything that NARROWS the list. What never goes in it: anything
 * that creates a document — that belongs in the PageHeader actions.
 */
export function FilterBar({
  search, onSearch, searchPlaceholder = "Search…", searchLabel,
  children, onClear, active = 0, right, className = "",
}: {
  search?: string;
  onSearch?: (v: string) => void;
  searchPlaceholder?: string;
  /** Accessible name, when the placeholder is a long sentence ("Scan or type a…"). */
  searchLabel?: string;
  children?: ReactNode;
  onClear?: () => void;
  /** How many filters are set. Drives the count on Clear, and the badge below md. */
  active?: number;
  /** Right-hand slot — a result count, an export button. */
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mb-4 ${FILTER_RAIL} ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {onSearch && (
          <SearchField
            value={search ?? ""}
            onChange={onSearch}
            placeholder={searchPlaceholder}
            label={searchLabel}
            className="min-w-[220px] flex-1 sm:max-w-sm"
          />
        )}
        {children}
        {onClear && active > 0 && (
          <button
            type="button"
            onClick={onClear}
            className={`flex ${FILTER_H} items-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted transition hover:bg-bad-bg hover:text-bad`}
          >
            <X className="h-4 w-4" /> Clear {active > 1 ? `all ${active}` : ""}
          </button>
        )}
        {right && <div className="ml-auto flex items-center gap-2 pr-1">{right}</div>}
      </div>
    </div>
  );
}

/** The search box, one shape everywhere.
 *
 * Carries its own clear button: a term typed into a filter box is the single most
 * common thing anybody wants to take back out, and reaching for backspace nine times
 * was the only way to do it. `selectOnFocus` means the next thing typed REPLACES the
 * old term, which on a search box is always what was meant.
 */
export function SearchField({
  value, onChange, placeholder = "Search…", label, className = "", autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onFocus={selectOnFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.preventDefault(); onChange(""); } }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        /* [&::-webkit-search-cancel-button]:hidden — Chrome draws its own tiny grey X
           on type=search, unstyleable and off our 44px target. Ours is below. */
        className={`${FILTER_FIELD} pl-9 pr-10`}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted transition hover:bg-bad-bg hover:text-bad"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** On/off filter pill — the same pill as FilterMenu, so a bar of six controls is one
 *  row of one shape rather than a mix of buttons, switches and dropdowns. */
export function FilterToggle({
  active, onChange, children, icon,
}: {
  active: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      aria-pressed={active}
      className={`${FILTER_SHELL} gap-2 px-3.5 ${
        active ? FILTER_ON : FILTER_IDLE
      }`}
    >
      {icon ?? <SlidersHorizontal className="h-4 w-4 opacity-70" />}
      {children}
    </button>
  );
}

/** A from/to date pair, dressed as one pill so it sits level with the dropdowns
 *  instead of floating beside them as two bare browser date boxes. */
export function FilterDateRange({
  label, from, to, onFrom, onTo,
}: {
  label: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const set = Boolean(from || to);
  return (
    <div
      className={`${FILTER_SHELL} gap-1 pl-3.5 pr-1.5 ${
        set ? FILTER_ON : FILTER_IDLE
      }`}
    >
      <Calendar className="h-4 w-4 shrink-0 opacity-70" />
      <input
        type="date"
        aria-label={`${label} from`}
        value={from}
        max={to || undefined}
        onChange={(e) => onFrom(e.target.value)}
        className={`${FILTER_H} bg-transparent text-sm font-medium outline-none`}
      />
      <span className="text-xs opacity-60">to</span>
      <input
        type="date"
        aria-label={`${label} to`}
        value={to}
        min={from || undefined}
        onChange={(e) => onTo(e.target.value)}
        className={`${FILTER_H} bg-transparent text-sm font-medium outline-none`}
      />
      {set && (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()} dates`}
          onClick={() => { onFrom(""); onTo(""); }}
          className={FILTER_CLEAR}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
