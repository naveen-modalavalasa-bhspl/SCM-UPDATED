import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Warehouse } from "lucide-react";
import { Field } from "@/shared/components";
import { ItemCombobox } from "@/modules/indents/components/ItemCombobox";
import { api } from "@/shared/api/client";
import { ShippingAddressPicker } from "./ShippingAddressPicker";

interface NamedRow { id: number; code?: string | null; name: string }

export interface DeliverToValue {
  warehouseId: number | "";
  warehouseName: string;
  shippingAddressId: number | null;
  shipping_address: string;
}

/**
 * Where a purchase order is delivered (2026-11-23): the warehouse, then one of ITS
 * shipping addresses, then the address as the order prints it.
 *
 * Asked on a hand-raised order (required) and on a DRAFT order, where an order written
 * off an RFQ arrives with the RFQ's address already chosen and the buyer may still move
 * it before anybody signs. Past DRAFT the card only reads.
 */
export function PODeliverTo({ value, onChange, disabled = false, required = false, showInvalid = false }: {
  value: DeliverToValue;
  onChange: (patch: Partial<DeliverToValue>) => void;
  disabled?: boolean;
  required?: boolean;
  showInvalid?: boolean;
}) {
  const [query, setQuery] = useState("");
  const { data: warehouses = [], isLoading } = useQuery({
    queryKey: ["org-warehouses", query],
    enabled: !disabled,
    queryFn: () =>
      api.get<{ items: NamedRow[] }>("/api/warehouses", {
        params: { search: query || undefined, size: 50, is_active: true, kind: "SHIPMENT_ADDRESS" },
      }).then((r) => r.data.items),
  });
  // The chosen warehouse may not be on this page of results — keep its option drawn.
  const selected = warehouses.find((w) => w.id === value.warehouseId);
  const options = [
    ...(value.warehouseId !== "" && !selected
      ? [{ value: value.warehouseId, label: value.warehouseName || "Selected warehouse" }] : []),
    ...warehouses.map((w) => ({ value: w.id, label: w.code ? `${w.code} — ${w.name}` : w.name })),
  ];
  const missingWarehouse = required && showInvalid && value.warehouseId === "";
  const missingAddress = required && showInvalid && !value.shipping_address.trim();

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl bg-white p-3.5 ring-1 ring-rose-100 dark:bg-content1">
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-rose-700/80">
        <Warehouse className="h-3.5 w-3.5" aria-hidden /> Deliver to{required ? " *" : ""}
      </div>
      {disabled ? (
        <p className="text-sm font-semibold text-ink">{value.warehouseName || "No warehouse stated"}</p>
      ) : (
        <Field label={`Delivery warehouse${required ? " *" : ""}`}
               error={missingWarehouse ? "Pick the warehouse the goods are delivered to." : undefined}
               hint="Warehouses only — its shipping addresses are offered below.">
          <ItemCombobox
            value={value.warehouseId}
            options={options}
            isLoading={isLoading}
            onQueryChange={setQuery}
            onChange={(v) => {
              const id = v === "" ? "" : Number(v);
              const row = warehouses.find((w) => w.id === id);
              onChange({
                warehouseId: id,
                warehouseName: row ? (row.code ? `${row.code} — ${row.name}` : row.name) : "",
                ...(id !== value.warehouseId ? { shippingAddressId: null } : {}),
              });
            }}
            placeholder="Search warehouses…"
          />
        </Field>
      )}
      <ShippingAddressPicker
        warehouseId={value.warehouseId} warehouseName={value.warehouseName}
        addressId={value.shippingAddressId} text={value.shipping_address}
        required={required} disabled={disabled}
        error={missingAddress ? "Choose one of the warehouse's shipping addresses." : null}
        onChange={({ addressId, text }) => onChange({ shippingAddressId: addressId, shipping_address: text })} />
    </div>
  );
}
