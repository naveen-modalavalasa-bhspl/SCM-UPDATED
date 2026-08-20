import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Send, Truck, X, CreditCard, Package, Route, Building, MapPin } from "lucide-react";
import {
  Button, Card, ErrorBanner, Field, Input, PageHeader, StatusPill, useToast,
} from "@/shared/components";
import { Stepper, type Step } from "@/shared/components/Stepper";
import { fmtDate, todayIst } from "@/shared/datetime";
import { supplierApi } from "@/modules/procurement/api";
import type {
  DespatchLineWrite, DespatchNote, DespatchNoteWrite, VendorPOLine,
} from "@/modules/procurement/types";
import { revisionLines } from "@/modules/procurement/types";
import { formatPONo } from "@/shared/format";
import { vendorPoLabel } from "../status";

const money = (value: number | null | undefined) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value ?? 0);

const today = () => new Date().toISOString().slice(0, 10);
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

type LineDraft = DespatchLineWrite & {
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  pending_qty: number;
};

/**
 * One order, and the despatch note the vendor files against it.
 *
 * This is the document doc B12 has always required on paper — invoice and e-way bill
 * before dispatch — filed by the party that has the facts. Batch, manufacture and
 * expiry are the reason it earns its place: they cannot be derived from the order, they
 * are known only to whoever packed the cartons, and they drive FEFO picking and expiry
 * alerts for the rest of each item's life. Typed at a gate off a carton, they are typed
 * wrong.
 *
 * Nobody inside the company approves this. It is a claim; the GRN is where it is agreed
 * with or contradicted, and only the received quantity ever moves stock.
 */
