import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import {
  Button, Can, ErrorBanner, Input, PageHeader, ResponsiveList, Select,
  StatusPill, useToast, type Column,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import { approvalTrailApi, approvalTrailKey, poApi, rfqApi } from "../api";
import { ApprovalTrail } from "../components/ApprovalTrail";
import {
  DetailShell, SectionCard, FactGrid, RefChips, RailStat, DocRef,
} from "../components/DetailKit";
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
  // Expanded by default so an approver immediately sees the editable quantities
  // — in `PENDING_APPROVAL` the decision is about how much. Collapsing behind
  // "View" hid the one field the approval exists to change (see screenshot).
  const [linesExpanded, setLinesExpanded] = useState(true);

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
  const canDecide = rfq?.awaiting_me ?? (rfq?.status === "PENDING_APPROVAL");
  // Editing the asked-for quantity is part of approving it, so it follows the
  // same gate — an approver who cannot sign must not change the ask.
  const editableQty = !!canDecide && can("rfq.approve");

  // Auto-expand line items when the approver can edit — the quantities ARE the decision
  useEffect(() => {
    if (editableQty) setLinesExpanded(true);
  }, [editableQty]);

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
    // The approval trail is engine state, and pressing Approve here CHANGES it.
    // Without this the page kept showing the rung it was on before the press and
    // only a full reload caught up. Keyed on the prefix so one line covers every
    // document type this page can be showing.
    queryClient.invalidateQueries({ queryKey: ["procurement", "approval-trail"] });
    toast.success(message);
  };

  // The approver's own edit: how much, and nothing else. `rfq.approve` reaches it —
  // the buyer's Edit screen needs `rfq.create`, which an approver rarely holds, and
  // the deadline, the vendors and the item list are not theirs to change anyway.
  // The approved quantity is what the supplier is asked to price — `_publish_rfq`
  // copies `RFQItem.quantity` into the draft quotation at approval time.
  const [qtyEdits, setQtyEdits] = useState<Record<number, string>>({});
  const saveQuantities = useMutation({
    mutationFn: () => rfqApi.setQuantities(
      rfqId,
      Object.entries(qtyEdits)
        .filter(([, value]) => value !== "" && Number(value) >= 0)
        .map(([lineId, value]) => ({ id: Number(lineId), quantity: Number(value) })),
    ),
    onSuccess: () => { setQtyEdits({}); refresh("Quantities updated — supplier will be asked for the new quantities")(); },
    onError: (e: unknown) => {
      // Let ErrorBanner show it, but also surface immediately
      // eslint-disable-next-line no-console
      console.error(e);
    },
  });

  const submit = useMutation({ mutationFn: () => rfqApi.submit(rfqId), onSuccess: refresh("Sent for approval") });
  const approve = useMutation({
    mutationFn: async () => {
      // Save any pending quantity edits before approving — an approver who trims
      // 12 -> 10 and presses "Approve & publish" expects 10 to be what the vendor sees.
      // Without this the edit is discarded and the supplier is asked for the original.
      const edits = Object.entries(qtyEdits)
        .filter(([, value]) => {
          if (value === "") return false;
          const n = Number(value);
          return !Number.isNaN(n) && n >= 0;
        })
        .map(([lineId, value]) => ({ id: Number(lineId), quantity: Number(value) }));

      if (edits.length > 0) {
        await rfqApi.setQuantities(rfqId, edits);
        setQtyEdits({});
      }
      return rfqApi.approve(rfqId);
    },
    onSuccess: () => { setQtyEdits({}); refresh("Approved — vendors can now see the approved quantities")(); },
  });
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
            type="number" min="0" max={String(r.quantity)} step="0.001" className="w-28"
            value={qtyEdits[r.id] ?? String(r.quantity)}
            onChange={(e) => setQtyEdits({ ...qtyEdits, [r.id]: e.target.value })}
            title="Approved quantity — decrease only, 0 removes the line. Supplier will be asked for this number."
            aria-label={`Quantity for ${r.item_name ?? r.item_id}`}
          />
          <span className="text-xs text-muted w-10 text-left">{r.uom_code ?? ""}</span>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-danger hover:bg-danger/10"
            onClick={() => setQtyEdits({ ...qtyEdits, [r.id]: "0" })}
            title="Remove item from RFQ"
          >
            <Trash2 className="w-4 h-4" />
          </button>
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
        back={{ to: "/procurement/rfqs", label: "Back to RFQs" }}
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
            {canDecide && (
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

      <ErrorBanner error={error ?? submit.error ?? approve.error ?? reject.error ?? close.error ?? award.error ?? raisePo.error ?? saveQuantities.error} />

      <DetailShell
        main={(
          <>
            {rfq && (
              <SectionCard title="Tender">
                <FactGrid
                  facts={[
                    { label: "Closes", value: rfq.due_date ? fmtDate(rfq.due_date) : "No deadline" },
                    { label: "Replies", value: `${rfq.response_count} of ${rfq.vendor_count}` },
                    {
                      label: "Requisition",
                      value: rfq.requisition_id
                        ? <DocRef no={rfq.requisition_no ?? `#${rfq.requisition_id}`}
                          onOpen={() => nav(`/procurement/requisitions/${rfq.requisition_id}`)} />
                        : <DocRef no={rfq.consolidation_no} />,
                    },
                    { label: "Priority", value: rfq.priority ?? "Normal" },
                    { label: "Department", value: rfq.department_name ?? "\u2014" },
                    { label: "Warehouse", value: rfq.warehouse_name ?? "\u2014" },
                    { label: "Project", value: rfq.project_name ?? "\u2014" },
                    { label: "Company", value: rfq.company_name ?? "\u2014" },
                  ]}
                />

                <div className="mt-4 border-t border-line/60 pt-4">
                  <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
                    Indents behind it
                  </div>
                  <div className="mt-1.5">
                    <RefChips items={(rfq.source_indent_nos ?? []).map((no) => ({ no }))} />
                  </div>
                </div>

                {rfq.terms && (
                  <div className="mt-4 border-t border-line/60 pt-4">
                    <span className="block mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
                      Payment terms
                    </span>
                    <p className="text-sm text-body">{rfq.terms}</p>
                  </div>
                )}
              </SectionCard>
            )}

            <SectionCard
              title="Line Items"
              className="p-2"
              action={
                <Button
                  variant="subtle"
                  onClick={() => setLinesExpanded(!linesExpanded)}
                  className="h-8 text-xs flex items-center gap-1"
                >
                  {linesExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {linesExpanded ? "Hide" : "View"}
                </Button>
              }
            >
              {linesExpanded && (
                <>
                  {editableQty && (
                    <p className="px-3 pb-2 text-xs text-muted">
                      Adjust quantities before approving — decrease only, 0 removes the line. The approved number is what the vendor will be asked to quote/supply.
                    </p>
                  )}
                  <ResponsiveList
                    data={rfq?.items ?? []}
                    columns={lineColumns}
                    keyOf={(r) => r.id}
                    loading={isLoading}
                    empty="No lines on this RFQ."
                    renderCard={(r) => (
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-ink">{r.item_name ?? `Item ${r.item_id}`}</div>
                        <div className="text-xs text-muted font-mono">{r.item_code ?? ""}</div>
                        {editableQty ? (
                          <div className="flex items-center gap-2">
                            <Input
                              type="number" min="0" max={String(r.quantity)} step="0.001" className="w-28"
                              value={qtyEdits[r.id] ?? String(r.quantity)}
                              onChange={(e) => setQtyEdits({ ...qtyEdits, [r.id]: e.target.value })}
                              aria-label={`Quantity for ${r.item_name ?? r.item_id}`}
                            />
                            <span className="text-xs text-muted">{r.uom_code ?? ""}</span>
                            <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-md text-danger hover:bg-danger/10" onClick={() => setQtyEdits({ ...qtyEdits, [r.id]: "0" })} title="Remove item from RFQ">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="text-xs text-muted">
                            {r.quantity} {r.uom_code ?? ""}
                            {r.required_date ? ` \u00b7 needed by ${fmtDate(r.required_date)}` : ""}
                          </div>
                        )}
                      </div>
                    )}
                  />
                  {editableQty && (
                    <div className="flex justify-end border-t border-line/60 p-3">
                      <Button
                        variant="subtle"
                        disabled={saveQuantities.isPending || Object.keys(qtyEdits).length === 0}
                        onClick={() => saveQuantities.mutate()}
                      >
                        {saveQuantities.isPending ? "Saving\u2026" : "Save quantities"}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </SectionCard>

            <SectionCard title="Vendors asked" className="p-2">
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
            </SectionCard>

            {published && (
              <SectionCard
                title="Comparison"
                action={
                  <div className="w-56">
                    <Select
                      value={method || comparison?.evaluation_method || ""}
                      placeholder="Rank by\u2026"
                      options={(methods ?? []).map((m) => ({ value: m.value, label: m.label }))}
                      onChange={setMethod}
                    />
                  </div>
                }
              >
                {comparison && comparison.responded > 0 && !comparison.meets_three_quote_norm && (
                  <p className="mb-3 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
                    {comparison.responded} of 3 quotes on file.
                  </p>
                )}
                {/* The sheet decides nothing. It flags the cheapest cell per item and
                    the top of the ranking, and leaves every column awardable. */}
                {comparison
                  ? (
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
                  )
                  : <p className="py-6 text-center text-sm text-muted">Waiting on quotes.</p>}
              </SectionCard>
            )}
          </>
        )}
        rail={rfq ? (
          <>
            <SectionCard>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Status</span>
                <StatusPill status={rfq.status} />
              </div>
              <div className="mt-4 border-t border-line/60 pt-4">
                <RailStat
                  label={rfq.status === "PENDING_APPROVAL" ? "With" : "Awarded to"}
                  value={(
                    <span className="block truncate text-lg">
                      {rfq.current_approver_name ?? rfq.awarded_vendor_name ?? "\u2014"}
                    </span>
                  )}
                />
              </div>
              {/* Where the award went next. Without it an AWARDED RFQ is a dead end on
                  screen even though the order exists \u2014 the chain only reads forward. */}
              {rfq.po_id && (
                <div className="mt-4 flex items-center justify-between gap-2 border-t border-line/60 pt-4">
                  <DocRef
                    label="Order"
                    no={rfq.po_no ?? `#${rfq.po_id}`}
                    onOpen={() => nav(`/pos/${rfq.po_id}`)}
                  />
                  <StatusPill status={rfq.po_status ?? "DRAFT"} />
                </div>
              )}
            </SectionCard>

            <ApprovalTrail docType="RFQ" docId={rfq.id} />
          </>
        ) : null}
      />
    </div>
  );
}
