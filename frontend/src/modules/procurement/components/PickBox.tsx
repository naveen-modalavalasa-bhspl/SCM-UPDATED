import { Check } from "lucide-react";

/**
 * The tick on a pick-list row — Purchase Sheets › New sheet and Requisitions › From
 * material requests (SCM_0158).
 *
 * A native checkbox at 16–20 px was the whole of the visual answer to "is this row in
 * my sheet?", and on the desktop table it did not even repaint: the table caches its
 * rows, so ticking changed the selection — the "3 selected" counter moved — while
 * every box stayed drawn empty. The pages now hand the table a `revision` built from
 * the selection (see `pickRevision`), and the tick itself is drawn large enough to be
 * read from across the desk: a filled brand square with a check, a 44 px tap target.
 *
 * Still a real `<input type="checkbox">` underneath, so the keyboard, a screen reader
 * and a label click all behave as a checkbox does.
 */
export function PickBox({ checked, onToggle, label }: {
  checked: boolean;
  onToggle: () => void;
  /** What ticking does, for a screen reader: "Include REQ-0012". */
  label: string;
}) {
  return (
    <label
      className="group inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center"
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={onToggle}
        aria-label={label}
      />
      <span
        aria-hidden
        className={`flex h-6 w-6 items-center justify-center rounded-md border-2 transition-colors duration-150
          peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 ${
          checked
            ? "border-brand bg-brand text-white shadow-sm"
            : "border-line bg-content1 text-transparent group-hover:border-brand/60"}`}
      >
        <Check className="h-4 w-4" strokeWidth={3} />
      </span>
    </label>
  );
}

/** A `revision` for `ResponsiveList` that changes whenever the selection does, so the
 *  cached desktop rows repaint their ticks (SCM_0158). Order-free: the same set picked
 *  in a different order is the same picture. */
export const pickRevision = (page: number, picked: readonly number[]) =>
  `${page}|${[...picked].sort((a, b) => a - b).join(",")}`;

/** The row's first line when it is picked — its number, in brand ink with a small
 *  "Picked" tag, so a selection is visible even where the tick column is off screen. */
export function PickedTag({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-brand-050 px-1.5 py-px align-middle text-[10px] font-semibold uppercase tracking-wide text-brand">
      <Check aria-hidden className="h-3 w-3" strokeWidth={3} /> Picked
    </span>
  );
}
