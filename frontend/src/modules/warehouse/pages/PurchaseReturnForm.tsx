import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  TONE_DEEP_MINT,
  TONE_MINT,
  TONE_PINK,
} from "@/shared/components";
import {
  createReturn,
  getReturn,
  purchaseReturnReasons,
  purchaseReturnSourceDetail,
  purchaseReturnSourceOptions,
  sendPurchaseReturnToVendor,
  updateReturn,
} from "../api";
import type { PurchaseReturnSourceDetail } from "../types";

/**
 * Warehouse → Vendor Purchase Return — the Storekeeper's single screen.
 *
 * Flow per spec:
 *   Select Item / Indent / Purchase Transaction
 *     → auto-fetch Vendor (name/code/contact/email/address)
 *     → auto-fetch Item (code/name/batch/UOM/warehouse/PO/indent/GRN)
 *     → auto-fetch Purchase (original / previously returned / returnable)
 *   Enter Return Quantity → validated ≤ returnable
 *   Select Return Reason → required, "Other" needs remarks
 *   Review → [Send to Vendor] → Existing Logistics → Vendor → Completed
 *
 * No manual vendor typing, no duplicate master, no new logistics module.
 * The shipment is the existing `out_dispatches` VENDOR_RETURN.
 */
export default function PurchaseReturnForm() {
  const { id } = useParams<{ id: string }>();
  const existingId = id ? Number(id) : null;
  const navigate = useNavigate();
  const qc = useQueryClient();

  // --- source picker ---
  const [pickedSource, setPickedSource] = useState<{ type: string; id: number } | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);

  // form state
  const [returnQty, setReturnQty] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [remarks, setRemarks] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // queries — fail-fast so the form renders even if the new source-options API is slow
  const { data: sourcePage } = useQuery({
    queryKey: ["warehouse", "purchase-return", "source-options"],
    queryFn: () => purchaseReturnSourceOptions({ size: 50 }),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: reasons = [] } = useQuery({
    queryKey: ["warehouse", "purchase-return", "reasons"],
    queryFn: purchaseReturnReasons,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: existing } = useQuery({
    queryKey: ["warehouse", "purchase-return", existingId],
    queryFn: () => getReturn(existingId as number),
    enabled: existingId !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: detail } = useQuery<PurchaseReturnSourceDetail>({
    queryKey: ["warehouse", "purchase-return", "source-detail", pickedSource, selectedItemId],
    queryFn: () =>
      purchaseReturnSourceDetail(pickedSource!.type, pickedSource!.id, selectedItemId ?? undefined),
    enabled: pickedSource !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // hydrate from existing return
  useEffect(() => {
    if (!existing) return;
    setReason(existing.reason ?? "");
    setRemarks(existing.remarks ?? "");
    // try to pick source from existing linkage
    if (existing.grn_id) setPickedSource({ type: "GRN", id: existing.grn_id });
    else if (existing.po_id) setPickedSource({ type: "PO", id: existing.po_id });
    // quantities
    if (existing.items && existing.items[0]) {
      setSelectedItemId(existing.items[0].item_id);
      setReturnQty(String(existing.items[0].quantity ?? ""));
    }
  }, [existing]);

  // reset qty when source changes
  const pickSource = (val: string) => {
    if (!val) {
      setPickedSource(null);
      setSelectedItemId(null);
      setReturnQty("");
      return;
    }
    const [type, sid] = val.split(":");
    setPickedSource({ type, id: Number(sid) });
    setSelectedItemId(null);
    setReturnQty("");
    setError(null);
  };

  // derived auto-fetched blocks
  const vendor = detail?.vendor;
  const purchase = detail?.purchase;
  const items = detail?.items ?? [];
  // when multiple items, let picker choose one; otherwise use the single
  const activeItem = useMemo(() => {
    if (!items.length) return null;
    if (selectedItemId) return items.find((it) => it.item_id === selectedItemId) ?? items[0];
    return items[0];
  }, [items, selectedItemId]);

  const returnable = activeItem ? Number(activeItem.returnable_qty) : 0;
  const original = activeItem ? Number(activeItem.original_qty) : 0;
  const previously = activeItem ? Number(activeItem.previously_returned) : 0;
  const qtyNum = Number(returnQty);

  const qtyError = useMemo(() => {
    if (!returnQty) return null;
    if (Number.isNaN(qtyNum) || qtyNum <= 0) return "Enter a positive quantity";
    if (returnable > 0 && qtyNum > returnable)
      return `Return quantity cannot exceed the available returnable quantity of ${returnable}.`;
    return null;
  }, [returnQty, qtyNum, returnable]);

  const remarksRequired = reason === "OTHER" && !remarks.trim();
  const canSave = !!pickedSource && !!activeItem && !qtyError && qtyNum > 0 && !!reason && !remarksRequired;
  const canSendToVendor = canSave;

  // --- mutations ---
  const saveDraft = useMutation({
    mutationFn: async () => {
      if (!pickedSource || !activeItem) throw new Error("Select a source first");
      const payload = {
        return_date: new Date().toISOString().slice(0, 10),
        grn_id: purchase?.grn_id ?? (pickedSource.type === "GRN" ? pickedSource.id : null),
        po_id: purchase?.po_id ?? (pickedSource.type === "PO" ? pickedSource.id : null),
        vendor_id: vendor?.vendor_id ?? null,
        warehouse_id: detail?.warehouse_id ?? activeItem.warehouse_id ?? null,
        reason: reason || null,
        items: [
          {
            item_id: activeItem.item_id,
            grn_item_id: null as number | null,
            po_item_id: null as number | null,
            batch_id: activeItem.batch_id ?? null,
            quantity: qtyNum,
            rate: null,
            reason: reason,
          },
        ],
      };
      // try to find grn_item_id for accurate cap check: fetch via detail? Use item_id match on GRN lines.
      // For simplicity, let backend resolve cap via doc.grn_id.
      if (existingId) {
        return updateReturn(existingId, payload);
      }
      return createReturn(payload);
    },
    onSuccess: (saved) => {
      setError(null);
      setSuccess("Draft saved");
      qc.invalidateQueries({ queryKey: ["warehouse", "purchase-return"] });
      if (!existingId) navigate(`/warehouse/purchase-returns/${saved.id}`, { replace: true });
    },
    onError: (e: any) => setError(e?.response?.data?.error ?? e.message ?? "Save failed"),
  });

  const sendToVendor = useMutation({
    mutationFn: async () => {
      if (!pickedSource || !activeItem) throw new Error("Select a source");
      if (qtyError) throw new Error(qtyError);
      // Ensure draft exists, then call send-to-vendor
      let docId = existingId;
      let payloadItems = [
        {
          item_id: activeItem.item_id,
          batch_id: activeItem.batch_id ?? null,
          quantity: qtyNum,
          rate: null as number | null,
          reason: reason,
          grn_item_id: null as number | null,
          po_item_id: null as number | null,
        },
      ];
      if (!docId) {
        const created = await createReturn({
          return_date: new Date().toISOString().slice(0, 10),
          grn_id: purchase?.grn_id ?? (pickedSource.type === "GRN" ? pickedSource.id : null),
          po_id: purchase?.po_id ?? (pickedSource.type === "PO" ? pickedSource.id : null),
          vendor_id: vendor?.vendor_id ?? null,
          warehouse_id: detail?.warehouse_id ?? activeItem.warehouse_id ?? null,
          reason,
          items: payloadItems.map((it) => ({ ...it })),
        });
        docId = created.id;
      } else {
        // update draft with latest qty/reason before sending
        await updateReturn(docId, {
          return_date: existing?.return_date ?? new Date().toISOString().slice(0, 10),
          grn_id: purchase?.grn_id ?? (pickedSource.type === "GRN" ? pickedSource.id : null),
          po_id: purchase?.po_id ?? (pickedSource.type === "PO" ? pickedSource.id : null),
          vendor_id: vendor?.vendor_id ?? (existing?.vendor_id ?? null),
          warehouse_id: detail?.warehouse_id ?? activeItem.warehouse_id ?? existing?.warehouse_id ?? null,
          reason,
          items: payloadItems.map((it) => ({ ...it })),
        });
      }
      return sendPurchaseReturnToVendor(docId as number, {
        return_reason: reason,
        remarks: remarks.trim() || null,
        items: payloadItems.map((it) => ({ ...it })),
        grn_id: purchase?.grn_id ?? (pickedSource.type === "GRN" ? pickedSource.id : null),
        po_id: purchase?.po_id ?? (pickedSource.type === "PO" ? pickedSource.id : null),
        vendor_id: vendor?.vendor_id ?? null,
        warehouse_id: detail?.warehouse_id ?? activeItem.warehouse_id ?? null,
      });
    },
    onSuccess: (saved: any) => {
      setError(null);
      setSuccess(`Sent to vendor — ${saved.dispatch_no ?? saved.return_no} via Existing Logistics`);
      qc.invalidateQueries({ queryKey: ["warehouse", "purchase-return"] });
      // navigate to detail showing dispatch
      const targetId = (saved as any).id ?? existingId;
      if (targetId) navigate(`/warehouse/purchase-returns/${targetId}`);
    },
    onError: (e: any) => setError(e?.response?.data?.error ?? e.message ?? "Send to Vendor failed"),
  });

  const busy = saveDraft.isPending || sendToVendor.isPending;

  // options for source dropdown
  const sourceOptions = (sourcePage?.items ?? []).map((opt) => ({
    value: `${opt.source_type}:${opt.source_id}`,
    label: `${opt.source_type} ${opt.source_no} · ${opt.vendor_name ?? "No vendor"} · ${opt.item_name ?? ""}`.trim(),
  }));

  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <PageHeader
        eyebrow="RETURNS"
        title="Purchase Return"
        back={{ to: "/returns/purchase", label: "Back to Purchase returns" }}
      />

      {error && <ErrorBanner error={error} />}
      {success && (
        <Card className="mb-4 border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{success}</Card>
      )}

      {/* Read-only header block */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <div className="text-xs uppercase text-muted">Return ID</div>
            <div className="font-semibold text-ink">{existing?.return_no ?? "Auto Generated"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted">Warehouse</div>
            <div className="text-ink">{detail?.warehouse_name ?? existing?.warehouse_name ?? "Auto"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted">Created By</div>
            <div className="text-ink">{existing?.created_by_name ?? "Logged-in Storekeeper"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted">Date</div>
            <div className="text-ink">{existing?.return_date ?? todayStr}</div>
          </div>
        </div>
      </Card>

      {/* Source Transaction */}
      <Card className="mb-4 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink">Source Transaction</h3>
        <p className="mb-3 text-xs text-muted">
          Select an existing Item / Indent / Purchase / GRN. Vendor and item details are auto-fetched — no manual entry.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <Field
              label="Select Indent / Purchase / Item"
              hint="Search by GRN, PO, Indent or vendor. Uses existing SCM data — no duplicate master."
              required
            >
              <Select
                value={pickedSource ? `${pickedSource.type}:${pickedSource.id}` : ""}
                onChange={pickSource}
                options={sourceOptions}
                placeholder="Search and pick a purchase transaction"
                ariaLabel="Source transaction"
              />
            </Field>
          </div>
          <div>
            {items.length > 1 && (
              <Field label="Item within this source">
                <Select
                  value={selectedItemId ? String(selectedItemId) : String(activeItem?.item_id ?? "")}
                  onChange={(v) => setSelectedItemId(v ? Number(v) : null)}
                  options={items.map((it) => ({
                    value: String(it.item_id),
                    label: `${it.item_code ?? it.item_id} · ${it.item_name ?? ""} (returnable ${it.returnable_qty})`,
                  }))}
                  placeholder="Pick item"
                  ariaLabel="Item within source"
                />
              </Field>
            )}
          </div>
        </div>
      </Card>

      {/* Auto-fetched Vendor Details */}
      <Card className="mb-4 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink">Vendor Details — Auto</h3>
        {!vendor ? (
          <p className="text-sm text-muted">Pick a source above to auto-fetch vendor.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <div>
              <div className="text-xs text-muted">Vendor Name</div>
              <div className="font-medium text-ink">{vendor.vendor_name ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Vendor Code</div>
              <div className="text-ink">{vendor.vendor_code ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Contact Person</div>
              <div className="text-ink">{vendor.contact_person ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Contact Number</div>
              <div className="text-ink">{vendor.phone ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Email</div>
              <div className="text-ink break-all">{vendor.email ?? "—"}</div>
            </div>
            <div className="md:col-span-3">
              <div className="text-xs text-muted">Address</div>
              <div className="text-ink">
                {[vendor.address, vendor.city, vendor.state, vendor.pincode].filter(Boolean).join(", ") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">Purchase Order</div>
              <div className="text-ink">{purchase?.po_no ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Indent</div>
              <div className="text-ink">{purchase?.indent_no ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Material Receipt / GRN</div>
              <div className="text-ink">{purchase?.grn_no ?? "—"}</div>
            </div>
          </div>
        )}
      </Card>

      {/* Auto-fetched Item Details */}
      <Card className="mb-4 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink">Item Details — Auto</h3>
        {!activeItem ? (
          <p className="text-sm text-muted">Pick a source to see material details.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <div>
              <div className="text-xs text-muted">Material Code</div>
              <div className="font-medium text-ink">{activeItem.item_code ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Material Name</div>
              <div className="text-ink">{activeItem.item_name ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Description</div>
              <div className="text-ink">{activeItem.description ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Batch / Lot</div>
              <div className="text-ink">{activeItem.batch_no ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">UOM</div>
              <div className="text-ink">{activeItem.uom_code ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Warehouse</div>
              <div className="text-ink">{activeItem.warehouse_name ?? detail?.warehouse_name ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Original Quantity</div>
              <div className="text-ink">{original}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Previously Returned</div>
              <div className="text-ink">{previously}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Returnable Quantity</div>
              <div className="font-semibold text-ink">{returnable}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Purchase Order</div>
              <div className="text-ink">{purchase?.po_no ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Indent ID</div>
              <div className="text-ink">{purchase?.indent_no ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Material Receipt ID</div>
              <div className="text-ink">{purchase?.grn_no ?? "—"}</div>
            </div>
          </div>
        )}
      </Card>

      {/* Return Quantity + Reason */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Return Quantity"
            required
            hint={
              activeItem ? `Returnable: ${returnable} (Original ${original} − Previously ${previously})` : undefined
            }
          >
            <Input
              type="number"
              value={returnQty}
              onChange={(e) => setReturnQty(e.target.value)}
              placeholder="Enter quantity"
              isInvalid={!!qtyError}
              aria-label="Return quantity"
            />
            {qtyError && <p className="mt-1 text-xs text-red-600">{qtyError}</p>}
          </Field>

          <Field label="Return Reason" required>
            <Select
              value={reason}
              onChange={setReason}
              options={reasons.map((r) => ({ value: r.value, label: r.label }))}
              placeholder="Select reason"
              ariaLabel="Return reason"
            />
          </Field>

          <div className="md:col-span-2">
            <Field
              label={reason === "OTHER" ? "Remarks (required for Other)" : "Remarks"}
              required={reason === "OTHER"}
              hint={reason === "OTHER" ? "Tell us more — required when reason is Other" : "Optional"}
            >
              <Input
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Enter remarks"
                isInvalid={reason === "OTHER" && !remarks.trim()}
                aria-label="Remarks"
              />
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field label="Attachments" hint="Upload photo/bill — optional, stored with the return">
              <Input type="file" aria-label="Attachments" />
            </Field>
          </div>
        </div>
      </Card>

      {/* Review summary */}
      {activeItem && qtyNum > 0 && !qtyError && reason && (
        <Card className="mb-4 border-amber-200 bg-amber-50 p-4">
          <h4 className="mb-2 text-sm font-semibold text-ink">Review</h4>
          <p className="text-sm text-body">
            Returning <span className="font-semibold">{qtyNum}</span> of{" "}
            <span className="font-semibold">{activeItem.item_name ?? activeItem.item_code}</span> to{" "}
            <span className="font-semibold">{vendor?.vendor_name ?? "Vendor"}</span> from{" "}
            <span className="font-semibold">{detail?.warehouse_name ?? "Warehouse"}</span> for{" "}
            <span className="font-semibold">{reasons.find((r) => r.value === reason)?.label ?? reason}</span>.
            This will create <span className="font-mono">RET-…</span> and dispatch via{" "}
            <span className="font-semibold">Existing Logistics</span> to vendor.
          </p>
        </Card>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        <Button variant="soft" className={TONE_PINK} onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button
          variant="soft"
          className={TONE_MINT}
          disabled={!canSave || busy}
          onClick={() => saveDraft.mutate()}
        >
          {saveDraft.isPending ? "Saving…" : "Save Draft"}
        </Button>
        <Button
          className={TONE_DEEP_MINT}
          disabled={!canSendToVendor || busy}
          onClick={() => sendToVendor.mutate()}
        >
          {sendToVendor.isPending ? "Sending…" : "Send to Vendor"}
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted">
        Existing Vendor master and SCM data are reused. Stock/movement is validated on the server; logistics dispatch is
        created as <span className="font-mono">VENDOR_RETURN</span> and travels the established dispatch → shipment flow.
      </p>
    </div>
  );
}
