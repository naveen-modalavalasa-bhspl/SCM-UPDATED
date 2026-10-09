import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface ItemOption {
  value: number;
  label: string;
  isDisabled?: boolean;
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
  onDisabledSelect,
  isLoading = false,
  isInvalid = false,
  isDisabled = false,
  errorId,
  placeholder = "Type or select an item…",
}: {
  value: number | "";
  onChange: (value: number | "") => void;
  options: ItemOption[];
  onQueryChange?: (query: string) => void;
  onDisabledSelect?: (value: number) => void;
  isLoading?: boolean;
  isInvalid?: boolean;
  isDisabled?: boolean;
  errorId?: string;
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
    if (option.isDisabled) {
      onDisabledSelect?.(option.value);
      setQuery(selectedLabel);
      setOpen(false);
      return;
    }
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className={`flex min-h-11 items-center rounded-xl border bg-content1 focus-within:ring-2 ${
        isInvalid
          ? "border-bad focus-within:border-bad focus-within:ring-bad/20"
          : "border-line focus-within:border-brand focus-within:ring-brand/20"
      }`}>
        <input
          role="combobox"
          aria-label="Item"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-invalid={isInvalid || undefined}
          aria-describedby={isInvalid ? errorId : undefined}
          value={query}
          placeholder={placeholder}
          disabled={isDisabled}
          onFocus={() => { if (!isDisabled) setOpen(true); }}
          onBlur={() => window.setTimeout(() => {
            setOpen(false);
            if (query !== selectedLabel) setQuery(selectedLabel);
          }, 100)}
          onChange={(event) => {
            if (isDisabled) return;
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            if (nextQuery === "" && value !== "") onChange("");
            setOpen(true);
          }}
          className="h-11 min-w-0 flex-1 rounded-l-xl bg-transparent px-3 text-sm text-ink outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          aria-label="Toggle item options"
          disabled={isDisabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen((current) => !current)}
          className="grid h-11 w-11 place-items-center rounded-r-xl text-muted hover:text-body disabled:cursor-not-allowed disabled:opacity-50"
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
              aria-disabled={option.isDisabled || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(option)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                option.isDisabled
                  ? "cursor-not-allowed text-muted opacity-50"
                  : option.value === value
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
