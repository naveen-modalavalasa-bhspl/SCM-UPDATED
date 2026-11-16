import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, RotateCcw } from "lucide-react";
import { useToast } from "@/shared/components";
import { errorMessage } from "@/shared/api/errors";
import { Button } from "./ActionButton";
import { poApi } from "../api";
import type { PurchaseOrder } from "../types";
import { AddressesTermsCards, type AddressTermKey } from "./POHeaderFields";

/**
 * A purchase order's Addresses and Terms & conditions (2026-10-26).
 *
 * Read on every order; FILLED IN, right here, while the order is a DRAFT — an order
 * raised from an award arrives complete on the money and blank on everything agreed
 * in words, and opening the whole draft form to type an address was a detour. Only
 * the six fields are sent, so nothing else on the order moves; an emptied box clears
 * its term. Past DRAFT the order is in approval or with the vendor, and a term that
 * changes after somebody signed it is a different agreement — read-only from there.
 */
const KEYS: AddressTermKey[] = ["billing_address", "shipping_address", "payment_terms",
  "delivery_terms", "material_terms", "logistics_terms"];
type Draft = Record<AddressTermKey, string> & { paymentTermId: number | "" };

const valuesOf = (po: PurchaseOrder): Draft => ({
  ...(Object.fromEntries(KEYS.map((k) => [k, (po[k] as string | null | undefined) ?? ""])) as Record<AddressTermKey, string>),
  paymentTermId: po.payment_term_id ?? "",
});

export function POAddressesTerms({ po, editable, onSaved }: {
  po: PurchaseOrder;
  editable: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => valuesOf(po));
  useEffect(() => { setDraft(valuesOf(po)); }, [po]);
  const saved = valuesOf(po);
  const dirty: string[] = [
    ...KEYS.filter((k) => draft[k].trim() !== saved[k].trim()),
    ...(String(draft.paymentTermId) !== String(saved.paymentTermId) ? ["payment_term_id"] : []),
  ];

  const save = useMutation({
    mutationFn: () => poApi.update(po.id, {
      ...Object.fromEntries(KEYS.filter((k) => dirty.includes(k)).map((k) => [k, draft[k].trim()])),
      ...(dirty.includes("payment_term_id") && draft.paymentTermId !== ""
        ? { payment_term_id: Number(draft.paymentTermId) } : {}),
    }),
    onSuccess: () => {
      toast.success(`${dirty.length} change${dirty.length === 1 ? "" : "s"} saved on the purchase order`);
      onSaved();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
      <AddressesTermsCards
        value={draft}
        onChange={(patch) => setDraft((d) => ({ ...d, ...(patch as Partial<Draft>) }))}
        editable={editable}
        orderTotal={Number(po.total_amount ?? 0)}
        changed={dirty}
        editableNote="Editable while the order is a draft"
      />

      {/* Save / Discard — only once something actually changed. */}
      {editable && dirty.length > 0 && (
        <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand/30 bg-content1/95 px-4 py-3 shadow-lg backdrop-blur">
          <span className="text-sm text-ink">
            <b>{dirty.length}</b> unsaved change{dirty.length === 1 ? "" : "s"} to addresses and terms
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setDraft(saved)} disabled={save.isPending}>
              <RotateCcw className="h-4 w-4" /> Discard
            </Button>
            <Button className="bg-brand text-white hover:bg-brand/90" onClick={() => save.mutate()}
                    disabled={save.isPending}>
              <Check className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
