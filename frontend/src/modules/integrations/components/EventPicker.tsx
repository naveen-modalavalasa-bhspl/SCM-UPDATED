import { useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";

/**
 * Pick the event names a webhook accepts — searchable, multi-select, and open.
 *
 * It has to be open, not a closed dropdown. SCM cannot know what a partner calls its
 * events; only they do. So the served list is SUGGESTIONS — what SCM mirrors, plus
 * every name already in use on this deployment, so the second webhook from a partner
 * offers what the first one taught us — and anything typed is accepted just as
 * readily.
 *
 * What the picker actually buys is the TYPO. An event name that does not match
 * exactly is refused at push time, and `employee.update` against `employee.updated`
 * reads as a silent afternoon of nothing arriving, which is a miserable thing to
 * diagnose from the other end.
 *
 * Lives in the module rather than `shared/components`: the kit has no multi-select,
 * and adding one there is the lead's call (rule 4).
 */
export function EventPicker({ value, options, onChange, disabled }: {
  value: string[];
  options: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = search.trim();
  const chosen = new Set(value);

  const matches = useMemo(
    () => options
      .filter((option) => !chosen.has(option))
      .filter((option) => option.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 8),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, query, value.join("\0")],
  );

  /** Offer to add what was typed when it is not already a suggestion or chosen —
   *  this is what keeps a partner's own vocabulary reachable. */
  const canAdd = query.length > 0
    && !chosen.has(query)
    && !options.some((option) => option.toLowerCase() === query.toLowerCase());

  const add = (event: string) => {
    const name = event.trim();
    if (!name || chosen.has(name)) return;
    onChange([...value, name]);
    setSearch("");
    inputRef.current?.focus();
  };

  const remove = (event: string) =>
    onChange(value.filter((existing) => existing !== event));

  return (
    <div className="relative">
      <div
        className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border
                   border-line bg-content1 p-2 focus-within:border-brand"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((event) => (
          <span
            key={event}
            className="inline-flex items-center gap-1 rounded-md bg-brand/10 px-2
                       py-1 text-xs font-medium text-brand"
          >
            {event}
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove ${event}`}
                onClick={(clicked) => { clicked.stopPropagation(); remove(event); }}
                className="rounded-full p-0.5 hover:bg-brand/20"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          value={search}
          disabled={disabled}
          onChange={(changed) => { setSearch(changed.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          // Blur is delayed so a click on a suggestion lands before the list closes.
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(pressed) => {
            if (pressed.key === "Enter") {
              // Never submits the form: Enter here means "take what I typed".
              pressed.preventDefault();
              if (query) add(matches[0] && !canAdd ? matches[0] : query);
            }
            if (pressed.key === "Backspace" && !search && value.length) {
              remove(value[value.length - 1]);
            }
          }}
          placeholder={value.length ? "Add another…" : "Search or type an event name…"}
          className="min-w-40 flex-1 bg-transparent px-1 text-sm text-ink outline-none
                     placeholder:text-muted"
        />
      </div>

      {open && (matches.length > 0 || canAdd) && (
        <div
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border
                     border-line bg-content1 py-1 shadow-lg"
        >
          {canAdd && (
            <button
              type="button"
              onMouseDown={(clicked) => clicked.preventDefault()}
              onClick={() => add(query)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm
                         text-ink hover:bg-content2"
            >
              <Plus className="h-3.5 w-3.5 text-brand" />
              Add <span className="font-mono text-xs">{query}</span>
            </button>
          )}
          {matches.map((option) => (
            <button
              key={option}
              type="button"
              onMouseDown={(clicked) => clicked.preventDefault()}
              onClick={() => add(option)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm
                         text-body hover:bg-content2"
            >
              <Check className="h-3.5 w-3.5 text-muted" />
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
