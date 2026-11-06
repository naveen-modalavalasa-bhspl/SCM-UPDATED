import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, Lock, Trash2 } from "lucide-react";
import { Field, Input } from "@/shared/components";
import { Button } from "./ActionButton";
import { useToast } from "@/shared/components/Toast";
import { ItemCombobox } from "@/modules/indents/components/ItemCombobox";
import { api } from "@/shared/api/client";
import { todayIst } from "@/shared/datetime";
import { ChevronRight } from "lucide-react";
import { packable, usePackOptions, type PackEntry } from "@/shared/packing";
import { PackOrderRow, levelOf, packFor } from "./PackOrderRow";
import {
  CombinationPicker, combinationKey, pickCombination, useCombinationOptions,
  type CombinationValue,
} from "@/shared/combination";

/** One editable line. `rate` is optional — an RFQ asks for a price rather than
 *  stating one, so the same editor serves both with the column switched off. */
export interface DraftLine {
  id?: number | null;
  item_id: number | "";
  /** The document's own snapshot of the chosen item. The picker only ever holds one
   *  page of the master, so a prefilled line whose item sits outside that page has
   *  no label to draw and renders blank — see `optionsFor` below. */
  item_code?: string | null;
  item_name?: string | null;
  quantity: string;
  original_quantity?: string;
  uom_code?: string | null;
  rate?: string;
  tax_percent?: string;
  required_date?: string;
  description?: string;
  /** How the line is to be packed (2026-10-08) — PO lines only. */
  pack_hierarchy_id?: number | null;
  pack_breakdown?: PackEntry[] | null;
  /** Which brand / variant / model the line buys (2026-10-23). */
  combo?: CombinationValue;
}

/** Item + combination: the same item in two combinations is two lines. */
const lineKey = (line: DraftLine) =>
  `${line.item_id}|${line.combo?.brand_id ? combinationKey(line.combo) : ""}`;

export const blankLine = (): DraftLine => ({ item_id: "", quantity: "" });

interface MasterItem {
  id: number;
  code?: string | null;
  name: string;
  uom_code?: string | null;
  tax_percent?: number | null;
}

/**
 * The item picker every procurement form shares.
 *
 * Reads the item master straight from `/api/items` and reuses the indents module's
 * `ItemCombobox` rather than growing a second one — procurement sits after indents
 * in the chain, so importing it is the allowed direction (rule 5).
 */
