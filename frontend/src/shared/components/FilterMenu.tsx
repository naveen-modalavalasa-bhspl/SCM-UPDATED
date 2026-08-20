import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Boxes, Building2, Calendar, ChevronDown, Filter, Flag, MapPin, Package, Search,
  Tag, Truck, User,
} from "lucide-react";

/**
 * The icon a filter gets when the caller does not pass one.
 *
 * Matched on the LABEL rather than declared per call site: the same five or six
 * filters (status, date, warehouse, item, vendor, priority) repeat across thirty
 * screens in four modules, and asking every caller to import the right lucide icon is
 * how they end up inconsistent. A label nothing matches falls back to the funnel,
 * which is what a filter is.
 */
const ICON_BY_WORD: [RegExp, typeof Filter][] = [
  [/date|raised|required|expiry|expiring|period|when|due/i, Calendar],
  [/warehouse|location|region|point|office|branch|bin|store/i, MapPin],
  [/vendor|supplier|carrier|partner/i, Truck],
  [/item|product|material|sku/i, Package],
  [/priority|urgen/i, Flag],
  [/project|department|category/i, Building2],
  [/requester|raiser|approver|user|person|by/i, User],
  [/batch|lot|serial|asset|code/i, Tag],
  [/type|kind|mode|direction|movement/i, Boxes],
];

function defaultIcon(label: string) {
  const Match = ICON_BY_WORD.find(([re]) => re.test(label))?.[1] ?? Filter;
  return <Match className="h-4 w-4 opacity-70" />;
}

/** Pill dropdown filter — the shape the Indents filter row uses.
 *
 * A button that reads "Status ⌄" until something is picked, then reads the picked
 * label. The list inside is TEXT SEARCHABLE: warehouse and item filters run to
 * hundreds of rows and a plain menu is unusable at that length.
 *
 * Separate from `FilterSelect` (which is an always-open combobox input) because a
 * read-only records screen wants the compact pill, not five text boxes in a row.
 * It filters the `options` handed to it and fetches nothing — what a login can see is
 * still whatever the endpoint returned.
 */
export function FilterMenu({
  label, value, onChange, options, icon, allowEmpty = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string | number; label: string }[];
  icon?: ReactNode;
  /** False for a field that must always hold a value — a label size a render depends
   *  on, say. Dropping the "all" row is the only difference. */
  allowEmpty?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => String(o.value) === String(value));
  const matches = typed
    ? options.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) { setOpen(false); setTyped(""); }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pick = (v: string) => { onChange(v); setTyped(""); setOpen(false); };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`flex h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${
          selected
            ? "border-brand bg-brand/10 text-brand"
            : "border-line bg-content1 text-body hover:bg-content2"
        }`}
      >
        {icon ?? defaultIcon(label)}
        <span className="max-w-[160px] truncate">{selected?.label ?? label}</span>
        <ChevronDown className="h-4 w-4 opacity-70" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-64 rounded-lg border border-line bg-content1 py-1 shadow-lg">
          <div className="relative px-2 pb-1 pt-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-9 w-full rounded-md border border-line bg-content1 pl-7 pr-2 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
            />
          </div>
          <ul className="max-h-64 overflow-auto">
            {allowEmpty && <li>
              <button
                type="button"
                onClick={() => pick("")}
                className="flex min-h-[40px] w-full items-center px-3 text-left text-sm text-muted hover:bg-content2"
              >
                {label} — all
              </button>
            </li>}
            {matches.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  onClick={() => pick(String(o.value))}
                  className={`flex min-h-[40px] w-full items-center px-3 text-left text-sm hover:bg-content2 ${
                    String(o.value) === String(value) ? "font-semibold text-brand" : "text-ink"
                  }`}
                >
                  {o.label}
                </button>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="flex min-h-[40px] items-center px-3 text-sm text-muted">No match</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
