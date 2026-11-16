import { departmentOf } from "../orgScope";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ChevronDown, ChevronRight, Lock, Unlock, Snowflake, Trash2 } from "lucide-react";
import {
  Can, ConfirmModal, ErrorBanner, PageHeader, ResponsiveList, StatusPill, Textarea,
  useToast, type Column,
} from "@/shared/components";
import { Button } from "../components/ActionButton";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import { QuantityInput } from "@/shared/components/QuantityInput";
import { useUomDecimals } from "@/shared/hooks/useUomDecimals";
import { quantityProblem } from "@/shared/quantity";
import { approvalTrailApi, approvalTrailKey, rfqApi } from "../api";
import { ApprovalTrail } from "../components/ApprovalTrail";
import {
  DetailShell, SectionCard, FactGrid, RailStat, DocRef,
} from "../components/DetailKit";
import type { RFQItem, RFQVendor } from "../types";
import { TONE_APPROVE, TONE_REJECT, TONE_SUBMIT } from "@/shared/components/tones";
import { writeToClipboard } from "@/shared/clipboard";
import { CombinationTag } from "@/shared/combination";

/**
 * One RFQ: its lines, who was asked, and — once quotes are in — WHO answered.
 *
 * The comparison and the award live in Price Compare (2026-09-26): a tender
 * room carries no other vendor's price. This page carries the tender itself and
 * a Quotes strip over its responses, plus the Freeze Prices lock that closes
 * pricing before the sheet is read.
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
  // Freeze / reopen confirm dialogs. The reason is required by the SERVER on
  // unfreeze; requiring it here too means the confirm button never sends a press
  // that would 403.
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [unfreezeOpen, setUnfreezeOpen] = useState(false);
  const [unfreezeReason, setUnfreezeReason] = useState("");

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
  const { can, me } = useAuth();
  const isAdmin = can("admin.workflow.manage") || Boolean(me?.roles.includes("ADMIN")) || Boolean(me?.roles.includes("SUPERUSER"));
  // In PENDING_APPROVAL, allowed to decide if assigned to me OR if user has Admin override power
  const canDecide = rfq?.status === "PENDING_APPROVAL" && (Boolean(rfq?.awaiting_me) || isAdmin);
  // Editing the asked-for quantity is part of approving it, so it follows the
  // same gate — an approver who cannot sign must not change the ask.
  const editableQty = canDecide && (can("rfq.approve") || isAdmin);

  // Auto-expand line items when the approver can edit — the quantities ARE the decision
  useEffect(() => {
    if (editableQty) setLinesExpanded(true);
  }, [editableQty]);

  // Previewing a different ranking is a query parameter, not a save: looking at the
  // quotes another way is not choosing one, so the RFQ's own method is untouched
  // until somebody edits it on the form.
  // The comparison moved to Price Compare (2026-09-26) — this page is the tender
  // room and carries NO other vendor's price. What remains here is who was asked
  // and who answered; the method picker went with the sheet.

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
  const uomDecimals = useUomDecimals();
  // The unit's own rule for the number in the box (places, minimum). Only an edited
  // line is judged: an untouched one shows the quantity the document already holds.
  const qtyProblem = (r: { id: number; quantity: number | string; uom_code?: string | null }) =>
    r.id in qtyEdits
      ? quantityProblem(qtyEdits[r.id], { decimals: uomDecimals(r.uom_code), unit: r.uom_code })
      : null;
  const hasInvalidQty = (rfq?.items ?? []).some((r: any) => Boolean(qtyProblem(r)));
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
      if (hasInvalidQty) throw new Error("Correct the highlighted quantities before approving.");
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
    // The approval/publish itself can have already gone through even though this
    // request came back as an error (e.g. a courtesy vendor email failed after
    // the decision was committed) — refetch so a second press isn't needed and
    // the screen shows the real status instead of a stale one next to a toast.
    onError: (e: any) => {
      toast.error(e?.message ?? "Could not approve the RFQ. Checking the latest status…");
      queryClient.invalidateQueries({ queryKey: ["rfq", id] });
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
    },
  });
  // Reject and Send back both ask for a reason in a dialog; the server refuses either
  // without one. `reasonFor` says which of the two the open dialog is for.
  const [reasonFor, setReasonFor] = useState<"reject" | "send_back" | null>(null);
  const [reason, setReason] = useState("");
  const closeReason = () => { setReasonFor(null); setReason(""); };
  const reject = useMutation({
    mutationFn: (comments: string) => rfqApi.reject(rfqId, comments),
    onSuccess: () => { closeReason(); refresh("Rejected")(); },
  });
  const sendBack = useMutation({
    mutationFn: (comments: string) => rfqApi.sendBack(rfqId, comments),
    onSuccess: (updated) => {
      closeReason();
      refresh(`Sent back to ${updated.current_approver_name ?? "the previous approver"}`)();
    },
  });
  // The holder of a sent-back RFQ: a comment (optional to resubmit, required to pass
  // it further down).
  const [fixComment, setFixComment] = useState("");
  const [fixError, setFixError] = useState("");
  const resubmit = useMutation({
    mutationFn: () => rfqApi.resubmitCorrection(rfqId, fixComment.trim()),
    onSuccess: () => { setFixComment(""); refresh("Resubmitted for approval")(); },
  });
  const sendFurtherBack = useMutation({
    mutationFn: () => rfqApi.sendBackFurther(rfqId, fixComment.trim()),
    onSuccess: (updated) => {
      setFixComment("");
      refresh(`Sent back to ${updated.current_approver_name ?? "the previous approver"}`)();
    },
  });
  const sendFurtherBackWithReason = () => {
    if (sendFurtherBack.isPending) return;
    if (!fixComment.trim()) {
      setFixError("Enter a reason before sending this RFQ further back.");
      return;
    }
    setFixError("");
    sendFurtherBack.mutate();
  };
  const close = useMutation({ mutationFn: () => rfqApi.close(rfqId), onSuccess: refresh("Closed to further quotes") });

  // ── Freeze Prices (2026-09-26) ────────────────────────────────────────────
  // The lock that stops pricing while the sheet is read, and the gate every PO
  // raised off this tender hangs on. The server re-checks every door; these
  // mutations only carry the press.
  const freeze = useMutation({
    mutationFn: () => rfqApi.freeze(rfqId),
    // The dialog closes itself on success: left open over a frozen tender, a second
    // press is refused with "already frozen".
    onSuccess: () => {
      setFreezeOpen(false);
      refresh("Prices frozen — suppliers can no longer change their quotes")();
    },
  });
  const unfreeze = useMutation({
    mutationFn: (reason: string) => rfqApi.unfreeze(rfqId, reason),
    onSuccess: () => {
      setUnfreezeOpen(false);
      setUnfreezeReason("");
      refresh("Bidding reopened — suppliers can quote again")();
    },
  });

  const busy = submit.isPending || approve.isPending || reject.isPending
    || sendBack.isPending || resubmit.isPending
    || close.isPending || freeze.isPending || unfreeze.isPending;

  // ── The Quotes strip (2026-09-26) ─────────────────────────────────────────
  // One card per supplier who answered: WHO replied and WHEN, never at what
  // price — the figures live behind `rfq.compare` on Price Compare. The
  // quotations list endpoint is scoped server-side to the caller's rung, so the
  // strip shows nothing a login could not already read.
  const { data: quoteRows } = useQuery({
    queryKey: ["rfq-quotes-strip", id],
    queryFn: () => rfqApi.quotations({ rfq_id: rfqId, page: 1, size: 100 }),
    enabled: published,
  });
  const responseCards = (quoteRows?.items ?? [])
    .filter((q) => q.status !== "DRAFT")
    .map((q) => ({
      quotationId: q.id,
      vendorId: q.vendor_id,
      vendorName: q.vendor_name,
      submittedAt: q.submitted_at,
      // Won is a fact about the AWARD; the rest is the quote's own status.
      pill: q.status === "ACCEPTED" ? "ACCEPTED" : q.status,
    }));

  const copyInvite = async (vendorId: number, path: string) => {
    const copied = await writeToClipboard(`${location.origin}${path}`);
    if (!copied) {
      toast.error("Copy did not work. Select the text with your mouse and press Ctrl+C.");
      return;
    }
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
          <CombinationTag value={r} className="mt-1" />
        </div>
      ),
    },
    {
      key: "qty",
      header: "Quantity",
      className: "text-right",
      render: (r) => (editableQty ? (
        <div className="flex items-center justify-end gap-2">
          <QuantityInput
            decimals={uomDecimals(r.uom_code)}
            className="h-11 w-28 rounded-md border border-line bg-content1 px-3 text-sm text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
            data-uom={r.uom_code ?? ""}
            value={qtyEdits[r.id] ?? String(r.quantity)}
            onChange={(raw) => setQtyEdits((current) => ({ ...current, [r.id]: raw }))}
            aria-invalid={Boolean(qtyProblem(r))}
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
              <div className="flex items-center gap-2">
                <StatusPill
                  status={rfq.status === "PENDING_APPROVAL" && trail.data?.stage_name
                    ? `Pending at ${trail.data.stage_name}`
                    : rfq.status}
                />
                {isAdmin && rfq.status === "PENDING_APPROVAL" && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-500/10 text-purple-700 border border-purple-500/20">
                    Admin Override
                  </span>
                )}
                {rfq.is_price_frozen ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-700 border border-amber-500/20">
                    <Lock className="h-3.5 w-3.5" /> Locked (Prices Frozen)
                  </span>
                ) : published ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-700 border border-emerald-500/20">
                    <Unlock className="h-3.5 w-3.5" /> Unlocked
                  </span>
                ) : null}
              </div>
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
            {canDecide && (can("rfq.approve") || isAdmin) && (
              <>
                <Button variant="subtle" disabled={busy} onClick={() => setReasonFor("send_back")}>
                  Send back
                </Button>
                <Button className={TONE_REJECT} variant="subtle" disabled={busy} onClick={() => setReasonFor("reject")}>
                  Reject
                </Button>
                <Button className={TONE_APPROVE} disabled={busy} onClick={() => approve.mutate()}>
                  {isAdmin && !rfq?.awaiting_me ? "Approve (Admin Override)" : "Approve & publish"}
                </Button>
              </>
            )}
            {rfq?.status === "PUBLISHED" && (
              <Can do="rfq.create">
                <Button variant="subtle" disabled={busy} onClick={() => close.mutate()}>
                  Close early
                </Button>
              </Can>
            )}
            {/* Lock / Unlock Toggle buttons */}
            {published && !rfq?.is_price_frozen && (
              <Can do="rfq.approve">
                <Button className="bg-amber-600 hover:bg-amber-700 text-white font-medium shadow-sm inline-flex items-center gap-1.5" disabled={busy}
                        onClick={() => setFreezeOpen(true)}>
                  <Lock className="h-4 w-4" /> Lock RFQ (Freeze)
                </Button>
              </Can>
            )}
            {rfq?.is_price_frozen && (
              <Can do="rfq.approve">
                <Button variant="subtle" className="text-emerald-700 hover:bg-emerald-50 border border-emerald-200 inline-flex items-center gap-1.5" disabled={busy}
                        onClick={() => setUnfreezeOpen(true)}>
                  <Unlock className="h-4 w-4" /> Unlock RFQ (Reopen)
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
        ?? sendBack.error ?? resubmit.error
        ?? freeze.error ?? unfreeze.error ?? saveQuantities.error} />

      {rfq?.status === "RETURNED_FOR_CORRECTION" && (
        <div className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-bold text-amber-900">
            Sent back to {rfq.correction?.owner_name ?? rfq.current_approver_name ?? "the previous approver"}
            {rfq.correction?.returned_by_name ? ` by ${rfq.correction.returned_by_name}` : ""}
          </p>
          {rfq.correction?.reason && (
            <p className="mt-2 rounded-xl bg-white p-2.5 font-medium text-ink ring-1 ring-amber-200">
              Reason: {rfq.correction.reason}
            </p>
          )}
          {rfq.can_resubmit_correction && (
            <>
              <p className="mt-2 text-amber-900">
                {rfq.can_edit_correction
                  ? "Press Edit RFQ to change it (same form as when it was raised), save, then resubmit."
                  : rfq.can_pass_correction_down
                    ? "You can resubmit it as it is, or send it further back to the person below you."
                    : "Add a comment if needed and resubmit."}
              </p>
              <div className="mt-3">
                <Textarea
                  value={fixComment}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setFixComment(e.target.value); setFixError(""); }}
                  minRows={1}
                  placeholder={rfq.can_pass_correction_down ? "Comment (required to send further back)" : "Comment (optional)"}
                  aria-label="Comment"
                />
              </div>
              {fixError && <p className="mt-2 font-semibold text-red-600">{fixError}</p>}
              {sendFurtherBack.error && <p className="mt-2 font-semibold text-red-600">{(sendFurtherBack.error as Error).message}</p>}
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                {rfq.can_edit_correction && (
                  <Button variant="subtle" disabled={busy} onClick={() => nav(`/procurement/rfqs/${rfqId}/edit`)}>
                    Edit RFQ
                  </Button>
                )}
                {rfq.can_pass_correction_down && (
                  <Button variant="subtle" disabled={busy || sendFurtherBack.isPending} onClick={sendFurtherBackWithReason}>
                    {sendFurtherBack.isPending ? "Sending…" : "Send further back"}
                  </Button>
                )}
                <Button className={TONE_SUBMIT} disabled={busy || sendFurtherBack.isPending} onClick={() => resubmit.mutate()}>
                  {resubmit.isPending ? "Resubmitting…" : "Resubmit for approval"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

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
                    { label: "Department", value: departmentOf(rfq) ?? "\u2014" },
                    { label: "Shipment Address", value: rfq.warehouse_name ?? "\u2014" },
                    { label: "Project", value: rfq.project_name ?? "\u2014" },
                    { label: rfq.organization_name ? "Organisation" : "Company",
                      value: rfq.organization_name ?? rfq.company_name ?? "\u2014" },
                  ]}
                />



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
                        <CombinationTag value={r} />
                        {editableQty ? (
                          <div className="flex items-center gap-2">
                            <QuantityInput
                              decimals={uomDecimals(r.uom_code)}
                              className="h-11 w-28 rounded-md border border-line bg-content1 px-3 text-sm text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
                              data-uom={r.uom_code ?? ""}
                              value={qtyEdits[r.id] ?? String(r.quantity)}
                              onChange={(raw) => setQtyEdits((current) => ({ ...current, [r.id]: raw }))}
                              aria-invalid={Boolean(qtyProblem(r))}
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
                        disabled={saveQuantities.isPending || hasInvalidQty || Object.keys(qtyEdits).length === 0}
                        onClick={() => saveQuantities.mutate()}
                      >
                        {saveQuantities.isPending ? "Saving\u2026" : "Save quantities"}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </SectionCard>

            <SectionCard title="Vendors" className="p-2">
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

            {/* ── Supplier responses (2026-09-26) ────────────────────────────
                The comparison and the award moved to Price Compare; this strip is
                what a tender room carries: WHO answered, not what they charged. */}
            {published && (
              <SectionCard
                title="Supplier responses"
                action={
                  <Can do="rfq.compare">
                    <Button variant="subtle" className="h-8 text-xs"
                            onClick={() => nav(`/procurement/compare?rfq=${rfqId}`)}>
                      Compare &amp; award
                    </Button>
                  </Can>
                }
              >
                {responseCards.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted">
                    No supplier responses yet — vendors see this tender on their portal.
                  </p>
                ) : (
                  <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
                    {responseCards.map((card) => (
                      <button
                        key={card.quotationId}
                        type="button"
                        onClick={() => nav(`/procurement/quotations/${card.quotationId}`)}
                        className="rounded-2xl border border-line bg-surface-2/40 p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand/30 min-w-0"
                      >
                        <div className="flex items-start justify-between gap-2 min-w-0">
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-xs font-bold text-brand">
                              {(card.vendorName ?? "?").trim().charAt(0).toUpperCase()}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-ink" title={card.vendorName ?? undefined}>
                                {card.vendorName ?? `Vendor ${card.vendorId}`}
                              </div>
                              <div className="truncate text-[11px] text-muted">
                                {card.submittedAt ? `Submitted ${fmtDate(card.submittedAt)}` : "—"}
                              </div>
                            </div>
                          </div>
                          <div className="shrink-0 pt-0.5">
                            <StatusPill status={card.pill} />
                          </div>
                        </div>
                        <div className="mt-3 flex items-center justify-between border-t border-line/60 pt-2 text-xs">
                          <span className="text-muted">View quotation</span>
                          <span className="font-medium text-brand">→</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
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
              {/* The freeze, in the rail where the status lives: when the door was
                  closed, by whom, and how many quotes were in at the time. */}
              {rfq.is_price_frozen && (
                <div className="mt-4 space-y-1 border-t border-line/60 pt-4">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
                    <Snowflake className="h-3.5 w-3.5" /> Prices frozen
                  </div>
                  <p className="text-[11px] text-muted">
                    {rfq.frozen_by_name ?? "A buyer"}
                    {rfq.frozen_at ? ` · ${fmtDate(rfq.frozen_at)}` : ""}
                    {rfq.frozen_at_revision != null
                      ? ` · ${rfq.frozen_at_revision} quote${rfq.frozen_at_revision === 1 ? "" : "s"} in`
                      : ""}
                  </p>
                </div>
              )}
            </SectionCard>

            <ApprovalTrail docType="RFQ" docId={rfq.id} />
          </>
        ) : null}
      />

      {/* Freeze / reopen confirms. Each states the consequence in one breath —
          what closes, what opens — because the freeze is the one act on this
          page that changes what a SUPPLIER can do next. */}
      <ConfirmModal
        isOpen={freezeOpen}
        title={`Freeze prices on ${rfq?.rfq_no ?? "this RFQ"}?`}
        message={"Suppliers can no longer quote, re-quote or change prices on this "
          + "tender — not even to accept a change request. You can award and raise "
          + "purchase orders against its quotations. You can reopen bidding later, "
          + "with a recorded reason."}
        confirmLabel="Freeze prices"
        tone="warning"
        busy={freeze.isPending}
        onConfirm={() => freeze.mutate()}
        onClose={() => setFreezeOpen(false)}
      />
      <ConfirmModal
        isOpen={unfreezeOpen}
        title={`Reopen bidding on ${rfq?.rfq_no ?? "this RFQ"}?`}
        message="Suppliers will be able to quote and change prices again. Say why — it is recorded on the tender."
        confirmLabel="Reopen bidding"
        tone="warning"
        busy={unfreeze.isPending}
        confirmDisabled={unfreezeReason.trim().length < 3}
        onConfirm={() => unfreeze.mutate(unfreezeReason.trim())}
        onClose={() => setUnfreezeOpen(false)}
      >
        <Textarea
          value={unfreezeReason}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUnfreezeReason(e.target.value)}
          minRows={2}
          placeholder="e.g. Winning vendor's delivery date slipped — re-opening the tender"
          aria-label="Reason for reopening bidding"
        />
      </ConfirmModal>
      <ConfirmModal
        isOpen={reasonFor !== null}
        title={reasonFor === "reject"
          ? `Reject ${rfq?.rfq_no ?? "this RFQ"}?`
          : `Send ${rfq?.rfq_no ?? "this RFQ"} back?`}
        message={reasonFor === "reject"
          ? "The RFQ will be cancelled. Say why — it is recorded in the approval trail."
          : "It goes back to the previous approver (or the raiser) to correct and resubmit. Say what needs fixing — it is recorded in the approval trail."}
        confirmLabel={reasonFor === "reject" ? "Reject" : "Send back"}
        tone={reasonFor === "reject" ? "danger" : "warning"}
        busy={reject.isPending || sendBack.isPending}
        confirmDisabled={!reason.trim()}
        onConfirm={() => (reasonFor === "reject"
          ? reject.mutate(reason.trim())
          : sendBack.mutate(reason.trim()))}
        onClose={closeReason}
      >
        <Textarea
          value={reason}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReason(e.target.value)}
          minRows={2}
          placeholder="Reason (required)"
          aria-label="Reason"
        />
      </ConfirmModal>
    </div>
  );
}
