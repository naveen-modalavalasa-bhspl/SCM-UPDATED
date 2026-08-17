import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Send, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Button, Can, Card, Field, Input, PageHeader, StatusPill, useToast,
} from "@/shared/components";
import { poApi } from "../api";
import {
  blankPOHeader, POHeaderFields, poHeaderFrom, poHeaderPayload, type POHeaderValue,
} from "../components/POHeaderFields";
import { alerts } from "@/modules/alerts";
import { fmtDate } from "@/shared/datetime";

const money = (value: number) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value);

/** Purchase-order document view used by both the approval inbox and My Decisions. */
export function PODetailPage() {
  const { id } = useParams();
  const poId = Number(id);
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const approvalView = params.get("approval") === "1";
  const decisionView = params.get("decision") === "1";
  const [comments, setComments] = useState("");
  // The header a draft order can still be given: project, remarks, the four terms,
  // the two addresses, discount and freight. An order written from a won tender
  // arrives with none of them — the quotation never carried any — so this is where a
  // buyer says what was actually agreed before sending it up for approval.
  const [header, setHeader] = useState<POHeaderValue>(blankPOHeader());

  const po = useQuery({
    queryKey: ["purchase-order", poId],
    queryFn: () => poApi.get(poId),
    enabled: Number.isFinite(poId) && poId > 0,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["purchase-order", poId] });
    qc.invalidateQueries({ queryKey: ["pos"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  };

  useEffect(() => {
    if (po.data) setHeader(poHeaderFrom(po.data));
  }, [po.data]);

  /** DRAFT only, server-side too: past that the order is in approval or has been sent,
   *  and a term that changes after somebody signed it is a different agreement. */
  const saveHeader = useMutation({
    mutationFn: () => poApi.update(poId, poHeaderPayload(header)),
    onSuccess: () => {
      toast.success("Order details saved");
      refresh();
    },
  });

  const decide = useMutation({
    mutationFn: (action: "approve" | "reject") => action === "approve"
      ? poApi.approve(poId, comments)
      : poApi.reject(poId, comments),
    onSuccess: (_result, action) => {
      const number = po.data?.po_no ?? "The purchase order";
      void alerts.success(action === "approve" ? "po.approved" : "po.rejected", { number });
      setComments("");
      refresh();
      // Only when the approver came from their inbox. Signing a PO opened directly
      // must leave them on the document — sending them to /approvals from here is
      // navigating away from a screen they did not arrive at through approvals.
      if (approvalView || decisionView) nav("/approvals");
    },
  });

  /** Hand the draft to its approver. The engine owns who that is — this only moves
   *  the document's own status, exactly as `submit_po` does server-side. */
  const submit = useMutation({
    mutationFn: () => poApi.submit(poId),
    onSuccess: () => {
      void alerts.success("po.submitted", { number: po.data?.po_no ?? "" });
      refresh();
    },
  });

  /** The last step before the warehouse can receive: the GRN guard requires
   *  SENT_TO_VENDOR, so nothing can be booked in against an unsent order. */
  const send = useMutation({
    mutationFn: () => poApi.sendToVendor(poId),
    onSuccess: () => {
      void alerts.success("po.sent_to_vendor", {
        number: po.data?.po_no ?? "", vendor: po.data?.vendor_name ?? "the vendor",
      });
      refresh();
    },
  });

  const sendWithConfirm = async () => {
    if (send.isPending || !po.data) return;
    if (await alerts.confirm("po.send_vendor", {
      number: po.data.po_no, vendor: po.data.vendor_name ?? "the vendor",
    })) send.mutate();
  };

  const decideWithConfirm = async (action: "approve" | "reject") => {
    if (decide.isPending || !po.data) return;
    const asked = action === "approve"
      ? await alerts.confirm("po.approve", {
        number: po.data.po_no,
        amount: money(po.data.total_amount ?? 0),
      })
      : await alerts.confirm("po.reject", { number: po.data.po_no });
    if (asked) decide.mutate(action);
  };

  if (po.isLoading) return <p className="p-6 text-sm text-muted">Loading purchase order…</p>;
  if (po.error) return <p className="rounded-lg bg-danger/10 p-4 text-danger">{(po.error as Error).message}</p>;
  if (!po.data) return <p className="p-6 text-muted">Purchase order not found.</p>;

  // Was `approvalView && …`, so the panel only appeared when the approver arrived from
  // their inbox: a PO opened from the register showed no way to sign it at all. The
  // status is the real gate — and the engine still refuses anyone who is not the
  // current approver, so this widens the doorway, never the authority.
  const canDecide = po.data.status === "PENDING_APPROVAL";
  const isDraft = po.data.status === "DRAFT";
  const backTo = decisionView ? "/approvals/decisions" : approvalView ? "/approvals" : "/pos";
  const busy = submit.isPending || send.isPending || decide.isPending;

  return <>
    <Button variant="ghost" onClick={() => nav(backTo)}>
      <ArrowLeft className="h-4 w-4" /> {decisionView ? "Back to My Decisions" : approvalView ? "Back to approvals" : "Back to purchase orders"}
    </Button>
    <PageHeader
      eyebrow="Purchase order"
      title={po.data.po_no}
      actions={<div className="flex flex-wrap items-center gap-2">
        <StatusPill status={po.data.status} />
        {/* One button per status, never two: a draft can only be submitted, an
          * approved order can only be sent. Each is gated on its own permission —
          * raising an order and committing it to a vendor are different rights. */}
        {po.data.status === "DRAFT" && <Can do="po.submit">
          <Button disabled={busy} onClick={() => submit.mutate()}>
            <Send className="h-4 w-4" /> {submit.isPending ? "Sending…" : "Send for approval"}
          </Button>
        </Can>}
        {po.data.status === "APPROVED" && <Can do="po.send_vendor">
          <Button disabled={busy} onClick={() => void sendWithConfirm()}>
            <Send className="h-4 w-4" /> {send.isPending ? "Sending…" : "Send to vendor"}
          </Button>
        </Can>}
      </div>}
    />

    {(submit.error || send.error) && <p className="mb-4 rounded-xl bg-danger/10 p-4 text-sm text-danger">
      {((submit.error ?? send.error) as Error).message}
    </p>}

    <Card className="mb-4 p-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-muted">Vendor</dt><dd className="font-semibold text-ink">{po.data.vendor_name ?? "—"}</dd></div>
        <div><dt className="text-muted">Indent</dt><dd className="font-mono text-ink">{po.data.indent_no ?? "—"}</dd></div>
        <div><dt className="text-muted">Project</dt><dd className="text-ink">{po.data.project_name ?? "—"}</dd></div>
        <div><dt className="text-muted">Expected date</dt><dd className="text-ink">{fmtDate(po.data.expected_date)}</dd></div>
      </dl>
      {po.data.remarks && <p className="mt-3 whitespace-pre-line border-t border-line pt-3 text-sm text-body">{po.data.remarks}</p>}
      {/* Where this order came from, when it came off an award rather than an indent.
        * Every document in the chain points backward at the one before it, and this is
        * the row that lets somebody reading a PO find the offer it was written from. */}
      {po.data.quotation_no && (
        <dl className="mt-3 grid gap-3 border-t border-line pt-3 text-sm sm:grid-cols-3">
          <div><dt className="text-muted">Requisition</dt><dd className="font-mono text-ink">{po.data.requisition_no ?? "—"}</dd></div>
          <div><dt className="text-muted">RFQ</dt><dd className="font-mono text-ink">{po.data.rfq_no ?? "—"}</dd></div>
          <div><dt className="text-muted">Quotation</dt><dd className="font-mono text-ink">{po.data.quotation_no}</dd></div>
        </dl>
      )}
    </Card>

    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-left text-sm">
        <thead className="bg-content2 text-xs text-muted"><tr><th className="p-3">Item</th><th className="p-3 text-right">Quantity</th><th className="p-3 text-right">Rate</th><th className="p-3 text-right">Tax</th><th className="p-3 text-right">Amount</th></tr></thead>
        <tbody className="divide-y divide-line">{po.data.items.map((item) => <tr key={item.id}>
          <td className="p-3"><strong className="text-ink">{item.item_name ?? "—"}</strong><p className="font-mono text-xs text-muted">{item.item_code ?? `#${item.item_id}`}</p></td>
          <td className="p-3 text-right">{item.quantity} {item.uom_code ?? ""}</td>
          <td className="p-3 text-right">{money(item.rate)}</td>
          <td className="p-3 text-right">{item.tax_percent}%</td>
          <td className="p-3 text-right font-semibold">{money(item.amount)}</td>
        </tr>)}</tbody>
      </table>
    </div>

    {/* Fill in what the chain could not: an order raised from an award knows the
      * money and nothing that was agreed in words. Draft only, and gated on po.edit —
      * hiding it is not the guard, the endpoint refuses a non-draft either way. */}
    {isDraft && <Can do="po.edit">
      <Card className="mt-4 space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">Order details</h2>
          <Button
            variant="subtle"
            disabled={saveHeader.isPending}
            onClick={() => saveHeader.mutate()}
          >
            {saveHeader.isPending ? "Saving…" : "Save details"}
          </Button>
        </div>
        {saveHeader.error && (
          <p className="text-sm text-danger">{(saveHeader.error as Error).message}</p>
        )}
        <POHeaderFields
          value={header}
          onChange={(patch) => setHeader({ ...header, ...patch })}
        />
      </Card>
    </Can>}

    {/* What the order comes to: the lines summed, then the money that belongs to the
      * document rather than to any line. Same arithmetic the server stored —
      * total = subtotal - discount + tax + freight. */}
    <Card className="mt-4 p-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <div><dt className="text-muted">Subtotal</dt><dd className="text-ink">{money(po.data.sub_total ?? 0)}</dd></div>
        <div><dt className="text-muted">Discount</dt><dd className="text-ink">{money(po.data.discount_amount ?? 0)}</dd></div>
        <div><dt className="text-muted">Tax</dt><dd className="text-ink">{money(po.data.tax_amount ?? 0)}</dd></div>
        <div><dt className="text-muted">Freight</dt><dd className="text-ink">{money(po.data.freight_amount ?? 0)}</dd></div>
        <div><dt className="text-muted">Total</dt><dd className="font-semibold text-ink">{money(po.data.total_amount)}</dd></div>
      </dl>
    </Card>

    {/* Addresses and terms — shown only when the order says something, so an order
      * raised before these fields existed reads exactly as it did. */}
    {(po.data.billing_address || po.data.shipping_address) && <Card className="mt-4 p-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-muted">Billing address</dt><dd className="whitespace-pre-line text-ink">{po.data.billing_address ?? "—"}</dd></div>
        <div><dt className="text-muted">Shipping address</dt><dd className="whitespace-pre-line text-ink">{po.data.shipping_address ?? "—"}</dd></div>
      </dl>
    </Card>}

    {(po.data.payment_terms || po.data.delivery_terms || po.data.material_terms
      || po.data.logistics_terms) && <Card className="mt-4 p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">Terms and conditions</h2>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {([
          ["Payment terms", po.data.payment_terms],
          ["Delivery terms", po.data.delivery_terms],
          ["Material terms", po.data.material_terms],
          ["Logistics terms", po.data.logistics_terms],
        ] as const).filter(([, text]) => text).map(([label, text]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="whitespace-pre-line text-ink">{text}</dd>
          </div>
        ))}
      </dl>
    </Card>}

    {canDecide && <Card className="mt-4 space-y-3 p-4">
      {po.data.current_approver_name && <p className="text-sm text-muted">
        Waiting on {po.data.current_approver_name}.
      </p>}
      <Field label="Comments">
        <Input value={comments} onChange={(event) => setComments(event.target.value)} placeholder="Optional approval comment" />
      </Field>
      {decide.error && <p className="text-sm text-danger">{(decide.error as Error).message}</p>}
      <div className="flex justify-end gap-2">
        <Can do="po.reject">
          <Button variant="danger" disabled={busy} onClick={() => void decideWithConfirm("reject")}><X className="h-4 w-4" /> Reject</Button>
        </Can>
        <Can do="po.approve">
          <Button disabled={busy} onClick={() => void decideWithConfirm("approve")}><Check className="h-4 w-4" /> Approve</Button>
        </Can>
      </div>
    </Card>}
  </>;
}
