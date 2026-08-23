import { useEffect, useRef, useState } from "react";
import { Card, selectOnFocus } from "@/shared/components";
import { Search, X } from "lucide-react";

/**
 * The search box the logistics desk types into.
 *
 * Same field, same behaviour and same proportions as the one over Consignments, so
 * moving between the two screens does not feel like moving between two products —
 * the desk works both in the same hour. It is a copy rather than an import: the
 * warehouse's `FilterBar` is that module's own arrangement of the shared kit and
 * logistics sits BEFORE warehouse in the chain, so reaching across for it would tie
 * this queue's look to a screen it has nothing to do with. Shared owns the controls,
 * a module owns how it arranges them.
 *
 * What the design is doing:
 *  - the icon carries the meaning, so the field needs no label above it;
 *  - the resting fill sits a shade off the card, so the box reads as something you
 *    type into rather than as a pill;
 *  - focus is the only state change on the strip — it lifts to white with a brand
 *    ring, and the magnifier tints with it;
 *  - 44px tall, the tap target the app is built to;
 *  - "/" jumps the cursor here, Esc clears, and the × appears once there is text.
 */
export function SearchField({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Overrides the width. Nothing sits beside it on this strip, so by default the
   *  box takes the whole row — a field that stops halfway across a card with dead
   *  space after it looks like the row failed to load the rest of itself. */
  className?: string;
}) {
  const box = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  // Guarded against firing while somebody is typing into a field somewhere else on
  // the screen — otherwise the shortcut eats a slash out of an address or a docket.
  useEffect(() => {
    const jump = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      e.preventDefault();
      box.current?.focus();
    };
    document.addEventListener("keydown", jump);
    return () => document.removeEventListener("keydown", jump);
  }, []);

  return (
    <Card className="mb-4 p-2">
      <label className={`relative block w-full ${className}`}>
        <Search
          aria-hidden
          className={`pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2
                      transition-colors ${focused || value ? "text-brand" : "text-muted"}`}
        />
        <input
          ref={box}
          value={value}
          onFocus={(e) => { setFocused(true); selectOnFocus(e); }}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onChange("")}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-11 w-full rounded-xl border border-line bg-content2/60 pl-10 pr-11
                     text-sm text-ink outline-none transition-[background-color,border-color,box-shadow]
                     placeholder:text-muted hover:bg-content2
                     focus:border-brand focus:bg-content1 focus:ring-4 focus:ring-brand/10"
        />
        {value ? (
          <button
            type="button"
            aria-label="Clear search"
            title="Clear (Esc)"
            onClick={() => onChange("")}
            className="absolute right-2.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center
                       justify-center rounded-lg text-muted transition-colors
                       hover:bg-content2 hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          // The hint, not a control: it fades the moment the box is in use, so it can
          // never be mistaken for something to press.
          <kbd
            aria-hidden
            className={`pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2
                        rounded-md border border-line bg-content1 px-1.5 py-0.5 font-sans
                        text-[10px] font-semibold text-muted transition-opacity sm:block
                        ${focused ? "opacity-0" : "opacity-100"}`}
          >
            /
          </kbd>
        )}
      </label>
    </Card>
  );
}
