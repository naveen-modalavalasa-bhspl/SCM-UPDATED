import { useQuery } from "@tanstack/react-query";
import { MapPin, Pencil, Phone, Star } from "lucide-react";
import { api } from "@/shared/api/client";
import { Card } from "@/shared/components";

interface Row {
  id: number; label: string; address: string; city?: string | null; state?: string | null;
  pincode?: string | null; contact_name?: string | null; contact_phone?: string | null; is_default: boolean;
}

/** A warehouse's shipping addresses, read-only, on its detail page (2026-11-23). */
export function ShippingAddressList({ warehouseId, onEdit }: { warehouseId: number; onEdit?: () => void }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["warehouse-addresses", warehouseId],
    queryFn: () => api.get<Row[]>(`/api/procurement/warehouse-addresses/${warehouseId}`).then((r) => r.data),
  });
  return (
    <Card className="my-4 p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-500 text-white"><MapPin className="h-4 w-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-ink">Shipping addresses</h2>
          <p className="text-xs text-muted">Where suppliers deliver. RFQs and purchase orders pick one of these.</p>
        </div>
        {onEdit && (
          <button type="button" onClick={onEdit}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-brand hover:bg-brand/5">
            <Pencil className="h-4 w-4" aria-hidden /> Edit addresses
          </button>
        )}
      </div>
      {isLoading ? <p className="text-sm text-muted">Loading…</p> : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
          No shipping address yet — an RFQ or a purchase order cannot be delivered here until one is added.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rows.map((a) => (
            <li key={a.id} className={`rounded-xl p-3.5 ring-1 ${a.is_default ? "bg-rose-50/60 ring-rose-200 dark:bg-rose-500/10" : "ring-line"}`}>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-sm font-semibold text-ink">{a.label}</span>
                {a.is_default && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-bold text-white">
                    <Star className="h-3 w-3 fill-current" aria-hidden /> Default
                  </span>
                )}
              </div>
              <p className="text-sm leading-6 text-body [overflow-wrap:anywhere]">{a.address}</p>
              {(a.city || a.pincode || a.state) && (
                <p className="text-sm text-body">{[a.city, a.pincode].filter(Boolean).join(" – ")}{a.state ? `, ${a.state}` : ""}</p>
              )}
              {(a.contact_name || a.contact_phone) && (
                <p className="mt-1 flex items-center gap-1 text-xs text-muted">
                  <Phone className="h-3 w-3" aria-hidden /> {[a.contact_name, a.contact_phone].filter(Boolean).join(" · ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
