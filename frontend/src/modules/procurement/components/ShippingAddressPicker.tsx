import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Star, Truck } from "lucide-react";
import { Field, Select } from "@/shared/components";
import { shippingAddressesApi, type ShippingAddressOption } from "../api";

/**
 * Where the goods are delivered (2026-11-23): one of the chosen warehouse's SHIPPING
 * ADDRESSES, then the address itself in a long text box the buyer may still edit for
 * a one-off instruction ("deliver to the rear gate after 4 pm").
 *
 * Opens on the warehouse's default; changing the warehouse moves to the new one's
 * default. The text box is what the document keeps and what the supplier reads — an
 * address edited on the master later never rewrites an RFQ or a PO already sent.
 */
export function ShippingAddressPicker({
  warehouseId, warehouseName, addressId, text, onChange, required = false, disabled = false,
  error, label = "Shipping address",
}: {
  warehouseId: number | "" | null | undefined;
  warehouseName?: string | null;
  addressId: number | null | undefined;
  text: string;
  onChange: (next: { addressId: number | null; text: string }) => void;
  required?: boolean;
  disabled?: boolean;
  error?: string | null;
  label?: string;
}) {
  const id = typeof warehouseId === "number" ? warehouseId : null;
  const { data: options = [], isLoading, isFetched } = useQuery({
    queryKey: ["warehouse-addresses", id],
    queryFn: () => shippingAddressesApi.forWarehouse(id!),
    enabled: id !== null,
    staleTime: 60_000,
  });

  // A document opened with an address typed by hand and no address chosen (raised
  // before shipping addresses existed): its text stands until the warehouse moves.
  const openedOn = useRef({ id, typed: !addressId && !!text.trim() });
  // A warehouse picked (or changed) with no address of its own chosen yet: its default.
  useEffect(() => {
    if (disabled || !isFetched || id === null) return;
    if (openedOn.current.typed && id === openedOn.current.id) return;
    if (addressId && options.some((o) => o.id === addressId)) return;
    const fallback = options.find((o) => o.is_default) ?? options[0];
    if (fallback) onChange({ addressId: fallback.id, text: fallback.text });
    else if (addressId) onChange({ addressId: null, text: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isFetched, options]);

  const chosen = useMemo(() => options.find((o) => o.id === addressId) ?? null, [options, addressId]);
  const edited = !!chosen && text.trim() !== chosen.text.trim();

  return (
    <div className="space-y-2" aria-label={label}>
      <Field label={`${label}${required ? " *" : ""}`} error={error ?? undefined}
             hint={id === null ? "Pick the delivery warehouse first."
               : isFetched && !options.length
                 ? `${warehouseName || "This warehouse"} has no shipping address yet — add one on Masters › Warehouses.`
                 : "The warehouse's shipping addresses. The supplier sees the one chosen."}>
        <Select
          value={addressId ? String(addressId) : ""}
          placeholder={id === null ? "Pick the warehouse first" : isLoading ? "Loading addresses…" : "Choose a shipping address"}
          isDisabled={disabled || id === null || !options.length}
          ariaLabel={label}
          options={options.map((o: ShippingAddressOption) => ({
            value: String(o.id),
            label: `${o.label}${o.is_default ? " (default)" : ""} — ${o.address}${o.city ? `, ${o.city}` : ""}`,
          }))}
          onChange={(value) => {
            const picked = options.find((o) => String(o.id) === String(value));
            onChange({ addressId: picked?.id ?? null, text: picked?.text ?? "" });
          }}
        />
      </Field>
      {(chosen || text) && (
        <div className={`rounded-xl border px-3 py-2 ${edited ? "border-warn/40 bg-warn-bg/30" : "border-line bg-content2/40"}`}>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-muted">
            <MapPin className="h-3.5 w-3.5 text-brand" aria-hidden />
            {chosen ? chosen.label : "Shipping address"}
            {chosen?.is_default && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand">
                <Star className="h-3 w-3" aria-hidden /> Default
              </span>
            )}
            {edited && <span className="text-warn">· edited for this document</span>}
            {edited && !disabled && chosen && (
              <button type="button" className="ml-auto min-h-7 rounded-md px-2 text-[11px] font-semibold text-brand hover:bg-brand/5"
                      onClick={() => onChange({ addressId: chosen.id, text: chosen.text })}>
                Restore
              </button>
            )}
          </div>
          <textarea value={text} disabled={disabled} rows={3} maxLength={1000}
                    aria-label={`${label} (as printed)`}
                    onChange={(e) => onChange({ addressId: addressId ?? null, text: e.target.value })}
                    className="w-full resize-y rounded-lg border border-line bg-content1 px-2.5 py-2 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:bg-transparent disabled:border-transparent disabled:px-0" />
          <p className="mt-1 flex items-center gap-1 text-[11px] text-muted">
            <Truck className="h-3 w-3" aria-hidden /> Printed on the document as written here.
          </p>
        </div>
      )}
    </div>
  );
}
