import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, Search, X } from "lucide-react";

/**
 * A field that searches the SERVER as you type and shows rich rows.
 *
 * `Lookup` loads one capped page once and filters it in the browser, which is right for
 * a ten-row master and wrong for 4,000 employees or 1,000 stocking points: anything past
 * the first page simply cannot be found. Here every keystroke (debounced) is a query, the
 * answer carries how many matched in total, and the list says "keep typing" when the cap
 * cut it short — so nobody is ever told a person does not exist because of where they sort.
 *
 * Keyboard: ↑ ↓ move, Enter picks, Esc closes. The chosen row stays in the closed field
 * with its subtitle, so the choice reads the same as it did in the list.
 */
export interface PickerRow {
  id: number;
  title: string;
  subtitle?: string | null;
  /** Short chips beside the title — a code, a type, a service area code. */
  badges?: { text: string; tone?: "brand" | "ok" | "muted" | "warn" }[];
}

const TONE: Record<string, string> = {
  brand: "bg-brand/10 text-brand",
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/15 text-warn",
  muted: "bg-content3 text-muted",
};

export function SearchPicker<T>({
  label,
  hint,
  value,
  onChange,
  load,
  queryKey,
  toRow,
  placeholder = "Search…",
  emptyText = "Nothing matches.",
  disabled = false,
  filterNote,
  required = false,
  error,
}: {
  label: string;
  hint?: ReactNode;
  value: PickerRow | null;
  onChange: (row: T | null) => void;
  load: (search: string) => Promise<{ items: T[]; total: number }>;
  /** Everything that changes WHAT is searched (filters), never the search text. */
  queryKey: readonly unknown[];
  toRow: (item: T) => PickerRow;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** Said at the top of the open list when a filter narrows it, with a way out. */
  filterNote?: ReactNode;
  required?: boolean;
  /** Said under the field, in red, in place of the hint — a required one left empty. */
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Where the open list sits, in VIEWPORT coordinates. The list is portalled to the
  // body: inside the form it was clipped by the card around it, so the lower rows of a
  // grid (Issued to, SAC) opened into a list nobody could see.
  const [place, setPlace] = useState<{ style: CSSProperties; listMax: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const timer = setTimeout(() => setTerm(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);

  // Close on a press anywhere else.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (box.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // Below the field when it fits, above it when the viewport has more room there; as
  // wide as the field (never under 18rem), kept inside a 16px gutter; re-measured on
  // every scroll and resize so it stays attached while the page moves under it.
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return; }
    const measure = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const gutter = 16;
      const gap = 6;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(Math.max(rect.width, 288), vw - gutter * 2);
      const left = Math.min(Math.max(rect.left, gutter), vw - width - gutter);
      const below = vh - rect.bottom - gap - gutter;
      const above = rect.top - gap - gutter;
      const upward = below < 300 && above > below;
      const room = upward ? above : below;
      // The search box, the filter note and the footer take ~120px of the panel.
      const listMax = Math.max(120, Math.min(320, room - 120));
      setPlace({
        listMax,
        style: upward
          ? { position: "fixed", left, width, bottom: vh - rect.top + gap }
          : { position: "fixed", left, width, top: rect.bottom + gap },
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const results = useQuery({
    queryKey: ["wh-search-picker", ...queryKey, term],
    queryFn: () => load(term),
    enabled: open && !disabled,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
  const items = results.data?.items ?? [];
  const total = results.data?.total ?? 0;

  useEffect(() => { setActive(0); }, [term, results.data]);

  const openList = () => {
    if (disabled) return;
    setOpen(true);
    setText("");
    setTerm("");
    setTimeout(() => input.current?.focus(), 0);
  };
  const pick = (item: T | null) => {
    onChange(item);
    setOpen(false);
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (items[active]) pick(items[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="block" ref={box}>
      <span className="mb-1.5 block text-sm font-medium text-body">
        {label}
        {required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
      </span>
      <div className="relative" ref={anchor}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : openList())}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          className={`flex min-h-11 w-full items-center gap-2 rounded-md border bg-content1 px-3 py-1.5 text-left transition
            ${open ? "border-brand ring-2 ring-brand/15"
              : error ? "border-bad ring-1 ring-bad/20" : "border-line hover:border-ink/30"}
            ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
        >
          {value ? (
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-ink">{value.title}</span>
                {value.badges?.slice(0, 2).map((badge) => (
                  <span key={badge.text}
                        className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${TONE[badge.tone ?? "muted"]}`}>
                    {badge.text}
                  </span>
                ))}
              </span>
              {value.subtitle && (
                <span className="block truncate text-[11px] text-muted">{value.subtitle}</span>
              )}
            </span>
          ) : (
            <span className="flex-1 truncate text-sm text-muted">{placeholder}</span>
          )}
          {value && !disabled ? (
            <span
              role="button"
              tabIndex={0}
              aria-label={`Clear ${label}`}
              onClick={(event) => { event.stopPropagation(); pick(null); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault(); event.stopPropagation(); pick(null);
                }
              }}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-content3 hover:text-bad"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          ) : (
            <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} />
          )}
        </button>

        {open && place && createPortal(
          <div ref={panel} style={place.style}
               className="z-[1000] overflow-hidden rounded-xl border border-line bg-content1 shadow-2xl shadow-black/15 ring-1 ring-black/5">
            <div className="flex items-center gap-2 border-b border-line/70 px-3">
              {results.isFetching
                ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand" />
                : <Search className="h-4 w-4 shrink-0 text-muted" />}
              <input
                ref={input}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKey}
                placeholder={placeholder}
                aria-label={`Search ${label}`}
                aria-controls={listId}
                className="h-11 w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted"
              />
            </div>
            {filterNote && (
              <div className="border-b border-line/70 bg-content2/60 px-3 py-1.5 text-[11px] text-muted">
                {filterNote}
              </div>
            )}
            <ul id={listId} role="listbox" className="overflow-y-auto overscroll-contain py-1"
                style={{ maxHeight: place.listMax }}>
              {results.isError ? (
                <li className="px-3 py-6 text-center text-sm text-bad">
                  Could not search. Check your connection and try again.
                </li>
              ) : results.isPending ? (
                <li className="px-3 py-6 text-center text-sm text-muted">Searching…</li>
              ) : items.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-muted">
                  {term ? `Nothing matches “${term}”.` : emptyText}
                </li>
              ) : (
                items.map((item, index) => {
                  const row = toRow(item);
                  const chosen = value?.id === row.id;
                  return (
                    <li key={row.id} role="option" aria-selected={chosen}>
                      <button
                        type="button"
                        onMouseEnter={() => setActive(index)}
                        onClick={() => pick(item)}
                        className={`flex w-full items-start gap-2 px-3 py-2 text-left transition
                          ${index === active ? "bg-brand/5" : ""}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-ink">{row.title}</span>
                            {row.badges?.map((badge) => (
                              <span key={badge.text}
                                    className={`rounded px-1.5 py-px text-[10px] font-semibold ${TONE[badge.tone ?? "muted"]}`}>
                                {badge.text}
                              </span>
                            ))}
                          </span>
                          {row.subtitle && (
                            <span className="mt-0.5 block truncate text-[11px] text-muted">{row.subtitle}</span>
                          )}
                        </span>
                        {chosen && <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
            {items.length > 0 && (
              <div className="border-t border-line/70 bg-content2/40 px-3 py-1.5 text-[11px] text-muted">
                {total > items.length
                  ? `Showing ${items.length} of ${total.toLocaleString()} — keep typing to narrow.`
                  : `${total.toLocaleString()} match${total === 1 ? "" : "es"}`}
              </div>
            )}
          </div>,
          document.body,
        )}
      </div>
      {error
        ? <span className="mt-1 block text-xs font-medium text-bad" role="alert">{error}</span>
        : hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </div>
  );
}