export function SupplierPODetailPage() {
  const { id } = useParams();
  const poId = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const { data: po, isLoading, error } = useQuery({
    queryKey: ["supplier-po", poId],
    queryFn: () => supplierApi.po(poId),
    enabled: Number.isFinite(poId) && poId > 0,
  });

  const revisions = useQuery({
    queryKey: ["supplier-po-revisions", poId],
    queryFn: () => supplierApi.revisions(poId),
    enabled: !!po?.revision_no,
  });

  const [header, setHeader] = useState<Omit<DespatchNoteWrite, "lines">>({
    dn_date: today(),
    invoice_no: "", invoice_date: null, invoice_amount: null,
    eway_bill_no: "", vehicle_no: "", transporter_name: "", lr_no: "",
    expected_date: null, remarks: "",
  });
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [editing, setEditing] = useState<DespatchNote | null>(null);
  const [responseNote, setResponseNote] = useState("");

  /** Yes, or no with a reason. The vendor id comes from the token server-side, so this
   *  can only ever answer this vendor's own order. */
  const respond = useMutation({
    mutationFn: (accept: boolean) =>
      supplierApi.respondToPo(poId, accept, responseNote),
    onSuccess: (_result, accept) => {
      toast.success(accept ? "Order accepted" : "Order declined");
      setResponseNote("");
      qc.invalidateQueries({ queryKey: ["supplier-po", poId] });
      qc.invalidateQueries({ queryKey: ["supplier-pos"] });
    },
  });
  const [composing, setComposing] = useState(false);

  /** Open the composer on what is still owed, so a second delivery starts from the
   *  remainder rather than from the whole order. */
  const startNew = () => {
    setEditing(null);
    setHeader({
      dn_date: today(), invoice_no: "", invoice_date: null, invoice_amount: null,
      eway_bill_no: "", vehicle_no: "", transporter_name: "", lr_no: "",
      expected_date: null, remarks: "",
    });
    setLines((po?.lines ?? [])
      .filter((line: VendorPOLine) => line.pending_qty > 0)
      .map((line: VendorPOLine) => ({
        po_item_id: line.po_item_id,
        despatched_qty: line.pending_qty,
        batch_no: "", mfg_date: null, expiry_date: null, remarks: null,
        item_code: line.item_code, item_name: line.item_name,
        uom_code: line.uom_code, pending_qty: line.pending_qty,
      })));
    setComposing(true);
  };

  /** Reopen a draft. A SUBMITTED note is never editable — the warehouse may already be
   *  counting against it, and changing it underneath them is the one way this document
   *  could make things worse rather than better. */
  const startEdit = (note: DespatchNote) => {
    setEditing(note);
    setHeader({
      dn_date: note.dn_date ?? today(),
      invoice_no: note.invoice_no ?? "", invoice_date: note.invoice_date ?? null,
      invoice_amount: note.invoice_amount ?? null,
      eway_bill_no: note.eway_bill_no ?? "", vehicle_no: note.vehicle_no ?? "",
      transporter_name: note.transporter_name ?? "", lr_no: note.lr_no ?? "",
      expected_date: note.expected_date ?? null, remarks: note.remarks ?? "",
    });
    setLines(note.items.map((line) => {
      const source = (po?.lines ?? []).find((l) => l.po_item_id === line.po_item_id);
      return {
        po_item_id: line.po_item_id ?? 0,
        despatched_qty: num(line.despatched_qty),
        batch_no: line.batch_no ?? "", mfg_date: line.mfg_date ?? null,
        expiry_date: line.expiry_date ?? null, remarks: line.remarks ?? null,
        item_code: line.item_code, item_name: line.item_name,
        uom_code: line.uom_code,
        // Its own quantity is not spent against its own ceiling on a re-save.
        pending_qty: (source?.pending_qty ?? 0) + num(line.despatched_qty),
      };
    }));
    setComposing(true);
  };

  useEffect(() => { setComposing(false); }, [poId]);

  const body = (): DespatchNoteWrite => ({
    ...header,
    lines: lines
      .filter((line) => num(line.despatched_qty) > 0)
      .map(({ item_code: _c, item_name: _n, uom_code: _u, pending_qty: _p, ...rest }) =>
        rest),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["supplier-po", poId] });
    void qc.invalidateQueries({ queryKey: ["supplier-pos"] });
  };

  const save = useMutation({
    mutationFn: () => (editing
      ? supplierApi.updateDespatch(poId, editing.id, body())
      : supplierApi.createDespatch(poId, body())),
    onSuccess: (note) => { setEditing(note); refresh(); },
  });

  const submit = useMutation({
    mutationFn: async () => {
      // Saved first, always: submitting what is on screen rather than what was last
      // written is the difference between a note the warehouse can trust and one that
      // silently omits the batch somebody just typed.
      const note = editing
        ? await supplierApi.updateDespatch(poId, editing.id, body())
        : await supplierApi.createDespatch(poId, body());
      return supplierApi.submitDespatch(note.id);
    },
    onSuccess: () => { setComposing(false); setEditing(null); refresh(); },
  });

  const cancel = useMutation({
    mutationFn: (noteId: number) => supplierApi.cancelDespatch(noteId),
    onSuccess: refresh,
  });

  const setLine = (index: number, patch: Partial<LineDraft>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  if (isLoading) return <p className="p-6 text-sm text-muted">Loading order…</p>;
  if (error) return <ErrorBanner error={error} />;
  if (!po) return <p className="p-6 text-muted">Order not found.</p>;

  const nothingLeft = (po.lines ?? []).every((line) => line.pending_qty <= 0);
  const busy = save.isPending || submit.isPending;

  // An order is an offer to buy. Until it is answered nothing can be despatched
  // against it, and once it is answered the buyer can only change it by amending it —
  // which asks the question again. Orders sent before this step existed carry no
  // answer at all and are left alone.
  const awaitingAnswer = po.vendor_status === "PENDING";
  const declined = po.vendor_status === "REJECTED";

  const steps: Step[] = (() => {
    const vs = po.vendor_status;
    const s = po.status;
    const baseSteps: Step[] = [
      { id: "sent", label: "Sent to you", status: "complete" },
      { id: "accepted", label: "Accepted", status: "upcoming" },
      { id: "fulfilled", label: "Fulfilled", status: "upcoming" },
    ];
    if (vs === "PENDING") {
      baseSteps[1].status = "current";
    } else if (vs === "REJECTED") {
      baseSteps[1] = { id: "accepted", label: "Rejected", status: "error" };
    } else if (vs === "ACCEPTED") {
      baseSteps[1].status = "complete";
      if (s === "RECEIVED" || s === "CLOSED") {
        baseSteps[2].status = "complete";
      } else if (s === "PARTIALLY_RECEIVED") {
        baseSteps[2].status = "current";
        baseSteps[2].description = "Partially received";
      } else {
        baseSteps[2].status = "current";
      }
    }
    return baseSteps;
  })();

  return (
    <>
      <Button variant="ghost" onClick={() => nav("/supplier/pos")}>
        <ArrowLeft className="h-4 w-4" /> Back to orders
      </Button>
      <PageHeader
        eyebrow="Purchase order"
        title={formatPONo(po.po_no, po.revision_no)}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Vendor-facing wording; the status itself is untouched. */}
            <StatusPill status={po.status} label={vendorPoLabel(po.status)} />
            {po.vendor_status && <StatusPill status={po.vendor_status} />}
            {/* Not offered until the order has been accepted: a despatch note is a
              * claim against an agreement, so there has to be one. The server refuses
              * it too — this only stops the vendor filling in a form for nothing. */}
            {!composing && !nothingLeft && !awaitingAnswer && !declined && (
              <Button onClick={startNew}>
                <Truck className="h-4 w-4" /> File a dispatch note
              </Button>
            )}
          </div>
        }
      />
      
      <div className="mb-6 -mx-2 sm:mx-0">
        <Stepper steps={steps} className="bg-surface-2/50 rounded-xl" />
      </div>

      <ErrorBanner error={save.error ?? submit.error ?? cancel.error} />

      <Card className="mb-4 p-5">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Order date</dt>
            <dd className="mt-1 text-body">{fmtDate(po.po_date)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Wanted by</dt>
            <dd className="mt-1 text-body">
              {po.expected_date ? fmtDate(po.expected_date) : "Not stated"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Value</dt>
            <dd className="mt-1 font-semibold text-ink">₹ {money(po.total_amount)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Lines</dt>
            <dd className="mt-1 text-body">{po.lines.length}</dd>
          </div>
        </dl>
        {po.remarks && <p className="mt-4 border-t border-line pt-4 text-sm text-body">{po.remarks}</p>}
      </Card>

      {/* The step that turns an order into an agreement. Shown above the goods, because
        * answering it is the first thing this screen is for. */}
      {awaitingAnswer && (
        <Card className="mb-5 space-y-3 p-5">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              {(po.revision_no ?? 0) > 0
                ? `Revision ${po.revision_no} of this order needs your answer`
                : "This order needs your answer"}
            </h2>
            <p className="mt-1 text-xs text-muted">
              Check the quantities, rates and terms below. Accepting confirms you will
              supply them; you cannot dispatch against the order until you do.
              {(po.revision_no ?? 0) > 0 && po.amendment_reason
                ? ` The buyer amended it: ${po.amendment_reason}`
                : ""}
            </p>
          </div>
          <Field label="Note to the buyer">
            <Input
              value={responseNote}
              onChange={(event) => setResponseNote(event.target.value)}
              placeholder="Optional when accepting, required when declining"
            />
          </Field>
          {respond.error && (
            <p className="text-sm text-danger">{(respond.error as Error).message}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="danger"
              disabled={respond.isPending || !responseNote.trim()}
              onClick={() => respond.mutate(false)}
            >
              <X className="h-4 w-4" /> Decline
            </Button>
            <Button disabled={respond.isPending} onClick={() => respond.mutate(true)}>
              <Check className="h-4 w-4" /> Accept this order
            </Button>
          </div>
        </Card>
      )}

      {declined && (
        <Card className="mb-5 p-5">
          <p className="text-sm text-ink">
            You declined this order{po.vendor_responded_at ? ` on ${fmtDate(po.vendor_responded_at)}` : ""}.
            {po.vendor_response_note ? ` Reason given: ${po.vendor_response_note}` : ""}
          </p>
          <p className="mt-1 text-xs text-muted">
            Nothing can be dispatched against it. The buyer can amend the order and
            send it back to you.
          </p>
        </Card>
      )}

      {po.vendor_status === "ACCEPTED" && (
        <p className="mb-5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-body">
          You accepted this order{po.vendor_responded_at ? ` on ${fmtDate(po.vendor_responded_at)}` : ""}.
          It can only change now if the buyer amends it, which comes back here for a
          fresh answer.
        </p>
      )}

      {(po.payment_terms || po.delivery_terms || po.material_terms || po.logistics_terms) && (
        <Card className="mb-5 p-6">
          <h2 className="mb-4 text-base font-semibold text-ink">Terms and Conditions</h2>
          <div className="flex flex-col gap-4">
            {([
              ["Payment terms", po.payment_terms, CreditCard],
              ["Delivery terms", po.delivery_terms, Truck],
              ["Material terms", po.material_terms, Package],
              ["Logistics terms", po.logistics_terms, Route],
            ] as const).filter(([, text]) => text).map(([label, text, Icon]) => (
              <div 
                key={label} 
                className="group flex flex-col rounded-xl border border-line/50 bg-surface-2/30 p-4 transition-all hover:bg-surface-2 hover:shadow-sm"
              >
                <div className="mb-3 flex items-center gap-2 text-muted transition-colors group-hover:text-ink">
                  <Icon className="h-4 w-4" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">{label}</h3>
                </div>
                <div className="flex-1 whitespace-pre-line break-words text-sm leading-relaxed text-body">{text}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {(po.billing_address || po.shipping_address) && (
        <Card className="mb-5 p-6">
          <h2 className="mb-4 text-base font-semibold text-ink">Addresses</h2>
          <div className="flex flex-col gap-4">
            {([
              ["Bill to", po.billing_address, Building],
              ["Ship to", po.shipping_address, MapPin],
            ] as const).filter(([, text]) => text).map(([label, text, Icon]) => (
              <div 
                key={label} 
                className="group flex flex-col rounded-xl border border-line/50 bg-surface-2/30 p-4 transition-all hover:bg-surface-2 hover:shadow-sm"
              >
                <div className="mb-3 flex items-center gap-2 text-muted transition-colors group-hover:text-ink">
                  <Icon className="h-4 w-4" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">{label}</h3>
                </div>
                <div className="flex-1 whitespace-pre-line break-words text-sm leading-relaxed text-body">{text}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <h2 className="mb-2 text-sm font-semibold text-ink">Ordered</h2>
      <Card className="mb-5 overflow-x-auto p-0">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-content2 text-xs text-muted">
            <tr>
              <th className="p-3">Item</th>
              <th className="p-3 text-right">Ordered</th>
              <th className="p-3 text-right">Dispatched</th>
              <th className="p-3 text-right">Still owed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {po.lines.map((line) => {
              const previous = revisionLines(revisions.data?.[0]);
              const prev = previous.find((old: any) => old.item_id === line.item_id);
              // A line the last filed revision does not mention is one this
              // amendment added. No revision on file means nothing has changed.
              const isNew = previous.length > 0 && !prev;

              return (
                <tr key={line.po_item_id} className={isNew ? "bg-primary/5" : ""}>
                  <td className="p-3">
                    <strong className="text-ink">{line.item_name ?? "—"}</strong>
                    {isNew && <span className="ml-2 text-[10px] font-bold uppercase text-primary bg-primary/10 px-1.5 py-0.5 rounded">New Item</span>}
                    <p className="font-mono text-xs text-muted">{line.item_code}</p>
                  </td>
                  <td className="tabular p-3 text-right">
                    {prev && prev.quantity !== line.ordered_qty && (
                      <span className="line-through text-muted mr-1 text-xs">{prev.quantity}</span>
                    )}
                    {line.ordered_qty} {line.uom_code ?? ""}
                  </td>
                  <td className="tabular p-3 text-right text-muted">{line.despatched_qty}</td>
                  <td className="tabular p-3 text-right font-semibold">{line.pending_qty}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {composing && (
        <Card className="mb-5 space-y-5 p-5">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              {editing ? `Dispatch note ${editing.dn_no}` : "New dispatch note"}
            </h2>
            <p className="text-xs text-muted">
              The invoice number and e-way bill are required before you can submit.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Invoice no">
              <Input
                value={header.invoice_no ?? ""}
                onChange={(e) => setHeader((h) => ({ ...h, invoice_no: e.target.value }))}
              />
            </Field>
            <Field label="Invoice date">
              {/* An invoice cannot be raised in the future — same class of bug, other
                * direction, so it is capped rather than floored. */}
              <Input
                type="date"
                max={todayIst()}
                value={header.invoice_date ?? ""}
                onChange={(e) => setHeader((h) => ({ ...h, invoice_date: e.target.value || null }))}
              />
            </Field>
            <Field label="Invoice amount">
              <Input
                type="number"
                value={header.invoice_amount ?? ""}
                onChange={(e) => setHeader((h) => ({
                  ...h, invoice_amount: e.target.value === "" ? null : Number(e.target.value),
                }))}
              />
            </Field>
            <Field label="E-way bill no">
              <Input
                value={header.eway_bill_no ?? ""}
                onChange={(e) => setHeader((h) => ({ ...h, eway_bill_no: e.target.value }))}
              />
            </Field>
            <Field label="Vehicle no">
              <Input
                value={header.vehicle_no ?? ""}
                onChange={(e) => setHeader((h) => ({ ...h, vehicle_no: e.target.value }))}
              />
            </Field>
            <Field label="Transporter">
              <Input
                value={header.transporter_name ?? ""}
                onChange={(e) => setHeader((h) => ({ ...h, transporter_name: e.target.value }))}
              />
            </Field>
            <Field label="LR / docket no">
              <Input
                value={header.lr_no ?? ""}
                onChange={(e) => setHeader((h) => ({ ...h, lr_no: e.target.value }))}
              />
            </Field>
            <Field label="Expected delivery">
              {/* FIXED 2026-08-20 — the picker accepted past dates, so a vendor could
                * file a note promising delivery before the day they wrote it. The
                * receiving desk chases against this date, so a date already gone reads
                * as an overdue shipment the moment it is saved. `min` today; the server
                * refuses one anyway (procurement.service._check_despatch_dates). */}
              <Input
                type="date"
                min={todayIst()}
                value={header.expected_date ?? ""}
                onChange={(e) => setHeader((h) => ({ ...h, expected_date: e.target.value || null }))}
              />
            </Field>
          </div>

          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-content2 text-xs text-muted">
                <tr>
                  <th className="p-3">Item</th>
                  <th className="p-3 text-right">Sending</th>
                  <th className="p-3">Batch</th>
                  <th className="p-3">Manufactured</th>
                  <th className="p-3">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {lines.map((line, index) => (
                  <tr key={line.po_item_id}>
                    <td className="p-3">
                      <strong className="text-ink">{line.item_name ?? "—"}</strong>
                      <p className="font-mono text-xs text-muted">
                        {line.item_code} · up to {line.pending_qty} {line.uom_code ?? ""}
                      </p>
                    </td>
                    <td className="p-2 text-right">
                      <Input
                        type="number"
                        className="text-right"
                        value={line.despatched_qty}
                        onChange={(e) => setLine(index, { despatched_qty: num(e.target.value) })}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        value={line.batch_no ?? ""}
                        placeholder="Batch / lot"
                        onChange={(e) => setLine(index, { batch_no: e.target.value })}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        type="date"
                        // Nothing is manufactured tomorrow.
                        max={todayIst()}
                        value={line.mfg_date ?? ""}
                        onChange={(e) => setLine(index, { mfg_date: e.target.value || null })}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        type="date"
                        // Already-expired stock must not be dispatched at all, so the
                        // floor is today rather than the manufacture date.
                        min={todayIst()}
                        value={line.expiry_date ?? ""}
                        onChange={(e) => setLine(index, { expiry_date: e.target.value || null })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setComposing(false)}>
              Close
            </Button>
            <Button variant="subtle" disabled={busy} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save draft"}
            </Button>
            <Button disabled={busy} onClick={() => submit.mutate()}>
              <Send className="h-4 w-4" /> {submit.isPending ? "Submitting…" : "Submit dispatch"}
            </Button>
          </div>
        </Card>
      )}

      <h2 className="mb-2 text-sm font-semibold text-ink">Dispatch notes</h2>
      <Card className="p-0">
        {po.despatch_notes.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">
            Nothing filed yet. Tell us what is on the vehicle before it leaves.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {po.despatch_notes.map((note) => (
              <li key={note.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-ink">{note.dn_no}</span>
                    <StatusPill status={note.status} />
                  </div>
                  <p className="text-xs text-muted">
                    {[note.invoice_no && `Invoice ${note.invoice_no}`,
                      note.eway_bill_no && `E-way ${note.eway_bill_no}`,
                      note.vehicle_no,
                      `${note.items.length} line(s)`]
                      .filter(Boolean).join(" · ")}
                  </p>
                </div>
                {note.status === "DRAFT" && (
                  <>
                    <Button variant="subtle" onClick={() => startEdit(note)}>Edit</Button>
                    <Button
                      variant="danger"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(note.id)}
                    >
                      Cancel
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
