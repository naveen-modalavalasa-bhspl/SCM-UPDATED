import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { Can, ErrorBanner, PageHeader, ResponsiveList, Select, StatusPill, useToast, type Column } from "@/shared/components";
import { Button } from "../components/ActionButton";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import { errorMessage } from "@/shared/api/errors";
import { approvalTrailApi, approvalTrailKey, poApi, rfqApi } from "../api";
import { ApprovalTrail } from "../components/ApprovalTrail";
import {
  DetailShell, SectionCard, FactGrid, RefChips, RailStat, DocRef,
} from "../components/DetailKit";
import { QuotationComparison } from "../components/QuotationComparison";
import type { RFQItem, RFQVendor } from "../types";
import { TONE_APPROVE, TONE_REJECT, TONE_SUBMIT } from "@/shared/components/tones";

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
    mutationFn: (quotationIds: number[]) => rfqApi.award(rfqId, quotationIds),
    onSuccess: refresh("Selected quotations awarded"),
  });
  /** Raise the order for one winning quotation after another, reporting PER VENDOR.
   *
   *  Sequential on purpose: the PO number is minted under a row lock, so firing them
   *  together only queues them behind each other in the database. A split can refuse on
   *  one supplier and be fine on the rest, and a single toast would hide which. */
  const raisePosFor = async (
    winners: { id: number; vendor_name?: string | null }[],
  ) => {
    const raised: string[] = [];
    const failed: string[] = [];
    for (const winner of winners) {
      const who = winner.vendor_name ?? `Quotation ${winner.id}`;
      try {
        const po = await poApi.createFromQuotation(winner.id);
        raised.push(`${po.po_no} (${po.vendor_name ?? who})`);
      } catch (error) {
        failed.push(`${who}: ${errorMessage(error)}`);
      }
    }
    return { raised, failed };
  };

  /** Award the split AND raise every order it decided, in one press.
   *
   *  The two acts stay separate on the server — awarding picks the offer, `po.create`
   *  raises the order, and each order still lands in DRAFT and climbs the PO ladder.
   *  What is joined here is only the BUTTON: a split award across four suppliers meant
   *  four more presses down the sheet, and a buyer who stopped halfway left part of a
   *  decided tender unordered with nothing saying so.
   *
   *  The winners are read back off the sheet rather than taken from the allocations just
   *  sent: a supplier can hold more than one offer on an RFQ, and only the server knows
   *  which of them it accepted. Vendors already on a live order are skipped — on a
   *  re-award they keep what they won, and it is already ordered. */
  const awardSplit = useMutation({
    mutationFn: async (
      allocations: { item_id: number; vendor_id: number; quantity: number }[],
    ) => {
      const awarded = await rfqApi.awardSplit(rfqId, allocations);
      const sheet = await rfqApi.comparison(rfqId, method || undefined);
      const hasNewBalance = (quotationId: number, vendorId: number) => {
        const vendor = (awarded.vendors ?? []).find((row) => row.vendor_id === vendorId);
        const target = vendor?.awarded_quantities;
        // A split award can make a second PO for the amount added above this
        // supplier's live PO quantity. A whole-quote award still only gets one PO.
        if (!target) {
          return !(awarded.purchase_orders ?? []).some(
            (po) => po.quotation_id === quotationId,
          );
        }
        const alreadySent = vendor?.live_allocated_quantities ?? {};
        return Object.entries(target).some(([itemId, quantity]) =>
          Number(quantity) > Number(alreadySent[itemId] ?? 0));
      };
      return raisePosFor((sheet.quotations ?? [])
        .filter((quote) => quote.status === "ACCEPTED"
          && hasNewBalance(quote.id, quote.vendor_id)));
    },
    onSuccess: ({ raised, failed }) => {
      queryClient.invalidateQueries({ queryKey: ["rfq", id] });
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      queryClient.invalidateQueries({ queryKey: ["rfq-comparison", id] });
      queryClient.invalidateQueries({ queryKey: ["pos"] });
      toast.success(raised.length
        ? `Items awarded — raised ${raised.join(", ")}`
        : "Items awarded between suppliers");
      // Named one by one rather than counted: "2 failed" leaves the buyer opening every
      // vendor's column to find out which two.
      failed.forEach((line) => toast.error(line));
    },
  });

  // The offer that won. Read off the comparison rather than off the RFQ's awarded
  // vendor id: a vendor can hold more than one quotation on an RFQ (they revise), and
  // the PO is raised against the exact quote that was accepted, not against the vendor.
  const awardedQuoteIds = (comparison?.quotations ?? [])
    .filter((q) => q.status === "ACCEPTED").map((q) => q.id);

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
      queryClient.invalidateQueries({ queryKey: ["rfq-comparison", id] });
      queryClient.invalidateQueries({ queryKey: ["pos"] });
      toast.success(`${po.po_no} raised from ${po.vendor_name ?? "the winner"}`);
    },
  });

  /** Awarded vendors with no live purchase order against them yet, in column order.
   *
   *  The server decides what "live" means — a rejected or cancelled order stops being
   *  listed on the RFQ, which is what puts its vendor back in this list. */
  const pendingPoQuotes = awardedQuoteIds.filter((quotationId) =>
    !(rfq?.purchase_orders ?? []).some((po) => po.quotation_id === quotationId));

  /** An awarded tender can be awarded again while some of it is unordered: a purchase
   *  order rejected in approval hands its quantity back, and the only prices anybody
   *  quoted for that work are on this sheet. Vendors already on a live order keep what
   *  they won — the server enforces that; this only decides whether to offer the sheet. */
  // A supplier can already have PO-A for 6 and still need PO-B for the extra 4
  // after the buyer increases its split award to 10. That unfinished balance must
  // reopen the re-share action even though the original PO remains live.
  const hasUnorderedSplitBalance = (rfq?.vendors ?? []).some((vendor) =>
    Object.entries(vendor.awarded_quantities ?? {}).some(([itemId, awardedQuantity]) =>
      Number(awardedQuantity) > Number(
        vendor.live_allocated_quantities?.[itemId] ?? 0,
      )));
  // An RFQ can still have room even when every accepted quotation already has a PO.
  // Example: the first PO bought 5 of 10 paper. The buyer must be able to re-share
  // the remaining 5, which will make a new balance PO; testing only "has a PO" hid
  // that action and incorrectly forced a cancellation of the valid first order.
  const hasRemainingRfqQuantity = (rfq?.items ?? []).some((item) => {
    const reportsLiveAllocation = (rfq?.vendors ?? []).some(
      (vendor) => vendor.live_allocated_quantities != null,
    );
    const allocated = reportsLiveAllocation
      ? (rfq?.vendors ?? []).reduce((sum, vendor) => sum + Number(
        vendor.live_allocated_quantities?.[String(item.item_id)] ?? 0,
      ), 0)
      : (rfq?.purchase_orders ?? []).reduce((sum, po) =>
        sum + Number(po.item_quantities?.[String(item.item_id)] ?? 0), 0);
    return allocated < Number(item.quantity);
  });
  const reawardable = rfq?.status === "AWARDED"
    && (pendingPoQuotes.length > 0 || hasUnorderedSplitBalance || hasRemainingRfqQuantity);
  /** The quantity a supplier currently holds on live PO lines.  Unlike the saved
   * award split, this immediately drops a PO that is rejected or cancelled. */
  const liveAllocatedQuantities = Object.fromEntries(
    (rfq?.vendors ?? [])
      .filter((vendor) => vendor.live_allocated_quantities)
      .map((vendor) => [vendor.vendor_id,
        vendor.live_allocated_quantities as Record<string, number>]),
  );

  const busy = submit.isPending || approve.isPending || reject.isPending
    || close.isPending || award.isPending || awardSplit.isPending || raisePo.isPending;

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
          <input
            type="text" inputMode="decimal" className="h-11 w-28 rounded-md border border-line bg-content1 px-3 text-sm text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
            value={qtyEdits[r.id] ?? String(r.quantity)}
            onChange={(e) => setQtyEdits((current) => ({ ...current, [r.id]: e.target.value }))}
            title="Approved quantity — up to the source document quantity; 0 removes the line."
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
                <Button className={TONE_SUBMIT} disabled={busy} onClick={() => submit.mutate()}>
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
                <Button className={TONE_REJECT} variant="subtle" disabled={busy} onClick={() => reject.mutate()}>
                  Reject
                </Button>
                <Button className={TONE_APPROVE} disabled={busy} onClick={() => approve.mutate()}>
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
          </>
        }
      />

      <ErrorBanner error={error ?? submit.error ?? approve.error ?? reject.error ?? close.error
        ?? award.error ?? awardSplit.error ?? raisePo.error ?? saveQuantities.error} />

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
                    { label: "Shipment Address", value: rfq.warehouse_name ?? "\u2014" },
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
                      Adjust quantities before approving — up to the source document quantity; 0 removes the line. The approved number is what the vendor will be asked to quote/supply.
                    </p>
                  )}
                  <ResponsiveList
                    editable
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
                            <input
                              type="text" inputMode="decimal" className="h-11 w-28 rounded-md border border-line bg-content1 px-3 text-sm text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
                              value={qtyEdits[r.id] ?? String(r.quantity)}
                              onChange={(e) => setQtyEdits((current) => ({ ...current, [r.id]: e.target.value }))}
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
                    {comparison.responded} of {comparison.rfq.vendor_count} quote{comparison.rfq.vendor_count === 1 ? "" : "s"} on file.
                  </p>
                )}
                {/* The sheet decides nothing. It flags the cheapest cell per item and
                    the top of the ranking, and leaves every column awardable. */}
                {comparison
                  ? (
                    <QuotationComparison
                      comparison={comparison}
                      awardedQuotationIds={awardedQuoteIds}
                      purchaseOrders={rfq?.purchase_orders ?? []}
                      busy={busy}
                      reawardable={reawardable}
                      liveAllocatedQuantities={liveAllocatedQuantities}
                      onAward={(quotationIds) => award.mutate(quotationIds)}
                      onAwardSplit={(allocations) => awardSplit.mutate(allocations)}
                      onCreatePo={(quotationId) => raisePo.mutate(quotationId)}
                      onOpenPo={(poId) => nav(`/pos/${poId}`)}
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
              {(rfq.purchase_orders ?? []).length > 0 && (
                <div className="mt-4 space-y-3 border-t border-line/60 pt-4">
                  {(rfq.purchase_orders ?? []).map((po) => (
                    <div key={po.id} className="flex items-center justify-between gap-2">
                      <DocRef label={po.vendor_name ?? "Order"} no={po.po_no}
                              onOpen={() => nav(`/pos/${po.id}`)} />
                      <StatusPill status={po.status} />
                    </div>
                  ))}
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
