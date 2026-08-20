import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, Input, PageHeader, ResponsiveList, Select,
  StatusPill, useToast, type Column,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import { approvalTrailApi, approvalTrailKey, poApi, rfqApi } from "../api";
import { ApprovalTrail } from "../components/ApprovalTrail";
import { QuotationComparison } from "../components/QuotationComparison";
import type { RFQItem, RFQVendor } from "../types";

/**
 * One RFQ: its lines, who was asked, and — once quotes are in — the comparison.
 *
 * The comparison is behind `rfq.compare` and the award behind `rfq.award`, separately,
 * because the sheet carries every vendor's price. That is exactly what must never
 * reach a vendor, so seeing it is a narrower right than raising the RFQ was.
 */
export function RFQDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rfqId = Number(id);
  const [copied, setCopied] = useState<number | null>(null);

  const { data: rfq, isLoading, error } = useQuery({
    queryKey: ["rfq", id],
    queryFn: () => rfqApi.get(rfqId),
  });

  // The rung this RFQ is waiting on, off the engine's own trail — the same read the
  // ApprovalTrail below makes, so badge and ladder can never disagree, and a rung
  // renamed on Settings > Approvals Config renames both.
  const trail = useQuery({
    queryKey: approvalTrailKey("RFQ", rfqId),
    queryFn: () => approvalTrailApi.get("RFQ", rfqId),
    enabled: Number.isFinite(rfqId),
  });

  const published = ["PUBLISHED", "CLOSED", "AWARDED"].includes(rfq?.status ?? "");

  // Editable only while nobody outside has seen it, and only for the person who signs
  // it. The endpoint enforces both again — hiding the boxes is courtesy, not the guard.
  const { can } = useAuth();
  // Editing the asked-for quantity is part of approving it, so it follows the
  // same gate — an approver who cannot sign must not be able to change the ask.
  const editableQty = !!rfq?.awaiting_me && can("rfq.approve");

  // Previewing a different ranking is a query parameter, not a save: looking at the
  // quotes another way is not choosing one, so the RFQ's own method is untouched
  // until somebody edits it on the form.
  const [method, setMethod] = useState("");

  const { data: comparison } = useQuery({
    queryKey: ["rfq-comparison", id, method],
    queryFn: () => rfqApi.comparison(rfqId, method || undefined),
    // Only once vendors can actually have answered — asking earlier returns an empty
    // sheet that reads as "nobody quoted" rather than "nobody was asked yet".
    enabled: published,
  });

  const { data: methods } = useQuery({
    queryKey: ["rfq-evaluation-methods"],
    queryFn: rfqApi.evaluationMethods,
    enabled: published,
  });

  const { data: invites = [] } = useQuery({
    queryKey: ["rfq-invites", id],
    queryFn: () => rfqApi.invites(rfqId),
    enabled: published,
  });

  const refresh = (message: string) => () => {
    queryClient.invalidateQueries({ queryKey: ["rfq", id] });
    queryClient.invalidateQueries({ queryKey: ["rfqs"] });
    queryClient.invalidateQueries({ queryKey: ["rfq-comparison", id] });
    toast.success(message);
  };

  // The approver's own edit: how much, and nothing else. `rfq.approve` reaches it —
  // the buyer's Edit screen needs `rfq.create`, which an approver rarely holds, and
  // the deadline, the vendors and the item list are not theirs to change anyway.
  const [qtyEdits, setQtyEdits] = useState<Record<number, string>>({});
  const saveQuantities = useMutation({
    mutationFn: () => rfqApi.setQuantities(
      rfqId,
      Object.entries(qtyEdits)
        .filter(([, value]) => value !== "" && Number(value) > 0)
        .map(([lineId, value]) => ({ id: Number(lineId), quantity: Number(value) })),
    ),
    onSuccess: () => { setQtyEdits({}); refresh("Quantities updated")(); },
  });

  const submit = useMutation({ mutationFn: () => rfqApi.submit(rfqId), onSuccess: refresh("Sent for approval") });
  const approve = useMutation({ mutationFn: () => rfqApi.approve(rfqId), onSuccess: refresh("Approved — vendors can now see it") });
  const reject = useMutation({ mutationFn: () => rfqApi.reject(rfqId), onSuccess: refresh("Rejected") });
  const close = useMutation({ mutationFn: () => rfqApi.close(rfqId), onSuccess: refresh("Closed to further quotes") });
  const award = useMutation({
    mutationFn: (quotationId: number) => rfqApi.award(rfqId, quotationId),
    onSuccess: refresh("Awarded"),
  });

  // The offer that won. Read off the comparison rather than off the RFQ's awarded
  // vendor id: a vendor can hold more than one quotation on an RFQ (they revise), and
  // the PO is raised against the exact quote that was accepted, not against the vendor.
  const awardedQuote = (comparison?.quotations ?? []).find((q) => q.status === "ACCEPTED");

  /** The last hop of the chain: accept the chosen offer as a purchase order.
   *
   *  Vendor, rates, discount and tax all come from the quotation server-side — only
   *  its id is sent — so the PO cannot disagree with the offer it says it is for. It
   *  lands in DRAFT and still climbs the PO ladder; awarding is not approving a spend,
   *  and nothing raises an order on the buyer's behalf. */
  const raisePo = useMutation({
    mutationFn: (quotationId: number) => poApi.createFromQuotation(quotationId),
    onSuccess: (po) => {
      queryClient.invalidateQueries({ queryKey: ["rfq", id] });
      queryClient.invalidateQueries({ queryKey: ["pos"] });
      toast.success(`${po.po_no} raised from ${po.vendor_name ?? "the winner"}`);
      nav(`/pos/${po.id}`);
    },
  });

  const busy = submit.isPending || approve.isPending || reject.isPending
    || close.isPending || award.isPending || raisePo.isPending;

  const copyInvite = async (vendorId: number, path: string) => {
    await navigator.clipboard.writeText(`${location.origin}${path}`);
    setCopied(vendorId);
    toast.success("Link copied — send it to the vendor");
    setTimeout(() => setCopied(null), 2000);
  };

  const lineColumns: Column<RFQItem>[] = [
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">{r.item_name ?? `Item ${r.item_id}`}</div>
          <div className="font-mono text-[11px] text-muted">{r.item_code ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Quantity",
      className: "text-right",
      render: (r) => (editableQty ? (
        <div className="flex items-center justify-end gap-2">
          <Input
            type="number" min="0" step="0.001" className="w-28"
            value={qtyEdits[r.id] ?? String(r.quantity)}
            onChange={(e) => setQtyEdits({ ...qtyEdits, [r.id]: e.target.value })}
          />
          <span className="text-xs text-muted">{r.uom_code ?? ""}</span>
        </div>
      ) : `${r.quantity} ${r.uom_code ?? ""}`.trim()),
    },
    {
      key: "needed",
      header: "Needed by",
      hideOnNarrow: true,
      render: (r) => (r.required_date ? fmtDate(r.required_date) : "—"),
    },
  ];

  const vendorColumns: Column<RFQVendor>[] = [
    { key: "vendor", header: "Vendor", render: (r) => r.vendor_name ?? `Vendor ${r.vendor_id}` },
    { key: "email", header: "Email", hideOnNarrow: true, render: (r) => r.vendor_email ?? "—" },
    {
      key: "status",
      header: "Replied",
      render: (r) => (r.responded_at ? <StatusPill status={r.status ?? "SUBMITTED"} /> : <span className="text-sm text-muted">Not yet</span>),
    },
    {
      key: "link",
      header: "Invite",
      render: (r) => {
        const invite = invites.find((i) => i.vendor_id === r.vendor_id);
        if (!invite) return <span className="text-sm text-muted">—</span>;
        return (
          <button
            type="button"
            onClick={() => copyInvite(r.vendor_id, invite.invite_path)}
            className="flex h-11 items-center gap-1.5 text-sm text-brand hover:underline"
          >
            {copied === r.vendor_id
              ? <><Check className="h-3.5 w-3.5" /> Copied</>
              : <><Copy className="h-3.5 w-3.5" /> Copy link</>}
          </button>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title={rfq?.rfq_no ?? "RFQ"}
        actions={
          <>
            {rfq && (
              <StatusPill
                status={rfq.status === "PENDING_APPROVAL" && trail.data?.stage_name
                  ? `Pending at ${trail.data.stage_name}`
                  : rfq.status}
              />
            )}
            <Button variant="subtle" onClick={() => nav("/procurement/rfqs")}>Back</Button>
            {rfq?.status === "DRAFT" && (
              <Can do="rfq.create">
                <Button variant="subtle" onClick={() => nav(`/procurement/rfqs/${rfqId}/edit`)}>
                  Edit
                </Button>
                <Button disabled={busy} onClick={() => submit.mutate()}>
                  Send for approval
                </Button>
              </Can>
            )}
            {/* FIXED 2026-08-20 — awaiting_me, not the status: PENDING_APPROVAL says the document is with SOMEBODY, not with you. The PO clerk who raised the RFQ was shown
              * "Approve & publish" on one sitting with the CPO; the only thing that
              * stopped him was a 403 after the press. `awaiting_me` is computed by
              * engine.actionable_doc_ids, which makes the same two checks the approval
              * itself makes, so the button appears exactly when the press would work.
              * <Can> stays: the permission is still required, it was just never
              * sufficient. */}
            {rfq?.awaiting_me && (
              <Can do="rfq.approve">
                <Button variant="subtle" disabled={busy} onClick={() => reject.mutate()}>
                  Reject
                </Button>
                <Button disabled={busy} onClick={() => approve.mutate()}>
                  Approve &amp; publish
                </Button>
              </Can>
            )}
            {rfq?.status === "PUBLISHED" && (
              <Can do="rfq.create">
                <Button variant="subtle" disabled={busy} onClick={() => close.mutate()}>
                  Close early
                </Button>
              </Can>
            )}
            {/* Once the order exists the offer to raise one is wrong, not merely
              * redundant: the backend refuses the second, so the button could only
              * ever produce an error. It becomes the way to the order instead. */}
            {rfq?.status === "AWARDED" && rfq.po_id && (
              <Button variant="subtle" onClick={() => nav(`/pos/${rfq.po_id}`)}>
                {rfq.po_no ?? "Purchase order"}
              </Button>
            )}
            {rfq?.status === "AWARDED" && !rfq.po_id && awardedQuote && (
              <Can do="po.create">
                <Button disabled={busy} onClick={() => raisePo.mutate(awardedQuote.id)}>
                  {raisePo.isPending ? "Raising…" : "Create purchase order"}
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={error ?? submit.error ?? approve.error ?? reject.error ?? close.error ?? award.error ?? raisePo.error} />

      {rfq && (
        <Card className="mb-4 p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Status</dt>
              <dd className="mt-1"><StatusPill status={rfq.status} /></dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Closes</dt>
              <dd className="mt-1 text-body">{rfq.due_date ? fmtDate(rfq.due_date) : "No deadline"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Replies</dt>
              <dd className="mt-1 text-body">{rfq.response_count} of {rfq.vendor_count}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {rfq.status === "PENDING_APPROVAL" ? "With" : "Awarded to"}
              </dt>
              <dd className="mt-1 text-body">
                {rfq.current_approver_name ?? rfq.awarded_vendor_name ?? "—"}
              </dd>
            </div>
          </dl>
          {/* Everything the requisition said, carried across. A tender that names only
            * a deadline cannot be checked by the person approving it: department,
            * warehouse, project and company are what say who is buying, for where, on
            * whose budget — and the indent numbers say who asked in the first place. */}
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Requisition</dt>
              <dd className="mt-1">
                {rfq.requisition_id ? (
                  <button
                    className="font-mono text-xs text-brand underline"
                    onClick={() => nav(`/procurement/requisitions/${rfq.requisition_id}`)}
                  >
                    {rfq.requisition_no ?? `#${rfq.requisition_id}`}
                  </button>
                ) : (
                  <span className="font-mono text-xs text-body">
                    {rfq.consolidation_no ?? "—"}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Department</dt>
              <dd className="mt-1 text-body">{rfq.department_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Warehouse</dt>
              <dd className="mt-1 text-body">{rfq.warehouse_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Project</dt>
              <dd className="mt-1 text-body">{rfq.project_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Company</dt>
              <dd className="mt-1 text-body">{rfq.company_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Priority</dt>
              <dd className="mt-1 text-body">{rfq.priority ?? "Normal"}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-muted">Indents behind it</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {(rfq.source_indent_nos ?? []).length
                  ? rfq.source_indent_nos!.map((no) => (
                      <span
                        key={no}
                        className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-body"
                      >
                        {no}
                      </span>
                    ))
                  : <span className="text-body">—</span>}
              </dd>
            </div>
          </dl>

          {/* Where the award went next. Without it an AWARDED RFQ is a dead end on
            * screen even though the order exists — the chain only reads forward here. */}
          {rfq.po_id && (
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Purchase order</dt>
                <dd className="mt-1">
                  <button className="font-mono text-brand underline" onClick={() => nav(`/pos/${rfq.po_id}`)}>
                    {rfq.po_no ?? `#${rfq.po_id}`}
                  </button>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Order status</dt>
                <dd className="mt-1"><StatusPill status={rfq.po_status ?? "DRAFT"} /></dd>
              </div>
            </dl>
          )}
          {rfq.terms && (
            <p className="mt-4 border-t border-line pt-4 text-sm text-body">{rfq.terms}</p>
          )}
        </Card>
      )}

      <h2 className="mb-2 text-sm font-semibold text-ink">Lines</h2>
      <Card className="mb-5 p-2">
        <ResponsiveList
          data={rfq?.items ?? []}
          columns={lineColumns}
          keyOf={(r) => r.id}
          loading={isLoading}
          empty="No lines on this RFQ."
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="text-sm font-medium text-ink">{r.item_name ?? `Item ${r.item_id}`}</div>
              <div className="text-xs text-muted">
                {r.quantity} {r.uom_code ?? ""}
                {r.required_date ? ` · needed by ${fmtDate(r.required_date)}` : ""}
              </div>
            </div>
          )}
        />
        {editableQty && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line p-3">
            <p className="text-xs text-muted">
              Change what is being asked for before you sign. The quantities are frozen
              once the RFQ is published — the vendors have seen them by then.
            </p>
            <Button
              variant="subtle"
              disabled={saveQuantities.isPending || Object.keys(qtyEdits).length === 0}
              onClick={() => saveQuantities.mutate()}
            >
              {saveQuantities.isPending ? "Saving…" : "Save quantities"}
            </Button>
          </div>
        )}
      </Card>

      <h2 className="mb-2 text-sm font-semibold text-ink">Vendors asked</h2>
      <Card className="mb-5 p-2">
        <ResponsiveList
          data={rfq?.vendors ?? []}
          columns={vendorColumns}
          keyOf={(r) => r.id}
          empty="Nobody has been asked yet."
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="text-sm font-medium text-ink">{r.vendor_name ?? `Vendor ${r.vendor_id}`}</div>
              <div className="text-xs text-muted">
                {r.responded_at ? `Replied ${fmtDate(r.responded_at)}` : "Not replied"}
              </div>
            </div>
          )}
        />
      </Card>

      {published && (
        <>
          <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">Comparison</h2>
              <p className="text-xs text-muted">
                {comparison
                  ? `${comparison.responded} quote${comparison.responded === 1 ? "" : "s"} in, ranked by ${
                      methods?.find((m) => m.value === comparison.evaluation_method)?.label
                      ?? comparison.evaluation_method.replace(/_/g, " ").toLowerCase()}`
                  : "Waiting on quotes"}
              </p>
            </div>
            <div className="w-56">
              <Select
                value={method || comparison?.evaluation_method || ""}
                placeholder="Rank by…"
                options={(methods ?? []).map((m) => ({ value: m.value, label: m.label }))}
                onChange={setMethod}
              />
            </div>
          </div>

          {comparison && comparison.responded > 0 && !comparison.meets_three_quote_norm && (
            <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              Only {comparison.responded} quote{comparison.responded === 1 ? "" : "s"} on
              file. The standard is three — award anyway if this is a single-source item.
            </p>
          )}

          {/* The sheet decides nothing. It flags the cheapest cell per item and the
            * top of the ranking, and leaves every column awardable — the buyer picks,
            * and the PO is raised from whichever quote they picked. */}
          {comparison && (
            <QuotationComparison
              comparison={comparison}
              awardedQuotationId={awardedQuote?.id ?? null}
              poId={rfq?.po_id ?? null}
              poNo={rfq?.po_no ?? null}
              busy={busy}
              onAward={(quotationId) => award.mutate(quotationId)}
              onCreatePo={(quotationId) => raisePo.mutate(quotationId)}
              onOpenPo={() => nav(`/pos/${rfq?.po_id}`)}
            />
          )}
        </>
      )}

      {rfq && <ApprovalTrail docType="RFQ" docId={rfq.id} />}
    </div>
  );
}
