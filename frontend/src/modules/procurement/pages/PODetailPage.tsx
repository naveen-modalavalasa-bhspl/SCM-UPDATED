import { useEffect, useMemo, useState } from "react";
import { PackChangesPanel } from "../components/PackChangesPanel";
import { POLinePacking } from "../components/POLinePacking";
import { PackQty } from "@/shared/packing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, Copy, FilePen, Printer, Send, Undo2, X,
  ShoppingCart, Package, Building2, Calendar, Coins, MapPin, FileText, ShieldCheck, History, Sparkles, TrendingDown, Save,
} from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Can, Card, Field, Input, StatusPill, useToast } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { Button } from "../components/ActionButton";
import { Stepper, type Step } from "@/shared/components/Stepper";
import { poApi } from "../api";
import { revisionLines } from "../types";
import { ApprovalTrail } from "../components/ApprovalTrail";
import { POPaymentsPanel } from "../components/POPaymentsPanel";
import { POApprovalChat } from "../components/POApprovalChat";
import { POCorrectionForm } from "../components/POCorrectionForm";
import { blankPOHeader, POHeaderFields, poHeaderFrom, poHeaderPayload, type POHeaderValue } from "../components/POHeaderFields";
import { LinePicker, type DraftLine } from "../components/LinePicker";
import { alerts } from "@/modules/alerts";
import { fmtDate } from "@/shared/datetime";
import { formatPONo } from "@/shared/format";
import { TONE_APPROVE, TONE_REJECT, TONE_SUBMIT } from "@/shared/components/tones";
import { comboFrom, comboPayload } from "@/shared/combination";
import { CombinationTag } from "@/shared/combination";

