import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/shared/components";
import { ItemCombobox } from "@/modules/indents/components/ItemCombobox";
import type { MyStockRow, ReturnLineWrite } from "../types";

/**
 * The LINE ITEMS card — the same Item / Qty / delete row the indent form uses, and the
 * same combobox control, so the two screens are one screen with different data behind
 * them. `ItemCombobox` is imported rather than copied: returns sits after indents in
 * the import chain (CLAUDE.md rule 5), so this direction is allowed, and a copy would
 * be the thing that eventually looks different.
 *
 * The picker only ever offers what the raiser is actually holding, summed per item
 * across bins and batches. A storekeeper does not think in balance slices — they think
 * "I have 50 of these" — and the backend walks the lots itself at approval.
 */
export const BLANK_LINE: ReturnLineWrite = { item_id: 0, quantity: "", remarks: "" };

const num = (value: string | number | null | undefined) => Number(value ?? 0);

/**
 * UoMs that cannot be split. Half a box is not a thing anybody can put on a shelf, so
 * the quantity box steps in whole units and refuses a decimal outright rather than
 * accepting 2.5 and letting the backend round it to something the returner never typed.
 */
const WHOLE_UNIT_UOMS = new Set([
  "NOS", "NO", "NUM", "EA", "EACH", "PCS", "PC", "PIECE", "UNIT", "UNITS",
  "PACK", "PKT", "PACKET", "BOX", "BOXES", "CTN", "CARTON", "BAG", "BAGS",
  "BTL", "BOTTLE", "TUBE", "VIAL", "AMP", "STRIP", "ROLL", "SET", "PAIR", "DOZ",
]);

export function isWholeUnit(uom: string | null | undefined) {
  return WHOLE_UNIT_UOMS.has(String(uom ?? "").trim().toUpperCase());
}

export function holdingFor(stock: MyStockRow[], itemId: number) {
  const rows = stock.filter((row) => row.item_id === itemId);
  if (rows.length === 0) return null;
  return {
    quantity: rows.reduce((running, row) => running + num(row.available_qty), 0),
    uom: rows[0].uom_code ?? "",
  };
}

export function ReturnLinesEditor({
  lines,
  onChange,
  stock,
  disabled = false,
}: {
  lines: ReturnLineWrite[];
  onChange: (lines: ReturnLineWrite[]) => void;
  stock: MyStockRow[];
  disabled?: boolean;
}) {
  // Which line last tried to pick an item that was already taken. Cleared on the next
  // successful pick, so the warning does not outlive the mistake.
  const [warnedAt, setWarnedAt] = useState<number | null>(null);
  const setDuplicateWarning = (index: number) => setWarnedAt(index);

  const options = Array.from(
    new Map(
      stock.map((row) => [
        row.item_id,
        {
          value: row.item_id,
          label: `${row.item_name ?? "—"}${row.item_code ? ` (${row.item_code})` : ""}`,
        },
      ]),
    ).values(),
  );

  const patch = (index: number, changes: Partial<ReturnLineWrite>) =>
    onChange(lines.map((line, at) => (at === index ? { ...line, ...changes } : line)));

  /** Items already on another line — offered greyed out rather than hidden, so the
   * returner can see the item exists and understand why it cannot be picked twice. */
  const takenElsewhere = (index: number) =>
    new Set(
      lines
        .filter((line, at) => at !== index && line.item_id)
        .map((line) => line.item_id),
    );

  const remove = (index: number) =>
    // Never down to zero rows: an empty card gives the raiser nothing to type into and
    // no obvious way back, so the last line is emptied instead of dropped.
    onChange(lines.length > 1 ? lines.filter((_line, at) => at !== index) : [{ ...BLANK_LINE }]);

  return (
    <div>
      <div className="mb-2 hidden gap-3 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted sm:grid sm:grid-cols-[1fr_10rem_2.75rem]">
        <span>Item</span>
        <span>Qty</span>
        <span className="sr-only">Remove</span>
      </div>

      <ul className="space-y-3">
        {lines.map((line, index) => {
          const holding = line.item_id ? holdingFor(stock, line.item_id) : null;
          const wanted = num(line.quantity);
          const over = holding !== null && wanted > holding.quantity;
          const taken = takenElsewhere(index);
          const duplicate = Boolean(line.item_id) && taken.has(line.item_id);
          const whole = isWholeUnit(holding?.uom);
          const fractional = whole && Number.isFinite(wanted) && !Number.isInteger(wanted);

          return (
            <li key={index} className="grid gap-3 sm:grid-cols-[1fr_10rem_2.75rem]">
              <div>
                <ItemCombobox
                  value={line.item_id || ""}
                  onChange={(value) => patch(index, { item_id: Number(value) || 0 })}
                  options={options.map((option) => ({
                    ...option,
                    isDisabled: taken.has(option.value),
                  }))}
                  onDisabledSelect={() => setDuplicateWarning(index)}
                  isInvalid={duplicate}
                  placeholder="Type item code or name…"
                />
                {duplicate || warnedAt === index ? (
                  <p className="mt-1 text-xs text-bad">
                    That item is already on another line — change the quantity there
                    instead.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    {holding
                      ? `You are holding ${holding.quantity.toLocaleString()} ${holding.uom}`.trim()
                      : "Pick an item to see what you are holding"}
                  </p>
                )}
              </div>

              <div>
                <Input
                  type="number"
                  min="0"
                  // The shelf quantity is the ceiling: the browser's own number input
                  // then refuses the spinner past it, before any typing is validated.
                  max={holding ? String(holding.quantity) : undefined}
                  step={whole ? "1" : "0.001"}
                  value={line.quantity}
                  onChange={(event) => {
                    const typed = event.target.value;
                    // A whole-unit item never accepts a separator at all, so the field
                    // cannot even hold "2." on the way to "2.5".
                    if (whole && /[.,]/.test(typed)) return;
                    patch(index, { quantity: typed });
                  }}
                  disabled={disabled}
                  isInvalid={over || fractional || wanted < 0}
                  placeholder="—"
                  aria-label={`Quantity for line ${index + 1}`}
                />
                {over && holding && (
                  <p className="mt-1 text-xs text-bad">
                    Only {holding.quantity.toLocaleString()} {holding.uom} is on the shelf
                  </p>
                )}
                {!over && fractional && (
                  <p className="mt-1 text-xs text-bad">
                    {holding?.uom} comes in whole units
                  </p>
                )}
                {!over && !fractional && wanted < 0 && (
                  <p className="mt-1 text-xs text-bad">Quantity cannot be negative</p>
                )}
              </div>

              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={`Remove line ${index + 1}`}
                  className="grid h-11 w-11 place-items-center rounded-lg text-muted transition-colors hover:bg-bad-bg hover:text-bad"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {!disabled && (
        <button
          type="button"
          onClick={() => onChange([...lines, { ...BLANK_LINE }])}
          className="mt-3 inline-flex min-h-11 items-center gap-2 px-1 text-sm font-semibold text-brand"
        >
          <Plus className="h-4 w-4" /> Add line
        </button>
      )}
    </div>
  );
}
