import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FilePen, Printer, Send, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Button, Can, Card, Field, Input, PageHeader, StatusPill, useToast,
} from "@/shared/components";
import { Stepper, type Step } from "@/shared/components/Stepper";
import { poApi } from "../api";
import { revisionLines } from "../types";
import { ApprovalTrail } from "../components/ApprovalTrail";
import {
  blankPOHeader, POHeaderFields, poHeaderFrom, poHeaderPayload, type POHeaderValue,
} from "../components/POHeaderFields";
import { LinePicker, type DraftLine } from "../components/LinePicker";
import { alerts } from "@/modules/alerts";
import { fmtDate } from "@/shared/datetime";
import { formatPONo } from "@/shared/format";

const money = (value: number | null | undefined) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value ?? 0);

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

  // Only fetched once the order has actually been amended. An order on revision 0 has
  // no history worth a round trip, and most orders never leave it.
  const revisions = useQuery({
    queryKey: ["purchase-order-revisions", poId],
    queryFn: () => poApi.revisions(poId),
    enabled: (po.data?.revision_no ?? 0) > 0,
  });

  // An amendment is a change to something somebody has already agreed to, so it is
  // deliberately a separate act from editing a draft: it asks for a reason, and the
  // server files the whole previous order away before applying it.
  const [amending, setAmending] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [amendLines, setAmendLines] = useState<DraftLine[]>([]);
  const startAmending = () => {
    setAmending(true);
    setAmendLines(po.data?.items.map((i: any) => ({
      id: i.id,
      item_id: i.item_id,
      item_code: i.item_code,
      item_name: i.item_name,
      quantity: String(i.quantity),
      original_quantity: String(i.quantity),
      rate: String(i.rate),
      tax_percent: String(i.tax_percent),
    })) ?? []);
  };
  
  const amend = useMutation({
    mutationFn: () => poApi.amend(poId, {
      reason: amendReason,
      expected_date: po.data?.expected_date ?? null,
      ...poHeaderPayload(header),
      lines: amendLines.map(l => ({
        id: l.id ?? null,
        item_id: Number(l.item_id),
        quantity: Number(l.quantity),
        rate: Number(l.rate ?? 0),
        tax_percent: Number(l.tax_percent ?? 0),
      }))
    }),
    onSuccess: (updated) => {
      toast.success(
        `${formatPONo(updated.po_no, updated.revision_no)} amended — `
        + "send it for approval again",
      );
      setAmending(false);
      setAmendReason("");
      qc.invalidateQueries({ queryKey: ["purchase-order-revisions", poId] });
      refresh();
    },
  });

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
      const number = formatPONo(po.data?.po_no, po.data?.revision_no);
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
      void alerts.success("po.submitted", { number: formatPONo(po.data?.po_no, po.data?.revision_no) });
      refresh();
    },
  });

  /** The last step before the warehouse can receive: the GRN guard requires
   *  SENT_TO_VENDOR, so nothing can be booked in against an unsent order. */
  const send = useMutation({
    mutationFn: () => poApi.sendToVendor(poId),
    onSuccess: () => {
      const number = formatPONo(po.data?.po_no, po.data?.revision_no);
      void alerts.success("po.sent_to_vendor", {
        number, vendor: po.data?.vendor_name ?? "the vendor",
      });
      refresh();
    },
  });

  const sendWithConfirm = async () => {
    if (send.isPending || !po.data) return;
    if (await alerts.confirm("po.send_vendor", {
      number: formatPONo(po.data.po_no, po.data.revision_no), vendor: po.data.vendor_name ?? "the vendor",
    })) send.mutate();
  };

  const decideWithConfirm = async (action: "approve" | "reject") => {
    if (decide.isPending || !po.data) return;
    const number = formatPONo(po.data.po_no, po.data.revision_no);
    const asked = action === "approve"
      ? await alerts.confirm("po.approve", {
        number,
        amount: money(po.data.total_amount),
      })
      : await alerts.confirm("po.reject", { number });
    if (asked) decide.mutate(action);
  };

  if (po.isLoading) return <p className="p-6 text-sm text-muted">Loading purchase order…</p>;
  if (po.error) return <p className="rounded-lg bg-danger/10 p-4 text-danger">{(po.error as Error).message}</p>;
  if (!po.data) return <p className="p-6 text-muted">Purchase order not found.</p>;

  // Was `approvalView && …`, so the panel only appeared when the approver arrived from
  // their inbox: a PO opened from the register showed no way to sign it at all. The
  // status is the real gate — and the engine still refuses anyone who is not the
  // current approver, so this widens the doorway, never the authority.
  // FIXED 2026-08-20 — was `status === "PENDING_APPROVAL"`, which is true for every
  // holder of po.approve on every pending order in the company, including ones with
  // somebody else entirely. awaiting_me, not the status: PENDING_APPROVAL says the document is with SOMEBODY, not with you.
  const canDecide = !!po.data.awaiting_me;
  const isDraft = po.data.status === "DRAFT";
  // Nothing left to change: the goods are in and the paperwork is closed, or the order
  // never became one. The server refuses an amendment on these too.
  const isFinished = ["RECEIVED", "CLOSED", "CANCELLED", "REJECTED"]
    .includes(po.data.status);
  const backTo = decisionView ? "/approvals/decisions" : approvalView ? "/approvals" : "/pos";
  const busy = submit.isPending || send.isPending || decide.isPending;

  const steps: Step[] = (() => {
    const s = po.data.status;
    const vs = po.data.vendor_status;
    const baseSteps: Step[] = [
      { id: "draft", label: "Draft", status: "complete" },
      { id: "approved", label: "Approved", status: "upcoming" },
      { id: "sent", label: "Sent to Supplier", status: "upcoming" },
      { id: "accepted", label: "Accepted", status: "upcoming" },
      { id: "received", label: "Received", status: "upcoming" },
    ];
    if (s === "DRAFT" || s === "SUBMITTED" || s === "PENDING_APPROVAL") {
      baseSteps[1].status = "current";
    } else if (s === "REJECTED") {
      baseSteps[1] = { id: "approved", label: "Rejected", status: "error" };
    } else {
      baseSteps[1].status = "complete";
      if (s === "APPROVED") {
        baseSteps[2].status = "current";
      } else {
        baseSteps[2].status = "complete";
        if (vs === "REJECTED") {
          baseSteps[3] = { id: "accepted", label: "Rejected by Supplier", status: "error" };
        } else if (s === "SENT_TO_VENDOR") {
          baseSteps[3].status = "current";
        } else {
          baseSteps[3].status = "complete";
          if (s === "ACCEPTED_BY_SUPPLIER") {
            baseSteps[4].status = "current";
          } else if (s === "PARTIALLY_RECEIVED") {
            baseSteps[4].status = "current";
            baseSteps[4].description = "Partially received";
          } else if (s === "RECEIVED" || s === "CLOSED") {
            baseSteps[4].status = "complete";
          }
        }
      }
    }
    return baseSteps;
  })();

  return <>
    <Button variant="ghost" onClick={() => nav(backTo)}>
      <ArrowLeft className="h-4 w-4" /> {decisionView ? "Back to My Decisions" : approvalView ? "Back to approvals" : "Back to purchase orders"}
    </Button>
    <PageHeader
      eyebrow="Purchase order"
      title={formatPONo(po.data.po_no, po.data.revision_no)}
      actions={<div className="flex flex-wrap items-center gap-2">
        <StatusPill status={po.data.status} />
        {/* The vendor's answer is a different axis from our own status: an order can be
          * SENT_TO_VENDOR and either agreed or still unanswered. Said out loud. */}
        {po.data.vendor_status && <StatusPill status={po.data.vendor_status} />}
        {/* Opens the order on its own, laid out for paper. The browser's own print
          * dialog saves it as a PDF — no server-side renderer to keep in step with
          * the screen, and it prints exactly what is on the document. */}
        <Button variant="subtle" onClick={() => window.open(`/pos/${poId}/print`, "_blank")}>
          <Printer className="h-4 w-4" /> PDF
        </Button>
        {/* Amend is for an order that has left the building. A draft is simply edited,
          * and a finished order can no longer be changed at all — the same line the
          * server draws in `_UNAMENDABLE`, so the button never offers what the API
          * would refuse. SENT_TO_VENDOR stays in: every order raised before the
          * acceptance rung existed sits on it. */}
        {!isDraft && !isFinished && <Can do="po.edit">
          <Button variant="subtle" onClick={startAmending}>
            <FilePen className="h-4 w-4" /> Amend
          </Button>
        </Can>}
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
    
    <div className="mb-6 -mx-2 sm:mx-0">
      <Stepper steps={steps} className="bg-surface-2/50 rounded-xl" />
    </div>

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
        <tbody className="divide-y divide-line">{po.data.items.map((item) => {
          const previous = revisionLines(revisions.data?.[0]);
          const prev = previous.find((line: any) => line.item_id === item.item_id);
          // A line the last filed revision does not mention is one this amendment
          // added. No revision on file means nothing has changed.
          const isNew = previous.length > 0 && !prev;
          
          return (
            <tr key={item.id} className={isNew ? "bg-primary/5" : ""}>
              <td className="p-3">
                <strong className="text-ink">{item.item_name ?? "—"}</strong>
                {isNew && <span className="ml-2 text-[10px] font-bold uppercase text-primary bg-primary/10 px-1.5 py-0.5 rounded">New Item</span>}
                <p className="font-mono text-xs text-muted">{item.item_code ?? `#${item.item_id}`}</p>
              </td>
              <td className="p-3 text-right">
                {prev && prev.quantity !== item.quantity && (
                  <span className="line-through text-muted mr-1 text-xs">{prev.quantity}</span>
                )}
                {item.quantity} {item.uom_code ?? ""}
              </td>
              <td className="p-3 text-right">{money(item.rate)}</td>
              <td className="p-3 text-right">{item.tax_percent}%</td>
              <td className="p-3 text-right font-semibold">{money(item.amount)}</td>
            </tr>
          );
        })}</tbody>
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

    {/* Addresses and terms, ALWAYS — including the blanks. This is what an approver is
      * signing, and a field that disappears when empty cannot be told apart from a
      * field nobody thought to ask for. An empty term on an order worth six figures is
      * something the person signing it should see. */}
    <Card className="mt-4 p-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-muted">Billing address</dt><dd className="whitespace-pre-line text-ink">{po.data.billing_address || "—"}</dd></div>
        <div><dt className="text-muted">Shipping address</dt><dd className="whitespace-pre-line text-ink">{po.data.shipping_address || "—"}</dd></div>
      </dl>
    </Card>

    <Card className="mt-4 p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">Terms and conditions</h2>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {([
          ["Payment terms", po.data.payment_terms],
          ["Delivery terms", po.data.delivery_terms],
          ["Material terms", po.data.material_terms],
          ["Logistics terms", po.data.logistics_terms],
        ] as const).map(([label, text]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="whitespace-pre-line text-ink">{text || "—"}</dd>
          </div>
        ))}
      </dl>
    </Card>

    {/* What has been changed since, and why. Empty on an order still on its original
      * revision, which is most of them. */}
    {(po.data.revision_no ?? 0) > 0 && <Card className="mt-4 p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">
        Amendment history · now at revision {po.data.revision_no}
      </h2>
      {po.data.amendment_reason && (
        <p className="mb-3 text-sm text-body">
          Latest: {po.data.amendment_reason}
          {po.data.amended_at ? ` · ${fmtDate(po.data.amended_at)}` : ""}
        </p>
      )}
      <ol className="space-y-2 text-sm">
        {(revisions.data ?? []).map((rev) => (
          <li key={rev.id} className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-ink">Revision {rev.revision_no}</span>
              <span className="text-xs text-muted">
                {rev.changed_by_name ?? "—"} · {fmtDate(rev.created_at)}
              </span>
            </div>
            <p className="mt-1 text-body">{rev.reason ?? "—"}</p>
            <p className="mt-1 text-xs text-muted">
              Was {rev.status ?? "—"}
              {rev.vendor_status ? ` · vendor had ${rev.vendor_status.toLowerCase()} it` : ""}
              {typeof rev.snapshot?.total_amount === "number"
                ? ` · total was ${money(rev.snapshot.total_amount as number)}` : ""}
            </p>
          </li>
        ))}
        {(revisions.data ?? []).length === 0 && (
          <li className="text-muted">Loading the earlier versions…</li>
        )}
      </ol>
    </Card>}

    {amending && <Card className="mt-4 space-y-3 p-4">
      <h2 className="text-sm font-semibold text-ink">Amend this order</h2>
      <p className="text-xs text-muted">
        The current version is filed away and the order goes back to draft: it is
        approved again, and{" "}
        {po.data.vendor_status === "ACCEPTED"
          ? "the vendor has to accept the new version before anything can be delivered."
          : "sent to the vendor again for their answer."}
      </p>
      <Field label="Why is it being amended?">
        <Input
          autoFocus
          value={amendReason}
          onChange={(event) => setAmendReason(event.target.value)}
          placeholder="Required — e.g. delivery pushed to month end at the vendor's request"
        />
      </Field>
      {/* The same fields the draft editor shows. Quantities and rates stay as they are
        * here: changing what is being bought is a bigger act than changing a term, and
        * the endpoint takes lines separately when that day comes. */}
      <POHeaderFields
        value={header}
        disabled={true}
        onChange={(patch) => setHeader({ ...header, ...patch })}
      />
      <div className="pt-2 border-t border-line">
        <h3 className="text-sm font-semibold mb-3">Order Lines</h3>
        <LinePicker
          lines={amendLines}
          onChange={setAmendLines}
          showRate
          showTax
          showDate={false}
          freezeRateAndTax={true}
        />
      </div>
      {amend.error && <p className="text-sm text-danger">{(amend.error as Error).message}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="subtle" onClick={() => { setAmending(false); setAmendReason(""); }}>
          Cancel
        </Button>
        <Button
          disabled={amend.isPending || !amendReason.trim() || amendLines.length === 0}
          onClick={() => amend.mutate()}
        >
          {amend.isPending ? "Amending…" : "Save as a new revision"}
        </Button>
      </div>
    </Card>}

    <div className="mt-4">
      <ApprovalTrail docType="PO" docId={po.data.id} />
    </div>

    {canDecide && <Card className="mt-4 space-y-3 p-4">
      {/* `pending_with` is read live by the server; `current_approver_name` is the
          snapshot behind it and only used where the live read came back empty. */}
      {(po.data.pending_with?.length || po.data.current_approver_name) && <p className="text-sm text-muted">
        Waiting on {po.data.pending_with?.length
          ? po.data.pending_with.join(", ")
          : po.data.current_approver_name}.
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
