import {
  FilterBar as SharedFilterBar,
  FilterMenu,
  FilterToggle,
  type FilterOption,
} from "@/shared/components";

/* Re-exported so inventory screens keep their single filter import, and so this file
 * stays the module's one filter door even though the controls themselves now live in
 * the shared kit (2026-08-22 — see shared/components/FilterBar.tsx for why three
 * copies of this strip became one). */
export { FilterMenu, FilterToggle };
export type { FilterOption };

/**
 * One filter row, same shape on every inventory screen.
 *
 * Screens used to scatter search boxes, toggles and buttons across three rows above
 * the table, so no two looked alike and the page read as crowded. Everything that
 * narrows the list goes in here; everything that creates a document goes in the
 * PageHeader actions. Nothing else sits between the header and the table.
 *
 * A wrapper, not a copy: inventory's prop names (`searchPlaceholder`, `active`) are
 * kept exactly as they were so not one of the fourteen screens under it had to change.
 *
 * NO module-local chrome (2026-08-22). Inventory used to lift the bar onto its own
 * elevated card — its own radius, its own shadow — and add a shadow to every pill.
 * That is precisely why inventory's filters did not look like anybody else's: the
 * shared bar had a design and this file quietly overrode it. The look now comes from
 * `shared/components/filterChrome` for every module at once, and this file is back to
 * what it was for: keeping inventory's prop names so none of its fourteen screens
 * had to change.
 */
export const FilterBar = SharedFilterBar;

/** Compact filter, sized to sit in the filter bar.
 *
 * The shared pill: a labelled button that opens a searchable list, with an icon chosen
 * from its own label. It was a bare combobox input, so a screen with four filters read
 * as four empty text boxes and you could not tell at a glance which of them were
 * narrowing the list. Same props as before, so every caller gained the design without
 * a change — and, since 2026-08-22, gained typing straight into the pill as well.
 *
 * `allowEmpty` is honoured by keeping the "show all" row off: some fields (a label size
 * a render depends on) must always hold a value, and a blank option let a caller land
 * on "" and crash on a lookup that assumed one of `options` was selected.
 */
export function FilterSelect({
  value, onChange, options, placeholder, allowEmpty = true,
}: {
  value: string;
  onChange: (v: string) => void;
  options: FilterOption[];
  placeholder: string;
  allowEmpty?: boolean;
}) {
  return (
    <FilterMenu
      label={placeholder}
      value={value}
      onChange={onChange}
      options={options}
      allowEmpty={allowEmpty}
    />
  );
}

/** Kept as a name so the screens that import it still resolve; it is the shared
 *  pill now, with nothing added. */
export const PremiumFilterMenu = FilterMenu;
