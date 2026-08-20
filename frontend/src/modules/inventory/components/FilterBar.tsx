import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { selectOnFocus } from "@/shared/components";

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

/** Compact select sized to sit in the filter bar — typable.
 *
 * A native `<select>` only jumps to the first letter, which is no help against a
 * warehouse list of 900 stocking points. This is a combobox: type to narrow, click
 * or Enter to pick. Same props as before, so every caller gained it without a change.
 *
 * It filters the `options` it was handed and fetches nothing of its own, so what a
 * login can see is still decided by the endpoint that built that list. There is no
 * path here to a row the server did not already return.
 */
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
  // null means "showing the selection", not "typed an empty string" — the difference
  // between an untouched box and one the user cleared to see every option again.
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => String(o.value) === String(value));
  const matches = typed
    ? options.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) { setOpen(false); setTyped(null); }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pick = (v: string) => { onChange(v); setTyped(null); setOpen(false); };

  return (
    <div ref={box} className="relative min-w-[150px]">
      <input
        role="combobox"
        aria-expanded={open}
        aria-label={placeholder}
        value={typed ?? selected?.label ?? ""}
        placeholder={placeholder}
        onChange={(e) => { setTyped(e.target.value); setOpen(true); }}
        // Typing REPLACES the current choice instead of editing it. Without the
        // select, clicking a filter that reads "Main Warehouse" and typing "lip"
        // leaves "Main Warehouselip" and matches nothing.
        onFocus={(e) => { setOpen(true); selectOnFocus(e); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); setTyped(null); }
          if (e.key === "Enter" && open && matches.length) {
            e.preventDefault();
            pick(String(matches[0].value));
          }
        }}
        className="h-11 w-full rounded-lg border border-line bg-content1 pl-3 pr-8 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
      />
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      {open && (
        // mousedown is prevented on each row: the input's blur would otherwise close
        // the list before the click landed, and the pick would be lost.
        <ul className="absolute z-30 mt-1 max-h-64 w-full min-w-full overflow-auto rounded-lg border border-line bg-content1 py-1 shadow-lg">
          {allowEmpty && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick("")}
                className="flex min-h-[44px] w-full items-center px-3 text-left text-sm text-muted hover:bg-content2"
              >
                {placeholder}
              </button>
            </li>
          )}
          {matches.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(String(o.value))}
                className={`flex min-h-[44px] w-full items-center px-3 text-left text-sm hover:bg-content2 ${
                  String(o.value) === String(value)
                    ? "font-semibold text-brand"
                    : "text-ink"
                }`}
              >
                {o.label}
              </button>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="flex min-h-[44px] items-center px-3 text-sm text-muted">
              No match
            </li>
          )}
        </ul>
      )}
    </div>
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