const money = (value: number | null | undefined) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value ?? 0);

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
  const [header, setHeader] = useState<POHeaderValue>(blankPOHeader());
  const [linesExpanded, setLinesExpanded] = useState(true);

  const po = useQuery({
    queryKey: ["purchase-order", poId],
    queryFn: () => poApi.get(poId),
    enabled: Number.isFinite(poId) && poId > 0,
  });

  useEffect(() => {
    if (po.data) setHeader(poHeaderFrom(po.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po.data?.id, po.data?.revision_no]);

  useEffect(() => {
    if (po.data) setHeader(poHeaderFrom(po.data));
  }, [po.data]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["purchase-order", poId] });
    qc.invalidateQueries({ queryKey: ["pos"] });
    // RFQ allocation is derived from live PO lines. Mark it stale whenever an order
    // changes so returning from a rejection/cancellation immediately shows the
    // released quantity and enables a re-share where appropriate.
    qc.invalidateQueries({ queryKey: ["rfq"] });
    qc.invalidateQueries({ queryKey: ["rfqs"] });
    qc.invalidateQueries({ queryKey: ["rfq-comparison"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
    qc.invalidateQueries({ queryKey: ["procurement", "approval-trail"] });
  };

  const revisions = useQuery({
    queryKey: ["purchase-order-revisions", poId],
    queryFn: () => poApi.revisions(poId),
    enabled: (po.data?.revision_no ?? 0) > 0,
  });

  const [amending, setAmending] = useState(false);
  // A draft is read in its own cards and edited IN them: Edit swaps the cards for the
  // form in the same place, Save or Cancel swaps them back. It used to show both at
  // once — every figure twice, the saved copy above the form editing it.
  const [editingDraft, setEditingDraft] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [amendLines, setAmendLines] = useState<DraftLine[]>([]);
  const startAmending = () => {
    setAmending(true);
    setAmendLines(
      po.data?.items.map((i: any) => ({
        id: i.id,
        item_id: i.item_id,
        item_code: i.item_code,
        item_name: i.item_name,
        quantity: String(i.quantity),
        original_quantity: String(i.quantity),
        rate: String(i.rate),
        tax_percent: String(i.tax_percent),
        combo: comboFrom(i),
      })) ?? [],
    );
  };

  const amend = useMutation({
    mutationFn: () =>
      poApi.amend(poId, {
        reason: amendReason,
        expected_date: po.data?.expected_date ?? null,
        ...poHeaderPayload(header),
        lines: amendLines.map((l) => ({
          id: l.id ?? null,
          item_id: Number(l.item_id),
          quantity: Number(l.quantity),
          rate: Number(l.rate ?? 0),
          tax_percent: Number(l.tax_percent ?? 0),
          ...comboPayload(l.combo),
        })),
      }),
    onSuccess: (updated) => {
      toast.success(`${formatPONo(updated.po_no, updated.revision_no)} amended — send it for approval again`);
      setAmending(false);
      setAmendReason("");
      qc.invalidateQueries({ queryKey: ["purchase-order-revisions", poId] });
      refresh();
    },
  });

  const decide = useMutation({
    mutationFn: (action: "approve" | "reject") =>
      action === "approve" ? poApi.approve(poId, comments) : poApi.reject(poId, comments),
    onSuccess: (_result, action) => {
      const number = formatPONo(po.data?.po_no, po.data?.revision_no);
      void alerts.success(action === "approve" ? "po.approved" : "po.rejected", { number });
      setComments("");
      refresh();
      if (approvalView || decisionView) nav("/approvals");
    },
    // The approval itself can have gone through even though this request came
    // back as an error (e.g. a courtesy vendor email failed after the decision
    // was committed) — refetch so the screen shows what actually happened
    // instead of leaving the old status up next to an error toast.
    onError: (e: any) => {
      toast.error(e?.message ?? "Could not record the decision. Checking the latest status…");
      refresh();
    },
  });

  const submit = useMutation({
    mutationFn: () => poApi.submit(poId),
    onSuccess: () => {
      void alerts.success("po.submitted", { number: formatPONo(po.data?.po_no, po.data?.revision_no) });
      refresh();
    },
    onError: (e: any) => {
      toast.error(e?.message ?? "Could not submit the order. Checking the latest status…");
      refresh();
    },
  });

  const send = useMutation({
    mutationFn: () => poApi.sendToVendor(poId),
    onSuccess: () => {
      const number = formatPONo(po.data?.po_no, po.data?.revision_no);
      void alerts.success("po.sent_to_vendor", { number, vendor: po.data?.vendor_name ?? "the vendor" });
      refresh();
    },
    onError: (e: any) => {
      toast.error(e?.message ?? "Could not send the order to the vendor. Checking the latest status…");
      refresh();
    },
  });

  const sendWithConfirm = async () => {
    if (send.isPending || !po.data) return;
    if (await alerts.confirm("po.send_vendor", { number: formatPONo(po.data.po_no, po.data.revision_no), vendor: po.data.vendor_name ?? "the vendor" }))
      send.mutate();
  };

  // Send back needs a reason: the person it lands with has to know what to fix.
  const [sendBackError, setSendBackError] = useState("");
  const sendBack = useMutation({
    mutationFn: () => poApi.sendBack(poId, comments.trim()),
    onSuccess: (updated) => {
      toast.success(`Sent back to ${updated.current_approver_name ?? "the previous approver"}`);
      setComments("");
      refresh();
      if (approvalView || decisionView) nav("/approvals");
    },
  });
  const sendBackWithReason = () => {
    if (sendBack.isPending) return;
    if (!comments.trim()) {
      setSendBackError("Enter a reason in Comments before sending this order back.");
      return;
    }
    setSendBackError("");
    sendBack.mutate();
  };

  // The holder of a sent-back PO: a comment (optional to resubmit, required to pass it
  // further down).
  const [fixComment, setFixComment] = useState("");
  const [fixError, setFixError] = useState("");
  const resubmit = useMutation({
    mutationFn: () => poApi.resubmitCorrection(poId, fixComment.trim()),
    onSuccess: () => {
      toast.success("Resubmitted for approval");
      setFixComment("");
      refresh();
    },
  });
  const sendBackFurther = useMutation({
    mutationFn: () => poApi.sendBackFurther(poId, fixComment.trim()),
    onSuccess: (updated) => {
      toast.success(`Sent back to ${updated.current_approver_name ?? "the previous approver"}`);
      setFixComment("");
      refresh();
    },
  });
  const sendBackFurtherWithReason = () => {
    if (sendBackFurther.isPending) return;
    if (!fixComment.trim()) {
      setFixError("Enter a reason before sending this order further back.");
      return;
    }
    setFixError("");
    sendBackFurther.mutate();
  };

  const decideWithConfirm = async (action: "approve" | "reject") => {
    if (decide.isPending || !po.data) return;
    if (action === "reject" && !comments.trim()) {
      setSendBackError("Enter a reason in Comments before rejecting this order.");
      return;
    }
    const number = formatPONo(po.data.po_no, po.data.revision_no);
    const asked =
      action === "approve"
        ? await alerts.confirm("po.approve", { number, amount: money(po.data.total_amount) })
        : await alerts.confirm("po.reject", { number });
    if (asked) decide.mutate(action);
  };

  // ── approval quantity editing (decrease only) ────────────────────────
  const [qtyDraft, setQtyDraft] = useState<Record<number, string>>({});
  const [qtyTouched, setQtyTouched] = useState(false);

  useEffect(() => {
    if (po.data?.items) {
      const map: Record<number, string> = {};
      po.data.items.forEach((it: any) => (map[it.id] = String(it.quantity)));
      setQtyDraft(map);
      setQtyTouched(false);
    }
  }, [po.data?.id, po.data?.items]);

  const qtyChanges = useMemo(() => {
    if (!po.data?.items) return [] as { id: number; quantity: number; prev: number }[];
    return po.data.items
      .map((it: any) => {
        const raw = qtyDraft[it.id];
        const parsed = Number(raw);
        const prev = Number(it.quantity);
        if (!raw || Number.isNaN(parsed)) return null;
        if (parsed === prev) return null;
        return { id: it.id, quantity: parsed, prev };
      })
      .filter(Boolean) as { id: number; quantity: number; prev: number }[];
  }, [qtyDraft, po.data?.items]);

  const hasQtyIncrease = qtyChanges.some((c) => c.quantity > c.prev);
  const hasInvalidQty = qtyChanges.some((c) => c.quantity <= 0);

  const saveQty = useMutation({
    mutationFn: () => poApi.updateApprovalQuantities(poId, qtyChanges.map((c) => ({ id: c.id, quantity: c.quantity }))),
    onSuccess: () => {
      toast.success("Quantities trimmed — vendor will receive the edited numbers");
      setQtyTouched(false);
      refresh();
    },
    onError: (e: any) => toast.error(e?.message ?? "Quantities not saved. Check the numbers and try again."),
  });

  if (po.isLoading) return <p className="p-6 text-sm text-muted">Loading purchase order…</p>;
  if (po.error) return <p className="rounded-lg bg-danger/10 p-4 text-danger">{(po.error as Error).message}</p>;
  if (!po.data) return <p className="p-6 text-muted">Purchase order not found.</p>;

  const { can, me } = useAuth();
  const isAdmin = can("admin.workflow.manage") || Boolean(me?.roles.includes("ADMIN")) || Boolean(me?.roles.includes("SUPERUSER"));
  const canDecide = po.data.status === "PENDING_APPROVAL" && (Boolean(po.data.awaiting_me) || isAdmin);
  const isApprovalPending = po.data.status === "PENDING_APPROVAL" && !!canDecide;
  // CGST+SGST within a state, IGST across one — summed from the lines rather than
  // trusted off `tax_amount`, which says nothing about which split it is.
  const cgstTotal = po.data.items.reduce((sum: number, item: any) => sum + (item.cgst_amount ?? 0), 0);
  const sgstTotal = po.data.items.reduce((sum: number, item: any) => sum + (item.sgst_amount ?? 0), 0);
  const igstTotal = po.data.items.reduce((sum: number, item: any) => sum + (item.igst_amount ?? 0), 0);
  const isIntraState = cgstTotal > 0;
  const canAmend = po.data.amendment_allowed === true;
  const isDraft = po.data.status === "DRAFT";
  // Sent back to the RAISER: only they may fix the details and trim quantities. An
  // approver it was sent back to can only resubmit or pass it further down.
  const canFix = po.data.status === "RETURNED_FOR_CORRECTION" && !!po.data.can_edit_correction;
  const canEditQty = isApprovalPending;
  const isFinished = ["PARTIALLY_RECEIVED", "RECEIVED", "CLOSED", "CANCELLED", "REJECTED"].includes(po.data.status);
  const backTo = decisionView ? "/approvals/decisions" : approvalView ? "/approvals" : "/pos";
  const busy = submit.isPending || send.isPending || decide.isPending || sendBack.isPending;

  const steps: Step[] = (() => {
    const s = po.data.status;
    const vs = po.data.vendor_status;
    const base: Step[] = [
      { id: "draft", label: "Draft", status: "complete" },
      { id: "approved", label: "Approved", status: "upcoming" },
      { id: "sent", label: "Sent to Supplier", status: "upcoming" },
      { id: "accepted", label: "Accepted", status: "upcoming" },
      { id: "received", label: "Received", status: "upcoming" },
    ];
    if (s === "DRAFT" || s === "SUBMITTED" || s === "PENDING_APPROVAL") base[1].status = "current";
    else if (s === "RETURNED_FOR_CORRECTION") base[1] = { id: "approved", label: "Sent back", status: "current" };
    else if (s === "REJECTED") base[1] = { id: "approved", label: "Rejected", status: "error" };
    else {
      base[1].status = "complete";
      if (s === "APPROVED") base[2].status = "current";
      else {
        base[2].status = "complete";
        if (vs === "REJECTED") base[3] = { id: "accepted", label: "Rejected by Supplier", status: "error" };
        else if (s === "SENT_TO_VENDOR") base[3].status = "current";
        else {
          base[3].status = "complete";
          if (s === "ACCEPTED_BY_SUPPLIER") base[4].status = "current";
          else if (s === "PARTIALLY_RECEIVED") { base[4].status = "current"; base[4].description = "Partially received"; }
          else if (s === "RECEIVED" || s === "CLOSED") base[4].status = "complete";
        }
      }
    }
    return base;
  })();

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={() => nav(backTo)}>
        <ArrowLeft className="h-4 w-4" /> {decisionView ? "Back to My Decisions" : approvalView ? "Back to approvals" : "Back to purchase orders"}
      </Button>

      {/* ── HERO — gradient, glass, eye feast ────────────────────────── */}
      <div className="overflow-hidden rounded-[20px] bg-gradient-to-br from-red-900 via-red-950 to-rose-950 p-[1px] shadow-xl">
        <div className="rounded-[19px] bg-gradient-to-br from-red-900 via-red-950 to-rose-950 p-5 sm:p-6 text-slate-50">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1 text-xs font-bold uppercase tracking-widest text-slate-900 shadow-sm">
                <Sparkles className="h-3.5 w-3.5" /> Purchase Order
              </div>
              <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight drop-shadow-sm text-slate-50">
                {formatPONo(po.data.po_no, po.data.revision_no)}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-200">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-black/25 px-2.5 py-1 text-slate-50 backdrop-blur"><Building2 className="h-3.5 w-3.5"/>{po.data.vendor_name ?? "—"}</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-black/25 px-2.5 py-1 text-slate-50 backdrop-blur"><Calendar className="h-3.5 w-3.5"/>{fmtDate(po.data.po_date) ?? "—"}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-3 py-1 text-xs font-extrabold text-slate-900 shadow-sm"><Coins className="h-3.5 w-3.5"/>₹ {money(po.data.total_amount)}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={po.data.status} variant="solid" />
              {po.data.vendor_status && <StatusPill status={po.data.vendor_status} variant="solid" />}
              <Button variant="subtle" onClick={() => window.open(`/pos/${poId}/print`, "_blank")} className="!bg-slate-50 !text-slate-900 shadow-sm hover:!bg-slate-200">
                <Printer className="h-4 w-4" /> PDF
              </Button>
              <Can do="po.create">
                <Button variant="subtle" onClick={() => nav(`/pos/new?copyFrom=${poId}`)} className="!border-white/20 !bg-black/20 !text-slate-50 backdrop-blur hover:!bg-black/40">
                  <Copy className="h-4 w-4" /> Copy as new PO
                </Button>
              </Can>
              {!isFinished && canAmend && (
                <Can do="po.edit">
                  <Button variant="subtle" onClick={startAmending} className="!border-white/20 !bg-black/20 !text-slate-50 backdrop-blur hover:!bg-black/40">
                    <FilePen className="h-4 w-4" /> Amend
                  </Button>
                </Can>
              )}
              {isDraft && (
                <Can do="po.edit">
                  <Button variant="subtle" disabled={editingDraft}
                          onClick={() => {
                            setEditingDraft(true);
                            requestAnimationFrame(() => document.getElementById("edit-draft")
                              ?.scrollIntoView({ behavior: "smooth", block: "start" }));
                          }}
                          className="!border-white/20 !bg-black/20 !text-slate-50 backdrop-blur hover:!bg-black/40">
                    <FilePen className="h-4 w-4" /> {editingDraft ? "Editing" : "Edit"}
                  </Button>
                </Can>
              )}
              {po.data.status === "DRAFT" && (
                <Can do="po.submit">
                  <Button disabled={busy} onClick={() => submit.mutate()} className={`shadow-sm ${TONE_SUBMIT}`}>
                    <Send className="h-4 w-4" /> {submit.isPending ? "Sending…" : "Send for approval"}
                  </Button>
                </Can>
              )}
              {po.data.status === "APPROVED" && (
                <Can do="po.send_vendor">
                  <Button disabled={busy} onClick={() => void sendWithConfirm()} className="!bg-emerald-500 !text-white shadow-sm hover:!bg-emerald-600">
                    <Send className="h-4 w-4" /> {send.isPending ? "Sending…" : "Send to vendor"}
                  </Button>
                </Can>
              )}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { label: "Vendor", value: po.data.vendor_name, icon: Building2, tint: "bg-black/25" },
              { label: "Project", value: po.data.project_name ?? "—", icon: ShoppingCart, tint: "bg-black/25" },
              { label: "Expected", value: fmtDate(po.data.expected_date), icon: Calendar, tint: "bg-black/25" },
            ].map((k) => (
              <div key={k.label} className={`rounded-2xl ${k.tint} p-3 backdrop-blur`}>
                <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-300"><k.icon className="h-3.5 w-3.5"/>{k.label}</div>
                <div className="mt-1 truncate text-sm font-bold text-slate-50">{k.value || "—"}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="-mx-2 sm:mx-0">
        <Stepper steps={steps} className="rounded-2xl bg-white shadow-sm ring-1 ring-line" />
      </div>

      {(submit.error || send.error) && (
        <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200">{((submit.error ?? send.error) as Error).message}</p>
      )}

      {/* ── A draft being edited: the form stands where its cards stand ── */}
      {isDraft && editingDraft && (
        <Can do="po.edit">
          <div id="edit-draft" className="scroll-mt-4">
            <POCorrectionForm key={`draft-${po.data.id}-${po.data.total_amount}-${po.data.items.length}`}
                              po={po.data} mode="draft"
                              onSaved={() => { refresh(); setEditingDraft(false); }}
                              onCancel={() => setEditingDraft(false)} />
          </div>
        </Can>
      )}

      {!(isDraft && editingDraft) && (<>
      {/* ── Order facts — amber block ─────────────────────────────── */}
      <div className="overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-orange-50 to-white shadow-sm">
        <div className="h-1 w-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-500" />
        <div className="p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-amber-700">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500 text-white"><ShoppingCart className="h-4 w-4"/></div>
            <h2 className="text-sm font-extrabold uppercase tracking-widest">Order overview</h2>
            <span className="ml-auto rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-700">Snapshot</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { label: "Vendor", value: po.data.vendor_name ?? "—" },
              { label: "Vendor GSTIN", value: po.data.vendor_gstin ?? "—" },
              { label: "Project", value: po.data.project_name ?? "—" },
              { label: "Expected date", value: fmtDate(po.data.expected_date) },
            ].map((f) => (
              <div key={f.label} className="rounded-xl bg-white p-3 ring-1 ring-amber-100">
                <div className="text-[11px] font-bold uppercase tracking-widest text-amber-700/70">{f.label}</div>
                <div className="mt-1 truncate text-sm font-bold text-ink">{f.value}</div>
              </div>
            ))}
          </div>
          {po.data.remarks && (
            <div className="mt-4 rounded-xl bg-white p-3 text-sm text-body ring-1 ring-amber-100">
              <span className="font-bold text-ink">Remarks: </span>{po.data.remarks}
            </div>
          )}
          {po.data.copied_from_po_id && (
            <div className="mt-4 rounded-xl bg-white p-3 text-sm text-body ring-1 ring-amber-100">
              <span className="font-bold text-ink">Copied from: </span>
              <Link to={`/pos/${po.data.copied_from_po_id}`} className="font-mono font-semibold text-brand hover:underline">
                {po.data.copied_from_po_no ?? `PO #${po.data.copied_from_po_id}`}
              </Link>
            </div>
          )}
          {po.data.quotation_no && (
            <div className="mt-4 grid gap-3 rounded-xl bg-white p-3 ring-1 ring-amber-100 sm:grid-cols-2">
              {[
                { label: "RFQ", value: po.data.rfq_no },
                { label: "Quotation", value: po.data.quotation_no },
              ].map((f) => (
                <div key={f.label}><div className="text-[11px] font-bold uppercase tracking-widest text-muted">{f.label}</div><div className="font-mono text-sm font-semibold text-ink">{f.value ?? "—"}</div></div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── A supplier sending a different packing — the buyer answers here ── */}
      <PackChangesPanel poId={po.data.id} />

      {/* ── Line items — emerald block, editable on approval ───────── */}
      <div className="overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-teal-50 to-white shadow-sm">
        <div className="h-1 w-full bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-500" />
        <div className="p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500 text-white"><Package className="h-4 w-4"/></div>
            <h2 className="text-sm font-extrabold uppercase tracking-widest text-emerald-700">Line items</h2>
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-700">{po.data.items.length} items</span>
            <Button variant="subtle" onClick={() => setLinesExpanded(!linesExpanded)} className="ml-auto h-8 text-xs">
              {linesExpanded ? <ChevronDown className="h-3.5 w-3.5"/> : <ChevronRight className="h-3.5 w-3.5"/>}{linesExpanded ? "Hide" : "View"}
            </Button>
          </div>
          {canEditQty && (
            <div className="mb-3 flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
              <TrendingDown className="h-4 w-4 shrink-0"/> Approver may <b>decrease</b> quantities here (increase blocked). Edited numbers are what the vendor receives.
            </div>
          )}
          {linesExpanded && (
            <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-emerald-100">
              <table className="w-full text-left text-sm">
                <thead className="bg-emerald-600 text-xs font-bold uppercase tracking-widest text-white">
                  <tr><th className="p-3">Item</th><th className="p-3 text-right">Quantity</th><th className="p-3 text-right">Rate</th><th className="p-3 text-right">Tax</th><th className="p-3 text-right">Amount</th></tr>
                </thead>
                <tbody className="divide-y divide-emerald-50">
                  {po.data.items.map((item: any) => {
                    const previous = revisionLines(revisions.data?.[0]);
                    const prev = previous.find((line: any) => line.item_id === item.item_id);
                    const isNew = previous.length > 0 && !prev;
                    const isQtyChanged = previous.length > 0 && prev && Number(prev.quantity) !== Number(item.quantity);
                    const isRateChanged = previous.length > 0 && prev && Number(prev.rate) !== Number(item.rate);
                    const editable = canEditQty;
                    const original = Number(item.quantity);
                    const draftVal = qtyDraft[item.id] ?? String(item.quantity);
                    const parsed = Number(draftVal);
                    const isDecrease = !Number.isNaN(parsed) && parsed < original;
                    const isIncrease = !Number.isNaN(parsed) && parsed > original;
                    return (
                      <tr key={item.id} className={`${isNew ? "bg-violet-50" : ""} ${isQtyChanged ? "bg-blue-50/50" : ""} ${isDecrease ? "bg-amber-50/60" : ""} ${isIncrease ? "bg-red-50" : ""} ${isRateChanged && !isQtyChanged ? "bg-cyan-50/40" : ""}`}>
                        <td className="p-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-bold text-ink">{item.item_name ?? "—"}</span>
                            {isNew && <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-violet-700">New Item</span>}
                            {isQtyChanged && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-blue-700">Qty Changed</span>}
                            {isRateChanged && <span className="rounded bg-cyan-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-cyan-700">Rate Changed</span>}
                          </div>
                          <div className="font-mono text-xs text-muted">{item.item_code ?? `#${item.item_id}`}</div>
                          <CombinationTag value={item} className="mt-1" />
                          <POLinePacking poId={po.data.id} poStatus={po.data.status}
                                         vendorStatus={po.data.vendor_status} line={item}
                                         showChips={false} />
                          {item.delivery_days != null && <div className="text-xs text-emerald-700">Vendor quoted {item.delivery_days} day{item.delivery_days===1?"":"s"}</div>}
                        </td>
                        <td className="p-3 text-right">
                          {editable ? (
                            <div className="ml-auto flex max-w-[160px] flex-col items-end gap-1">
                              {isQtyChanged && <div className="text-[11px] font-semibold text-blue-700">was <span className="line-through">{prev.quantity}</span></div>}
                              <div className="flex items-center justify-end gap-1">
                                <input
                                  type="number"
                                  min={1}
                                  max={original}
                                  step="0.001"
                                  value={draftVal}
                                  onChange={(e) => { setQtyDraft((s) => ({ ...s, [item.id]: e.target.value })); setQtyTouched(true); }}
                                  className={`w-24 rounded-lg border px-2 py-1.5 text-right text-sm font-bold outline-none focus:ring-2 ${isIncrease ? "border-red-300 bg-red-50 text-red-700 ring-red-200" : isDecrease ? "border-amber-300 bg-amber-50 text-amber-800 ring-amber-200" : "border-emerald-200 bg-white text-ink ring-emerald-200"}`}
                                />
                                <span className="text-xs text-muted">{item.uom_code ?? ""}</span>
                              </div>
                              {!!item.pack_breakdown?.length && (
                                <PackQty entries={item.pack_breakdown} qty={item.quantity} uom={item.uom_code}
                                         itemId={item.item_id} align="right" />
                              )}
                            </div>
                          ) : (
                            <div className="flex flex-col items-end">
                              {isQtyChanged && <div className="text-[11px] font-semibold text-blue-700">was <span className="line-through">{prev.quantity}</span></div>}
                              <PackQty entries={item.pack_breakdown} qty={item.quantity} uom={item.uom_code}
                                       itemId={item.item_id} align="right" />
                            </div>
                          )}
                          {editable && isIncrease && <div className="mt-1 text-[11px] font-bold text-red-600">Increase not allowed</div>}
                          {editable && isDecrease && <div className="mt-1 text-[11px] font-bold text-amber-700">↓ trimmed</div>}
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          <div className="flex flex-col items-end">
                            {isRateChanged && <div className="text-[11px] font-semibold text-blue-700">was <span className="line-through">{money(prev.rate)}</span></div>}
                            <span>{money(item.rate)}</span>
                          </div>
                        </td>
                        <td className="p-3 text-right">
                          {/* CGST+SGST within a state, IGST across one — decided by the
                              order's own tax_region, never typed on a line. */}
                          {(item.cgst_percent ?? 0) > 0
                            ? <>CGST {item.cgst_percent}%<br />SGST {item.sgst_percent}%</>
                            : <>IGST {item.igst_percent ?? item.tax_percent}%</>}
                        </td>
                        <td className="p-3 text-right font-extrabold tabular-nums">
                          <div className="flex flex-col items-end">
                            {isRateChanged && <div className="text-[11px] font-semibold text-blue-700">was <span className="line-through">{money(prev.amount)}</span></div>}
                            <span>{money(item.amount)}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {canEditQty && linesExpanded && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="text-xs text-muted">
                {qtyChanges.length ? `${qtyChanges.length} line(s) changed` : "No quantity changes yet"} {hasQtyIncrease && <span className="font-bold text-red-600">· increase blocked</span>}
              </div>
              <Button
                disabled={!qtyTouched || qtyChanges.length===0 || hasQtyIncrease || hasInvalidQty || saveQty.isPending}
                onClick={() => saveQty.mutate()}
                className="ml-auto"
              >
                <Save className="h-4 w-4"/>{saveQty.isPending ? "Saving…" : "Save trimmed quantities"}
              </Button>
              {saveQty.error && <span className="text-xs font-semibold text-red-600">{(saveQty.error as Error).message}</span>}
              {saveQty.isSuccess && <span className="text-xs font-bold text-emerald-700">Saved — vendor gets edited qty</span>}
            </div>
          )}
        </div>
      </div>

      </>)}

      {/* ── Chat — approver <=> raiser ───────────────────────────── */}
      <POApprovalChat poId={poId} />

      {!(isDraft && editingDraft) && (<>
      {/* ── Totals — blue block ───────────────────────────────────── */}
      <div className="overflow-hidden rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 via-indigo-50 to-white shadow-sm">
        <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-indigo-500 to-sky-500" />
        <div className="p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-blue-700">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-white"><Coins className="h-4 w-4"/></div>
            <h2 className="text-sm font-extrabold uppercase tracking-widest">Commercials</h2>
            <span className="ml-auto text-xs font-semibold text-blue-600">Edited total is sent to vendor</span>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <dl className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Subtotal", value: po.data.sub_total, tint: "from-blue-50 to-white border-blue-100" },
                { label: "Discount", value: po.data.discount_amount, tint: "from-violet-50 to-white border-violet-100" },
                ...(isIntraState
                  ? [
                    { label: "CGST", value: cgstTotal, tint: "from-emerald-50 to-white border-emerald-100" },
                    { label: "SGST", value: sgstTotal, tint: "from-emerald-50 to-white border-emerald-100" },
                  ]
                  : [{ label: "IGST", value: igstTotal, tint: "from-emerald-50 to-white border-emerald-100" }]),
                { label: "Freight", value: po.data.freight_amount, tint: "from-amber-50 to-white border-amber-100" },
              ].map((k) => (
                <div key={k.label} className={`rounded-xl border bg-gradient-to-br p-3 ${k.tint}`}>
                  <dt className="text-[11px] font-bold uppercase tracking-widest text-muted">{k.label}</dt>
                  <dd className="mt-1 text-sm font-extrabold tabular-nums text-ink">₹ {money(k.value as number)}</dd>
                </div>
              ))}
            </dl>
            <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-blue-600 px-5 py-4 text-right text-white shadow">
              <div className="text-[11px] font-bold uppercase tracking-widest text-white/80">Total payable</div>
              <div className="font-display text-3xl font-extrabold tabular-nums">₹ {money(po.data.total_amount)}</div>
              {(() => {
                const prevTotal = revisions.data?.[0]?.snapshot?.total_amount;
                if (typeof prevTotal === "number") {
                  const diff = Number(po.data.total_amount) - prevTotal;
                  if (diff !== 0) {
                    return (
                      <div className={`mt-1 text-xs font-bold ${diff > 0 ? "text-red-200" : "text-emerald-300"}`}>
                        {diff > 0 ? "+" : ""}₹ {money(diff)} from prev version
                      </div>
                    );
                  }
                }
                return null;
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* ── Addresses — rose block ────────────────────────────────── */}
      <div className="overflow-hidden rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50 via-pink-50 to-white shadow-sm">
        <div className="h-1 w-full bg-gradient-to-r from-rose-400 via-pink-400 to-rose-500" />
        <div className="p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-rose-700">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-500 text-white"><MapPin className="h-4 w-4"/></div>
            <h2 className="text-sm font-extrabold uppercase tracking-widest">Addresses</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { label: "Billing address", text: po.data.billing_address },
              { label: "Shipping address", text: po.data.shipping_address },
            ].map((f) => (
              <div key={f.label} className="rounded-xl bg-white p-3 ring-1 ring-rose-100">
                <div className="text-[11px] font-bold uppercase tracking-widest text-rose-700/70">{f.label}</div>
                <div className="mt-1 whitespace-pre-line text-sm font-medium text-ink">{f.text || "—"}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Terms — violet block ──────────────────────────────────── */}
      <div className="overflow-hidden rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-purple-50 to-white shadow-sm">
        <div className="h-1 w-full bg-gradient-to-r from-violet-500 via-purple-500 to-fuchsia-500" />
        <div className="p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-violet-700">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-600 text-white"><FileText className="h-4 w-4"/></div>
            <h2 className="text-sm font-extrabold uppercase tracking-widest">Terms & conditions</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { label: "Payment terms", text: po.data.payment_terms },
              { label: "Delivery terms", text: po.data.delivery_terms },
              { label: "Material terms", text: po.data.material_terms },
              { label: "Logistics terms", text: po.data.logistics_terms },
            ].map((f) => (
              <div key={f.label} className="rounded-xl bg-white p-3 ring-1 ring-violet-100">
                <div className="text-[11px] font-bold uppercase tracking-widest text-violet-700/70">{f.label}</div>
                <div className="mt-1 whitespace-pre-line text-sm font-medium text-ink">{f.text || "—"}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      </>)}

      {!isDraft && <POPaymentsPanel poId={poId} />}

      {canFix && (
        <POCorrectionForm key={`${po.data.id}-${po.data.total_amount}-${po.data.items.length}`} po={po.data} onSaved={refresh} />
      )}


      {(po.data.revision_no ?? 0) > 0 && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white shadow-sm">
          <div className="h-1 w-full bg-gradient-to-r from-slate-400 to-slate-600" />
          <div className="p-4">
            <div className="mb-3 flex items-center gap-2 text-slate-700"><div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-700 text-white"><History className="h-4 w-4"/></div><h2 className="text-sm font-extrabold uppercase tracking-widest">Amendment history · rev {po.data.revision_no}</h2></div>
            {po.data.amendment_reason && <p className="mb-3 rounded-xl bg-white p-3 text-sm ring-1 ring-slate-200">Latest: {po.data.amendment_reason} {po.data.amended_at ? `· ${fmtDate(po.data.amended_at)}` : ""}</p>}
            <ol className="space-y-2 text-sm">
              {(revisions.data ?? []).map((rev) => (
                <li key={rev.id} className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-bold text-ink">Revision {rev.revision_no}</span><span className="text-xs text-muted">{rev.changed_by_name ?? "—"} · {fmtDate(rev.created_at)}</span></div>
                  <p className="mt-1 text-body">{rev.reason ?? "—"}</p>
                  <p className="mt-1 text-xs text-muted">Was {rev.status ?? "—"}{rev.vendor_status ? ` · vendor had ${rev.vendor_status.toLowerCase()} it` : ""}{typeof rev.snapshot?.total_amount === "number" ? ` · total was ${money(rev.snapshot.total_amount as number)}` : ""}</p>
                </li>
              ))}
              {(revisions.data ?? []).length === 0 && <li className="text-muted">Loading earlier versions…</li>}
            </ol>
          </div>
        </div>
      )}

      {amending && (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-bold text-ink">Amend this order</h2>
          <p className="text-xs text-muted">
            The current version is filed away and the order goes back to draft: it is approved again, and {po.data.vendor_status === "ACCEPTED" ? "the vendor has to accept the new version before anything can be delivered." : "sent to the vendor again for their answer."}
          </p>
          <POHeaderFields value={header} disabled={true} onChange={(patch) => setHeader({ ...header, ...patch })} />
          <div className="border-t border-line pt-2">
            <h3 className="mb-3 text-sm font-semibold">Order Lines</h3>
            <LinePicker
              lines={amendLines}
              onChange={setAmendLines}
              showRate
              showTax
              showDate={false}
              freezeRateAndTax
              capQuantityAtOriginal={false}
              hideAddLine
            />
          </div>
          <div className="border-t border-line pt-4">
            {amend.error && <p className="mb-3 text-sm text-danger">{(amend.error as Error).message}</p>}
            <Field label="Reason for amendment" required>
              <Input autoFocus value={amendReason} onChange={(e) => setAmendReason((e.target as HTMLInputElement).value)} placeholder="Required — e.g. delivery pushed to month end at vendor's request" />
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="subtle" onClick={() => { setAmending(false); setAmendReason(""); }}>Cancel</Button>
            <Button disabled={amend.isPending || !amendReason.trim() || amendLines.length === 0} onClick={() => amend.mutate()}>{amend.isPending ? "Amending…" : "Save as a new revision"}</Button>
          </div>
        </Card>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="h-1 w-full bg-gradient-to-r from-slate-600 via-slate-500 to-indigo-500" />
        <div className="p-3 sm:p-4"><ApprovalTrail docType="PO" docId={po.data.id} /></div>
      </div>

      {po.data.status === "PENDING_APPROVAL" && ((po.data.pending_with?.length ?? 0) > 0 || po.data.current_approver_name) && !canDecide && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm p-4 text-sm font-medium text-ink flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-amber-500" />
          Waiting on {po.data.pending_with?.length ? po.data.pending_with.join(", ") : po.data.current_approver_name} for approval
        </div>
      )}

      {po.data.status === "RETURNED_FOR_CORRECTION" && (
        <div className="overflow-hidden rounded-2xl border border-amber-300 bg-amber-50 shadow-sm p-4 text-sm">
          <div className="flex items-center gap-2 font-bold text-amber-900">
            <Undo2 className="h-4 w-4" />
            Sent back to {po.data.correction?.owner_name ?? po.data.current_approver_name ?? "the previous approver"}
            {po.data.correction?.returned_by_name && <> by {po.data.correction.returned_by_name}</>}
          </div>
          {po.data.correction?.reason && (
            <p className="mt-2 rounded-xl bg-white p-2.5 font-medium text-ink ring-1 ring-amber-200">
              Reason: {po.data.correction.reason}
            </p>
          )}
          {po.data.can_resubmit_correction && (
            <>
              <p className="mt-2 text-amber-900">
                {po.data.can_edit_correction
                  ? "Edit the order below (vendor, items, quantities, rates, terms…), Save changes, then resubmit."
                  : po.data.can_pass_correction_down
                    ? "You can resubmit it as it is, or send it further back to the person below you."
                    : "Add a comment if needed and resubmit."}
              </p>
              <div className="mt-3">
                <Field label={po.data.can_pass_correction_down ? "Comment (required to send further back)" : "Comment (optional)"}>
                  <Input value={fixComment} onChange={(e) => { setFixComment((e.target as HTMLInputElement).value); setFixError(""); }} placeholder="Visible to the approver" />
                </Field>
              </div>
              {fixError && <p className="mt-2 font-semibold text-red-600">{fixError}</p>}
              {resubmit.error && <p className="mt-2 font-semibold text-red-600">{(resubmit.error as Error).message}</p>}
              {sendBackFurther.error && <p className="mt-2 font-semibold text-red-600">{(sendBackFurther.error as Error).message}</p>}
              <div className="mt-3 flex justify-end gap-2">
                {po.data.can_pass_correction_down && (
                  <Button variant="subtle" disabled={sendBackFurther.isPending || resubmit.isPending} onClick={sendBackFurtherWithReason} className="border border-amber-400 bg-amber-100 text-amber-900 hover:bg-amber-200">
                    <Undo2 className="h-4 w-4" /> {sendBackFurther.isPending ? "Sending…" : "Send further back"}
                  </Button>
                )}
                <Button disabled={resubmit.isPending || sendBackFurther.isPending} onClick={() => resubmit.mutate()} className={TONE_SUBMIT}>
                  <Send className="h-4 w-4" /> {resubmit.isPending ? "Resubmitting…" : "Resubmit for approval"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {canDecide && (
        <div className="overflow-hidden rounded-2xl border border-amber-300 bg-gradient-to-br from-amber-50 via-orange-50 to-white shadow-md">
          <div className="h-1 w-full bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600" />
          <div className="p-4">
            <div className="mb-3 flex items-center gap-2 text-amber-800">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500 text-white"><ShieldCheck className="h-4 w-4"/></div>
              <h2 className="text-sm font-extrabold uppercase tracking-widest">
                {isAdmin && !po.data.awaiting_me ? "Approve this order · Admin Override" : "Approve this order"}
              </h2>
              <span className="ml-auto hidden sm:inline text-xs font-semibold text-amber-700">Edited quantities will be sent to vendor</span>
            </div>
            {(po.data.pending_with?.length || po.data.current_approver_name) && (
              <p className="mb-3 rounded-xl bg-white p-2.5 text-sm font-medium ring-1 ring-amber-200">
                Waiting on {po.data.pending_with?.length ? po.data.pending_with.join(", ") : po.data.current_approver_name}.
              </p>
            )}
            <Field label="Comments">
              <Input value={comments} onChange={(e) => { setComments((e.target as HTMLInputElement).value); setSendBackError(""); }} placeholder="Required for Send back and Reject, optional for Approve. Visible in trail" />
            </Field>
            {sendBackError && <p className="mt-2 text-sm font-semibold text-red-600">{sendBackError}</p>}
            {decide.error && <p className="mt-2 text-sm font-semibold text-red-600">{(decide.error as Error).message}</p>}
            {sendBack.error && <p className="mt-2 text-sm font-semibold text-red-600">{(sendBack.error as Error).message}</p>}
            <div className="mt-3 flex justify-end gap-2">
              {(can("po.approve") || isAdmin) && (
                <Button variant="subtle" disabled={busy} onClick={sendBackWithReason} className="border border-amber-400 bg-amber-100 text-amber-900 hover:bg-amber-200"><Undo2 className="h-4 w-4"/> Send back</Button>
              )}
              {(can("po.reject") || isAdmin) && (
                <Button className={TONE_REJECT} variant="danger" disabled={busy} onClick={() => void decideWithConfirm("reject")}><X className="h-4 w-4"/> Reject</Button>
              )}
              {(can("po.approve") || isAdmin) && (
                <Button disabled={busy} onClick={() => void decideWithConfirm("approve")} className={TONE_APPROVE}><Check className="h-4 w-4"/> {isAdmin && !po.data.awaiting_me ? "Approve (Admin Override)" : "Approve"}</Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
