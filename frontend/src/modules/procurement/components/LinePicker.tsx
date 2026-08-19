import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button, Field, Input } from "@/shared/components";
import { ItemCombobox } from "@/modules/indents/components/ItemCombobox";
import { api } from "@/shared/api/client";

/** One editable line. `rate` is optional — an RFQ asks for a price rather than
 *  stating one, so the same editor serves both with the column switched off. */
export interface DraftLine {
  id?: number | null;
  item_id: number | "";
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
}: {
  lines: DraftLine[];
  onChange: (lines: DraftLine[]) => void;
  showRate?: boolean;
  showTax?: boolean;
  showDate?: boolean;
  disabled?: boolean;
  freezeRateAndTax?: boolean;
}) {
  const [search, setSearch] = useState("");

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["procurement-items", search],
    queryFn: () =>
      api.get<{ items: MasterItem[] }>("/api/items", {
        params: { search: search || undefined, size: 50, is_active: true },
      }).then((r) => r.data.items),
  });

  const options = items.map((item) => ({
    value: item.id,
    label: item.code ? `${item.code} — ${item.name}` : item.name,
  }));

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
                options={options}
                isLoading={isLoading}
                onQueryChange={setSearch}
                isDisabled={disabled || !!line.id}
                onChange={(value) => {
                  const chosen = items.find((item) => item.id === value);
                  set(index, { item_id: value, uom_code: chosen?.uom_code ?? null });
                }}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label={index === 0 ? "Quantity" : ""} required={index === 0}>
              <Input
                type="number"
                min="0"
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
                  disabled={disabled || !!line.id || freezeRateAndTax}
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
                  disabled={disabled || !!line.id || freezeRateAndTax}
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
        </div>
      ))}

      <Button
        variant="subtle"
        disabled={disabled}
        onClick={() => onChange([...lines, blankLine()])}
      >
        Add line
      </Button>
    </div>
  );
}
