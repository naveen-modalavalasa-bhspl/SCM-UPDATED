import { FilterBar as SharedFilterBar, FilterMenu } from "@/shared/components";
import type { ReactNode } from "react";

/** The option shape `<Select>` takes. Declared here because the shared barrel
 *  exports the component but not its option type, and modules do not edit shared. */
export interface SelectOption {
  value: string | number;
  label: string;
  /** A short tag shown to the RIGHT of the row — a stocking point's tier, a
   *  document's type — so the tag never eats into the name's width. Folding it into
   *  the label instead is what made the stocking point list read
   *  "WH0142 — Kadapa District Store · LIP" and then run out of menu. */
  hint?: string;
  /** Fill class for a colour dot at the head of the row, so a list of statuses in
   *  the menu wears the same colours as the Status column it filters. */
  dot?: string;
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
  searchClassName,
  children,
  onReset,
  right,
  active,
}: {
  search?: string;
  onSearch?: (value: string) => void;
  placeholder?: string;
  /** Width and flex behaviour of the search box, handed straight to the shared
   *  strip. Left undefined it keeps the shared default. */
  searchClassName?: string;
  children?: ReactNode;
  onReset?: () => void;
  right?: ReactNode;
  /** Whether anything is actually narrowing the list. A "Clear" sitting there with
   *  nothing to clear is a button that does nothing, which is how a filter strip
   *  stops being trusted. Left undefined the button always shows, as it used to. */
  active?: boolean;
}) {
  return (
    <SharedFilterBar
      search={search}
      onSearch={onSearch}
      searchPlaceholder={placeholder}
      searchClassName={searchClassName}
      onClear={onReset}
      /* Warehouse screens never counted their set filters, so this is a boolean
         dressed as the shared strip's count. A caller that says nothing keeps the
         old behaviour — Clear on show whenever there is a reset to run. */
      active={onReset && (active ?? true) ? 1 : 0}
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
