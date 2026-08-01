import { Select } from "./compat";
import type { ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Button, Card } from "@/shared/components";

/** The option shape `<Select>` takes. Declared here because the shared barrel
 *  exports the component but not its option type, and modules do not edit shared. */
export interface SelectOption {
  value: string | number;
  label: string;
}

/**
 * The filter strip every warehouse list screen sits under.
 *
 * Local to the module on purpose: it is composition over the shared kit, not a new
 * primitive. Inventory has its own for the same reason — the shared layer owns the
 * controls, a module owns how it arranges them.
 */

export function FilterBar({
  search,
  onSearch,
  placeholder = "Search…",
  children,
  onReset,
}: {
  search?: string;
  onSearch?: (value: string) => void;
  placeholder?: string;
  children?: ReactNode;
  onReset?: () => void;
}) {
  return (
    <Card className="mb-4 p-3">
      <div className="flex flex-wrap items-end gap-2">
        {onSearch && (
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={search ?? ""}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={placeholder}
              aria-label={placeholder}
              className="min-h-11 w-full rounded-md border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
            />
          </label>
        )}
        {children}
        {onReset && (
          <Button variant="ghost" onClick={onReset}>
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
      </div>
    </Card>
  );
}

/** A filter dropdown sized for the strip, with a built-in "all" row. */
export function FilterSelect({
  value,
  onChange,
  options,
  label,
  allLabel = "All",
  className = "min-w-[170px]",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  allLabel?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Select
        value={value}
        onChange={onChange}
        ariaLabel={label}
        placeholder={label}
        options={[{ value: "", label: allLabel }, ...options]}
      />
    </div>
  );
}
