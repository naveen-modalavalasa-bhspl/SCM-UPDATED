import { FilterBar as SharedFilterBar, FilterMenu } from "@/shared/components";
import type { ReactNode } from "react";

/** The option shape `<Select>` takes. Declared here because the shared barrel
 *  exports the component but not its option type, and modules do not edit shared. */
export interface SelectOption {
  value: string | number;
  label: string;
}

/**
 * The filter strip every warehouse list screen sits under.
 *
 * A wrapper over the shared strip since 2026-08-22, keeping this module's prop names
 * (`placeholder`, `onReset`) so none of its fifteen screens had to change. It used to
 * be a local composition; the three modules' compositions had drifted into three
 * different heights and three different search boxes, which is exactly the kind of
 * thing a shared kit exists to stop.
 */
export function FilterBar({
  search,
  onSearch,
  placeholder = "Search…",
  children,
  onReset,
  right,
}: {
  search?: string;
  onSearch?: (value: string) => void;
  placeholder?: string;
  children?: ReactNode;
  onReset?: () => void;
  right?: ReactNode;
}) {
  return (
    <SharedFilterBar
      search={search}
      onSearch={onSearch}
      searchPlaceholder={placeholder}
      onClear={onReset}
      /* Warehouse screens never counted their set filters, and Clear has always been
         on show here whether or not anything is set. `active={1}` keeps that. */
      active={onReset ? 1 : 0}
      right={right}
    >
      {children}
    </SharedFilterBar>
  );
}

/** A filter dropdown sized for the strip, with a built-in "show all" row. */
export function FilterSelect({
  value,
  onChange,
  options,
  label,
  allLabel = "All",
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  allLabel?: string;
  className?: string;
}) {
  // The shared pill, not a bare <Select>: a warehouse list carries four or five of
  // these and a row of unlabelled dropdowns gives no clue which ones are narrowing the
  // page. The pill reads "Status" until something is picked and then reads the pick,
  // and its icon comes from the label. `allLabel` is kept in the signature so no caller
  // breaks; the pill writes its own "Show all" row.
  void allLabel;
  return (
    <FilterMenu label={label} value={value} onChange={onChange} options={options} className={className} />
  );
}
