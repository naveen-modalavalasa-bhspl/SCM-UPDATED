import { type ReactNode } from "react";
import { Search, X } from "lucide-react";

/**
 * One filter row, same shape on every inventory screen.
 *
 * Screens used to scatter search boxes, toggles and buttons across three rows above
 * the table, so no two looked alike and the page read as crowded. Everything that
 * narrows the list goes in here; everything that creates a document goes in the
 * PageHeader actions. Nothing else sits between the header and the table.
 */
export function FilterBar({
  search, onSearch, searchPlaceholder = "Search…", children, onClear, active = 0,
}: {
  search?: string;
  onSearch?: (v: string) => void;
  searchPlaceholder?: string;
  children?: ReactNode;
  onClear?: () => void;
  active?: number;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line/70 bg-content1 p-2">
      {onSearch && (
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={search ?? ""}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
          />
        </div>
      )}
      {children}
      {onClear && active > 0 && (
        <button
          onClick={onClear}
          className="flex h-11 items-center gap-1 rounded-lg px-3 text-sm font-medium text-muted hover:bg-content2 hover:text-ink"
        >
          <X size={14} /> Clear ({active})
        </button>
      )}
    </div>
  );
}

/** Compact select sized to sit in the filter bar. */
export function FilterSelect({
  value, onChange, options, placeholder, allowEmpty = true,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string | number; label: string }[];
  placeholder: string;
  /** False for fields that always need a value (e.g. a label size a render depends
   * on) — the blank option let a caller land on "" and crash on a lookup that
   * assumed one of `options` was always selected. */
  allowEmpty?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-11 min-w-[150px] rounded-lg border border-line bg-content1 px-3 text-sm text-ink outline-none focus:border-brand"
    >
      {allowEmpty && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** On/off filter pill — replaces the loose toggle switches that floated above tables. */
export function FilterToggle({
  active, onChange, children,
}: {
  active: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={() => onChange(!active)}
      aria-pressed={active}
      className={`h-11 rounded-lg border px-3 text-sm font-medium ${
        active
          ? "border-brand bg-brand/10 text-brand"
          : "border-line bg-content1 text-body hover:bg-content2"
      }`}
    >
      {children}
    </button>
  );
}
