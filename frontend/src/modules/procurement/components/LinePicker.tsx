import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Field, Input } from "@/shared/components";
import { Button } from "./ActionButton";
import { useToast } from "@/shared/components/Toast";
import { ItemCombobox } from "@/modules/indents/components/ItemCombobox";
import { api } from "@/shared/api/client";
import { todayIst } from "@/shared/datetime";
import { ChevronRight } from "lucide-react";

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
}

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
  const optionsFor = (line: DraftLine) => {
    const takenElsewhere = new Set(
      lines.filter((other) => other !== line && other.item_id !== "")
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

  const set = (index: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

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
                  toast.error("Item already exists, just update the quantity.")}
                onChange={(value) => {
                  // Kept as the backstop: the greying is computed from `lines`, and a
                  // duplicate could still arrive from a prefill or a stale render.
                  if (lines.some((l, i) => i !== index && l.item_id === value)) {
                    toast.error("Item already exists, just update the quantity.");
                    return;
                  }
                  const chosen = items.find((item) => item.id === value);
                  set(index, {
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
                min="0"
                max={capQuantityAtOriginal ? line.original_quantity : undefined}
                step="0.001"
                value={line.quantity}
                disabled={disabled}
                onChange={(e) => set(index, { quantity: e.target.value })}
              />
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
