import { useQuery } from "@tanstack/react-query";
import { Layers, Tag } from "lucide-react";
import { api } from "@/shared/api/client";
import { Select } from "@/shared/components";

/**
 * An item's COMBINATION — brand · variant · model (2026-10-23).
 *
 * Every transaction row names one, and a different combination is a different row.
 * Shared because every module draws it the same way. A part that is not named is not
 * drawn at all — no "—": a line with no combination simply shows the item.
 */
export interface Combination {
  brand_id?: number | null;
  brand_name?: string | null;
  variant_id?: number | null;
  variant_name?: string | null;
  model_id?: number | null;
  model_name?: string | null;
}

/** "Brand · Variant · Model", only the parts that are named; "" for none. */
export function combinationLabel(c?: Combination | null): string {
  if (!c) return "";
  return [c.brand_name, c.variant_name, c.model_name].filter(Boolean).join(" · ");
}

/** A stable key for "same combination" — rows are split on it. */
export function combinationKey(c?: Combination | null): string {
  return `${c?.brand_id || 0}-${c?.variant_id || 0}-${c?.model_id || 0}`;
}

/** The combination as quiet chips under an item name. Renders nothing when none. */
export function CombinationTag({ value, className = "" }: {
  value?: (Combination & { combination_any?: boolean | null }) | null; className?: string;
}) {
  if (value?.combination_any && !value.brand_name) {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full bg-content2 px-2 py-0.5 text-[11px] font-semibold text-muted ring-1 ring-line ${className}`}>
        <Tag className="h-3 w-3" aria-hidden /> Any brand
      </span>
    );
  }
  if (!value?.brand_name) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}
          title={combinationLabel(value)}>
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-050 px-2 py-0.5 text-[11px] font-semibold text-brand ring-1 ring-brand/20">
        <Tag className="h-3 w-3" aria-hidden /> {value.brand_name}
      </span>
      {value.variant_name && (
        <span className="inline-flex items-center gap-1 rounded-full bg-content2 px-2 py-0.5 text-[11px] font-semibold text-ink-700 ring-1 ring-line">
          <Layers className="h-3 w-3" aria-hidden /> {value.variant_name}
        </span>
      )}
      {value.model_name && (
        <span className="rounded-full bg-content2 px-2 py-0.5 text-[11px] font-semibold text-ink-700 ring-1 ring-line">
          {value.model_name}
        </span>
      )}
    </span>
  );
}

/** One combination an item offers, as `/api/item-combinations` serves it. */
export interface CombinationOption extends Combination {
  id: number;
  item_id: number;
  label: string;
  is_active: boolean;
  /** In-stock mode: what this point holds of it. */
  stock_qty?: number;
}

/** The value a line holds: a combination, or "Any" where the document allows it. */
export interface CombinationValue extends Combination {
  combination_any?: boolean;
}

const ANY = "any";

/** Each item's combinations that are ON — the "full list" (one request for all).
 *  The supplier portal passes its own vendor-scoped endpoint. */
export function useCombinationOptions(itemIds: number[],
                                      endpoint = "/api/item-combinations") {
  const ids = [...new Set(itemIds.filter(Boolean))].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["item-combinations", endpoint, ids.join(",")],
    queryFn: () => api.get<Record<string, CombinationOption[]>>(endpoint,
      { params: { item_ids: ids.join(",") } }).then((r) => r.data),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
}

/** The value a line sends for a picked option. */
export function pickCombination(option: CombinationOption | null, any = false): CombinationValue {
  if (any) {
    return { brand_id: null, variant_id: null, model_id: null, brand_name: null,
             variant_name: null, model_name: null, combination_any: true };
  }
  return {
    brand_id: option?.brand_id ?? null, variant_id: option?.variant_id ?? null,
    model_id: option?.model_id ?? null, brand_name: option?.brand_name ?? null,
    variant_name: option?.variant_name ?? null, model_name: option?.model_name ?? null,
    combination_any: false,
  };
}

/**
 * The brand / variant / model dropdown on a document line (2026-10-23).
 *
 * `options` is the full list (or, in in-stock mode, only what this point holds —
 * each option then carries its `stock_qty`). `allowAny` adds "Any" first. An item
 * with no combinations draws nothing at all. `locked` shows the carried value only.
 */
export function CombinationPicker({ options, value, onChange, allowAny = false,
                                    locked = false, uom, invalid = false, ariaLabel }: {
  options: CombinationOption[] | undefined;
  value: CombinationValue | null | undefined;
  onChange: (next: CombinationValue) => void;
  allowAny?: boolean;
  locked?: boolean;
  uom?: string | null;
  invalid?: boolean;
  ariaLabel?: string;
}) {
  if (locked) {
    if (value?.combination_any) {
      return <span className="text-xs font-semibold text-muted">Any brand</span>;
    }
    return <CombinationTag value={value} />;
  }
  if (!options?.length) return null;
  const current = value?.combination_any ? ANY
    : value?.brand_id ? String(options.find((o) =>
        (o.brand_id || 0) === (value.brand_id || 0)
        && (o.variant_id || 0) === (value.variant_id || 0)
        && (o.model_id || 0) === (value.model_id || 0))?.id ?? "") : "";
  const items = [
    ...(allowAny ? [{ value: ANY, label: "Any brand" }] : []),
    ...options.map((o) => ({
      value: String(o.id),
      label: o.stock_qty != null
        ? `${o.label} · ${o.stock_qty.toLocaleString("en-IN")}${uom ? ` ${uom}` : ""}`
        : o.label,
    })),
  ];
  return (
    <Select
      value={current}
      ariaLabel={ariaLabel ?? "Brand / variant / model"}
      placeholder="Brand · variant · model"
      options={items}
      isInvalid={invalid}
      searchable={items.length > 8}
      onChange={(v) => {
        if (v === ANY) onChange(pickCombination(null, true));
        else onChange(pickCombination(options.find((o) => String(o.id) === String(v)) ?? null));
      }}
    />
  );
}

/** In-stock options for the picker, built from rows that already carry a
 *  combination and a quantity (a point's shelf, a list of stock sources). Rows of one
 *  combination are added up; rows naming none are left out. */
export function inStockOptions(itemId: number,
                               rows: (Combination & { qty: number })[]): CombinationOption[] {
  const by = new Map<string, CombinationOption>();
  for (const row of rows) {
    if (!row.brand_id || row.qty <= 0) continue;
    const key = combinationKey(row);
    const seen = by.get(key);
    if (seen) seen.stock_qty = (seen.stock_qty ?? 0) + row.qty;
    else by.set(key, {
      id: by.size + 1, item_id: itemId, label: combinationLabel(row), is_active: true,
      brand_id: row.brand_id, variant_id: row.variant_id || null, model_id: row.model_id || null,
      brand_name: row.brand_name ?? null, variant_name: row.variant_name ?? null,
      model_name: row.model_name ?? null, stock_qty: row.qty,
    });
  }
  return [...by.values()].sort((a, b) => (b.stock_qty ?? 0) - (a.stock_qty ?? 0));
}

/** The supplier portal's source: only items this vendor deals in. */
export const SUPPLIER_COMBINATIONS = "/api/supplier/items/combinations";

/** A saved line's combination, read back into the value a form edits. */
export function comboFrom(row?: (Combination & { combination_any?: boolean | null }) | null)
  : CombinationValue | undefined {
  if (!row) return undefined;
  if (!row.brand_id && !row.combination_any) return undefined;
  return {
    brand_id: row.brand_id || null, variant_id: row.variant_id || null,
    model_id: row.model_id || null, brand_name: row.brand_name ?? null,
    variant_name: row.variant_name ?? null, model_name: row.model_name ?? null,
    combination_any: !!row.combination_any,
  };
}

/** What a line sends: the picked combination, or nothing (the server decides). */
export function comboPayload(value?: CombinationValue | null) {
  if (!value?.brand_id) return {};
  return { brand_id: value.brand_id, variant_id: value.variant_id ?? null,
           model_id: value.model_id ?? null };
}
