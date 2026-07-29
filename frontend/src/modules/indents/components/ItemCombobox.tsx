import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface ItemOption {
  value: number;
  label: string;
}

export function filterItemOptions(options: ItemOption[], query: string): ItemOption[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return options;
  return options.filter((option) =>
    option.label.toLocaleLowerCase().includes(needle));
}

export function ItemCombobox({
  value,
  onChange,
  options,
  onQueryChange,
  isLoading = false,
  placeholder = "Type or select an item…",
}: {
  value: number | "";
  onChange: (value: number | "") => void;
  options: ItemOption[];
  onQueryChange?: (query: string) => void;
  isLoading?: boolean;
  placeholder?: string;
}) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? "";
  const listboxId = useId();
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const filtered = useMemo(
    () => filterItemOptions(options, query === selectedLabel ? "" : query),
    [options, query, selectedLabel],
  );

  useEffect(() => {
    setQuery(selectedLabel);
  }, [selectedLabel]);

  useEffect(() => {
    if (query !== selectedLabel) onQueryChange?.(query);
  }, [onQueryChange, query, selectedLabel]);

  const select = (option: ItemOption) => {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex min-h-11 items-center rounded-xl border border-line bg-content1 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
        <input
          role="combobox"
          aria-label="Item"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => {
            setOpen(false);
            if (query !== selectedLabel) setQuery(selectedLabel);
          }, 100)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          className="h-11 min-w-0 flex-1 rounded-l-xl bg-transparent px-3 text-sm text-ink outline-none placeholder:text-muted"
        />
        <button
          type="button"
          aria-label="Toggle item options"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen((current) => !current)}
          className="grid h-11 w-11 place-items-center rounded-r-xl text-muted hover:text-body"
        >
          <ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-line bg-content1 p-1 shadow-xl"
        >
          {filtered.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(option)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                option.value === value
                  ? "bg-brand/10 font-medium text-brand"
                  : "text-body hover:bg-content2"
              }`}
            >
              {option.label}
            </button>
          ))}
          {isLoading && (
            <div className="px-3 py-4 text-center text-sm text-muted">
              Searching items...
            </div>
          )}
          {!isLoading && !filtered.length && (
            <div className="px-3 py-4 text-center text-sm text-muted">
              {query.trim() ? "No matching items" : "Type to search items"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
