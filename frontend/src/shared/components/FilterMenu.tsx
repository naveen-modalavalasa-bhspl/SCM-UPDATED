import type { ReactNode } from "react";
import { Autocomplete, AutocompleteItem } from "@heroui/react";

/** One option in a filter list. */
export interface FilterOption {
  /** Numbers are accepted because ids are numbers; everything downstream is a
   *  string, so the value reaches `onChange` as one. */
  value: string | number;
  label: string;
  /** Optional second line — a code, a count, a warehouse's town. */
  hint?: string;
  /** The "show all" row. Picking it clears the filter. */
  reset?: boolean;
}

/**
 * THE filter control. Every dropdown that narrows a list in this app is this.
 *
 * REWRITTEN 2026-08-22, and the rewrite is the point. This used to be a hand-built
 * combobox — its own portal, its own keyboard handling, its own panel, its own
 * chrome tokens — while Logistics filtered with the shared `Select`, which is
 * HeroUI's `Autocomplete`. Two filter families in one app, and no amount of
 * matching class strings kept them together: every token nudge moved one and not
 * the other, because they were never the same component.
 *
 * So this IS that component now. Procurement, Inventory and Warehouse do not
 * imitate the Shipments filter any more, they render it. The props are unchanged,
 * so not one of the ~30 call sites had to move, and the bespoke portal/keyboard
 * code is gone rather than left to drift.
 *
 * `allowEmpty` still means what it did: some fields (a label size a render depends
 * on) must always hold a value, so the clear affordance and the reset row come off.
 */
export function FilterMenu({
  label, value, onChange, options, icon, allowEmpty = true, className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  icon?: ReactNode;
  allowEmpty?: boolean;
  className?: string;
}) {
  // The reset row is redundant next to a clear button, and actively wrong when the
  // field must always hold a value.
  const items = options.filter((option) => !option.reset);
  const selected = value === "" || value == null ? null : String(value);

  return (
    <Autocomplete
      aria-label={label}
      placeholder={label}
      variant="bordered"
      radius="md"
      defaultItems={items}
      // Only a key the list actually holds: a screen can filter from a shared URL
      // before its options have arrived, and HeroUI warns on every such render.
      selectedKey={selected !== null && items.some((o) => String(o.value) === selected) ? selected : null}
      onSelectionChange={(key) => onChange(key == null ? "" : String(key))}
      isClearable={allowEmpty}
      // No auto-icon and no bolder-than-default text: the reference control on
      // Logistics > Shipments has neither, and a funnel glyph in front of every
      // pill plus font-medium is what made these read heavier than it. A caller
      // that genuinely wants an icon can still pass one.
      startContent={icon}
      // HeroUI's base is w-full, which stacked these one per row inside the
      // filter bar's flex-wrap. Full width on a phone, a column on a laptop.
      className={`w-full sm:w-52 ${className}`}
      inputProps={{
        classNames: {
          inputWrapper: "min-h-11 h-11 border-line bg-content1 data-[hover=true]:border-ink/40 group-data-[focus=true]:border-ink",
          input: "text-sm",
        },
      }}
      // The ✕ destroys something, so it goes red under the cursor.
      clearButtonProps={{
        className: "rounded-md text-muted transition-colors data-[hover=true]:bg-bad-bg data-[hover=true]:text-bad",
      }}
      // The panel is free to be wider than the pill it hangs off. A stocking point
      // reads "LIP-14525 — AP-104-MMU-Phc Kv Peta-AP39TL9077 - LIP"; at the pill's
      // own width that is three lines of nothing legible.
      popoverProps={{ classNames: { content: "min-w-[26rem] max-w-[min(34rem,calc(100vw-2rem))] p-0" } }}
      // HeroUI virtualizes past ~50 items with a FIXED row height, and the warehouse
      // lists run to 983. A label that wrapped to a second line drew straight over
      // the row beneath it. One line per row, ellipsised, with the full text on the
      // element so hovering still reads it.
      itemHeight={40}
      listboxProps={{ itemClasses: { base: "h-10 min-h-10", title: "truncate" } }}
    >
      {(option: FilterOption) => (
        <AutocompleteItem key={String(option.value)} textValue={option.label}>
          <span className="block truncate" title={option.label}>
            {option.label}
            {option.hint && <span className="ml-2 text-xs text-muted">{option.hint}</span>}
          </span>
        </AutocompleteItem>
      )}
    </Autocomplete>
  );
}