export function LinePicker({
  lines, onChange, showRate = false, showTax = false, showDate = true,
  disabled = false,
  freezeRateAndTax = false,
  allowRepricing = false,
  capQuantityAtOriginal = true,
  hideAddLine = false,
  vendorsByItem,
  showPacking = false,
}: {
  lines: DraftLine[];
  onChange: (lines: DraftLine[]) => void;
  showRate?: boolean;
  showTax?: boolean;
  showDate?: boolean;
  disabled?: boolean;
  freezeRateAndTax?: boolean;
  /** Rate and tax stay editable on a line that has already been saved.
   *
   *  Off everywhere else on purpose: a price on a document somebody has agreed to is
   *  not a field to be nudged. An AMENDMENT is the one place it is, because amending
   *  files the old version away, drops the order back to DRAFT and sends it up the
   *  ladder again — so a changed price is a price a signatory has to approve before
   *  it reaches the vendor, which is exactly what a rush order needs. */
  allowRepricing?: boolean;
  /** Source-backed RFQs cannot exceed their authorised quantity. Amendments are
   * re-approved, so their revised quantity stays open for the approver to decide. */
  capQuantityAtOriginal?: boolean;
  /** Amendments may revise existing quantities but cannot introduce new items. */
  hideAddLine?: boolean;
  vendorsByItem?: Record<number, { name: string; code?: string | null }[]>;
  /** Ask how each line is to be packed: hierarchy, level and how many. The quantity
   *  is then set by the packs. Only the purchase order asks this. */
  showPacking?: boolean;
}) {
  const [search, setSearch] = useState("");
  const toast = useToast();

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["procurement-items", search],
    queryFn: () =>
      api.get<{ items: MasterItem[] }>("/api/items", {
        params: { search: search || undefined, size: 50, is_active: true },
      }).then((r) => r.data.items),
  });

  const label = (code: string | null | undefined, name: string | null | undefined) =>
    code ? `${code} — ${name ?? ""}`.trim() : name ?? "";

  const options = items.map((item) => ({
    value: item.id,
    label: label(item.code, item.name),
  }));

  /** The loaded page, plus the line's own item where that page does not hold it.
   *  `/api/items` is fetched 50 rows at a time, so a requisition line pointing at
   *  item 80 of 87 found nothing to render and the box came up empty — the value was
   *  saved and sent correctly all along. Same seeding OrgFields does for warehouses.
   *
   *  An item already on ANOTHER line is greyed out rather than left looking available
   *  (2026-09-07). Picking it was already refused, but only after the press, by a
   *  toast — so the list showed a choice, took the click, and then said no. The rule
   *  was invisible until you broke it. `ItemCombobox` already draws a disabled option
   *  at half opacity and routes the press to `onDisabledSelect`, so the same toast
   *  still explains WHY; it is now the second line of defence rather than the first.
   *  The line's own item stays selectable — that is the value it is showing. */
  const comboOptions = useCombinationOptions(lines.map((line) => Number(line.item_id) || 0));
  const combosOf = (itemId: number | "") =>
    itemId === "" ? [] : comboOptions.data?.[String(itemId)] ?? [];

  const optionsFor = (line: DraftLine) => {
    // An item with brand / variant / model combinations stays pickable: another line
    // of it is another combination (2026-10-23).
    const takenElsewhere = new Set(
      lines.filter((other) => other !== line && other.item_id !== ""
                              && !combosOf(other.item_id).length)
        .map((other) => other.item_id),
    );
    const withSeed =
      line.item_id !== "" && !items.some((item) => item.id === line.item_id)
        ? [{ value: line.item_id,
             label: label(line.item_code, line.item_name) || "Selected item" },
           ...options]
        : options;
    return withSeed.map((option) =>
      takenElsewhere.has(option.value) ? { ...option, isDisabled: true } : option);
  };

  const packOptions = usePackOptions(
    lines.map((line) => Number(line.item_id)).filter(Boolean), showPacking);

  const set = (index: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  /** A new quantity on a packed line re-describes it in the same hierarchy and level
   *  (2026-10-11): the quantity is the person's, the packs only say how it travels. */
  const setQuantity = (index: number, quantity: string) => {
    const line = lines[index];
    const h = packable(packOptions.data?.[Number(line.item_id)])
      .find((row) => row.hierarchy_id === line.pack_hierarchy_id);
    if (!showPacking || !h) {
      set(index, { quantity });
      return;
    }
    set(index, { quantity,
                 pack_breakdown: packFor(h, levelOf(h, line.pack_breakdown), Number(quantity) || 0) });
  };

  const remove = (index: number) =>
    onChange(lines.length === 1 ? [blankLine()] : lines.filter((_, i) => i !== index));

  return (
    <div className="space-y-3">
      {lines.map((line, index) => (
        <div
          key={index}
          className="grid grid-cols-1 gap-3 rounded-xl border border-line p-3 sm:grid-cols-12"
        >
          <div className={showTax ? "sm:col-span-4" : showRate ? "sm:col-span-5" : "sm:col-span-6"}>
            <Field label={index === 0 ? "Item" : ""} required={index === 0}>
              <ItemCombobox
                value={line.item_id}
                options={optionsFor(line)}
                isLoading={isLoading}
                onQueryChange={setSearch}
                isDisabled={disabled || !!line.id}
                // Pressing a greyed-out row says why rather than doing nothing at all.
                onDisabledSelect={() =>
                  toast.error("This item is already in the list. Change its quantity instead of adding it again.")}
                onChange={(value) => {
                  // Kept as the backstop: the greying is computed from `lines`, and a
                  // duplicate could still arrive from a prefill or a stale render.
                  const combos = combosOf(value);
                  const taken = new Set(lines.filter((l, i) => i !== index && l.item_id === value)
                    .map(lineKey));
                  if (taken.size && !combos.length) {
                    toast.error("This item is already in the list. Change its quantity instead of adding it again.");
                    return;
                  }
                  // A second line of the item starts on a combination not yet taken.
                  const free = taken.size
                    ? combos.find((o) => !taken.has(`${value}|${combinationKey(o)}`))
                    : undefined;
                  const chosen = items.find((item) => item.id === value);
                  set(index, {
                    combo: free ? pickCombination(free) : undefined,
                    item_id: value,
                    uom_code: chosen?.uom_code ?? null,
                    item_code: chosen?.code ?? null,
                    item_name: chosen?.name ?? null,
                    // Only when the master actually states one. A null there means
                    // nobody has classified the item, and filling 0 would put an
                    // exempt rate on the line without anybody deciding it.
                    ...(chosen?.tax_percent != null
                      ? { tax_percent: String(chosen.tax_percent) }
                      : {}),
                  });
                }}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label={index === 0 ? "Quantity" : ""} required={index === 0}>
              <Input
                type="number"
                data-uom={line.uom_code ?? ""}
                min="0"
                max={capQuantityAtOriginal ? line.original_quantity : undefined}
                step="0.001"
                value={line.quantity}
                // The quantity is always the person's; on a packed line the packs
                // below follow it (2026-10-11).
                disabled={disabled}
                isInvalid={overCap(line)}
                onChange={(e) => setQuantity(index, e.target.value)}
              />
              <CapHint line={line} on={capQuantityAtOriginal} />
            </Field>
          </div>
          {showRate && (
            <div className="sm:col-span-2">
              {/* "Rate", not "Est. rate": the only screen that still shows this column
                * is the purchase order, where the number is an agreed price rather
                * than a guess. */}
              <Field label={index === 0 ? "Rate" : ""}>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={line.rate ?? ""}
                  disabled={disabled || (!allowRepricing && (!!line.id || freezeRateAndTax))}
                  onChange={(e) => set(index, { rate: e.target.value })}
                />
              </Field>
            </div>
          )}
          {showTax && (
            <div className="sm:col-span-2">
              <Field label={index === 0 ? "Tax %" : ""}>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={line.tax_percent ?? ""}
                  disabled={disabled || (!allowRepricing && (!!line.id || freezeRateAndTax))}
                  onChange={(e) => set(index, { tax_percent: e.target.value })}
                />
              </Field>
            </div>
          )}
          {showDate && (
            <div className={showRate ? "sm:col-span-2" : "sm:col-span-3"}>
              <Field label={index === 0 ? "Needed by" : ""}>
                <Input
                  type="date"
                  // Only on a line still being drafted: an existing line is disabled
                  // anyway, and a saved date that has since passed must keep showing
                  // the date it was given rather than being cleared by the picker.
                  min={line.id ? undefined : todayIst()}
                  value={line.required_date ?? ""}
                  disabled={disabled || !!line.id}
                  onChange={(e) => set(index, { required_date: e.target.value })}
                />
              </Field>
            </div>
          )}
          <div className="flex items-end sm:col-span-1">
            <button
              type="button"
              onClick={() => remove(index)}
              disabled={disabled || !!line.id}
              aria-label={`Remove line ${index + 1}`}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          
          {combosOf(line.item_id).length > 0 && (
            <div className="sm:col-span-6">
              <Field label="Brand · variant · model">
                <CombinationPicker
                  options={combosOf(line.item_id)}
                  value={line.combo}
                  locked={disabled}
                  invalid={lines.some((other) => other !== line && other.item_id === line.item_id
                                                 && lineKey(other) === lineKey(line))}
                  ariaLabel={`Brand, variant and model for line ${index + 1}`}
                  onChange={(combo) => set(index, { combo })}
                />
              </Field>
            </div>
          )}

          {showPacking && line.item_id !== ""
            && packable(packOptions.data?.[Number(line.item_id)]).length > 0 && (
            <div className="sm:col-span-12">
              <PackOrderRow
                hierarchies={packable(packOptions.data?.[Number(line.item_id)])}
                hierarchyId={line.pack_hierarchy_id}
                breakdown={line.pack_breakdown}
                quantity={line.quantity}
                uom={line.uom_code}
                disabled={disabled}
                onChange={(patch) => set(index, patch)}
              />
            </div>
          )}

          {vendorsByItem && line.item_id !== "" && (
            <div className="sm:col-span-12">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-brand hover:underline [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                  Mapped Suppliers ({vendorsByItem[line.item_id as number]?.length || 0})
                </summary>
                <div className="mt-2 pl-5 text-sm text-muted">
                  {vendorsByItem[line.item_id as number]?.length > 0 ? (
                    <ul className="list-inside list-disc space-y-1">
                      {vendorsByItem[line.item_id as number].map((v, i) => (
                        <li key={i}>
                          {v.name} {v.code ? `(${v.code})` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No mapped suppliers.</p>
                  )}
                </div>
              </details>
            </div>
          )}
        </div>
      ))}

      {!hideAddLine && (
        <Button
          variant="subtle"
          disabled={disabled}
          onClick={() => onChange([...lines, blankLine()])}
        >
          Add line
        </Button>
      )}
    </div>
  );
}


/** A line with a ceiling (2026-11-03): what it asked for, which a later edit may
 *  lower or leave, never raise. True when the typed quantity goes past it. */
export function overCap(line: DraftLine, on = true): boolean {
  if (!on || line.original_quantity == null || line.original_quantity === "") return false;
  return Number(line.quantity) > Number(line.original_quantity);
}

function CapHint({ line, on }: { line: DraftLine; on: boolean }) {
  if (!on || line.original_quantity == null || line.original_quantity === "") return null;
  const cap = Number(line.original_quantity);
  const now = Number(line.quantity);
  const fmt = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
  if (now > cap) {
    return <p className="mt-1 text-[11px] text-danger">Only {fmt(cap)} {line.uom_code ?? ""} was asked for — lower it or leave it.</p>;
  }
  if (line.quantity !== "" && now < cap) {
    return (
      <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
        <ArrowDown className="h-3 w-3" /> {fmt(Math.round((cap - now) * 1000) / 1000)} less than asked
      </p>
    );
  }
  return (
    <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted">
      <Lock className="h-3 w-3" /> Up to {fmt(cap)} · can only be lowered
    </p>
  );
}
