import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Can, ErrorBanner, PageHeader, ResponsiveList, StatusPill, useToast, type Column } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { Button } from "../components/ActionButton";
import { fmtDate } from "@/shared/datetime";
import { approvalTrailApi, approvalTrailKey, requisitionApi } from "../api";
import { ApprovalTrail } from "../components/ApprovalTrail";
import { DetailShell, SectionCard, FactGrid, RefChips, RailStat } from "../components/DetailKit";
import { money } from "./RequisitionListPage";
import type { ReqItem } from "../types";
import { TONE_APPROVE, TONE_REJECT, TONE_SUBMIT } from "@/shared/components/tones";

/**
 * One requisition, and everything that can be done to it.
 *
 * Which buttons appear is decided by STATUS first and permission second — a person
 * who may approve still must not see Approve on a draft. `<Can>` then hides what
 * this login cannot do; the backend check is the real guard either way.
 */
export function RequisitionDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const reqId = Number(id);

  const { data: req, isLoading, error } = useQuery({
    queryKey: ["requisition", id],
    queryFn: () => requisitionApi.get(reqId),
  });

  // The same read the trail below already makes, so the badge and the trail can never
  // disagree about which rung the document is on. The RUNG, not the person holding it:
  // "Pending at SCM HEAD" survives a transfer, and `current_approver_name` is a
  // snapshot taken at submit that a ladder edit leaves out of date.
  const trail = useQuery({
    queryKey: approvalTrailKey("REQUISITION", reqId),
    queryFn: () => approvalTrailApi.get("REQUISITION", reqId),
    enabled: Number.isFinite(reqId),
  });

  const refresh = (message: string) => () => {
    queryClient.invalidateQueries({ queryKey: ["requisition", id] });
    queryClient.invalidateQueries({ queryKey: ["requisitions"] });
    // The approval trail is engine state, and pressing Approve here CHANGES it.
    // Without this the page kept showing the rung it was on before the press and
    // only a full reload caught up. Keyed on the prefix so one line covers every
    // document type this page can be showing.
    queryClient.invalidateQueries({ queryKey: ["procurement", "approval-trail"] });
    toast.success(message);
  };

  const submit = useMutation({
    mutationFn: () => requisitionApi.submit(reqId),
    onSuccess: refresh("Sent for approval"),
  });
  const approve = useMutation({
    mutationFn: () => requisitionApi.approve(reqId),
    onSuccess: refresh("Approved"),
  });
  const reject = useMutation({
    mutationFn: () => requisitionApi.reject(reqId),
    onSuccess: refresh("Rejected"),
  });
  const cancel = useMutation({
    mutationFn: () => requisitionApi.cancel(reqId),
    onSuccess: refresh("Cancelled"),
  });

  const busy = submit.isPending || approve.isPending || reject.isPending || cancel.isPending;
  const isDraft = req?.status === "DRAFT";
  const isPending = req?.status === "PENDING_APPROVAL";
  // FIXED 2026-08-20 — awaiting_me, not the status: PENDING_APPROVAL says the document is with SOMEBODY, not with you. `isPending` still drives the wording ("With ..."), which is
  // a statement about the document; only the DECISION buttons move to this one.
  // `?? status` on purpose: if the backend has not been restarted, or is an older
  // build, `awaiting_me` is undefined — and a bare `&&` would then hide the button
  // from the person who IS supposed to approve. Falling back to the old status check
  // means the worst case is the pre-2026-08-20 behaviour (a button that 403s), never
  // a document nobody can sign.
  const { can, me } = useAuth();
  const isAdmin = can("admin.workflow.manage") || Boolean(me?.roles.includes("ADMIN")) || Boolean(me?.roles.includes("SUPERUSER"));
  const canDecide = isPending && (Boolean(req?.awaiting_me) || isAdmin);
  const isApproved = req?.status === "APPROVED";

  const columns: Column<ReqItem>[] = [
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
      render: (r) => `${r.quantity} ${r.uom_code ?? ""}`.trim(),
    },
    // No rate, no amount, no "ordered", no per-line indent. Nobody has quoted yet, so a
    // figure here reads as a price when it is a guess; the ordered quantity belongs on
    // the PO; and the indents behind the document are named once in the header rather
    // than repeated down a column. The line says what is wanted and how much.
  ];

  return (
    <div>
      <PageHeader
        back={{ to: "/procurement/requisitions", label: "Back to Requisitions" }}
        eyebrow="Procurement"
        title={req?.req_no ?? "Requisition"}
        actions={
          <>
            {/* Where the document is, said once, in the place every other screen says
              * it. The rung comes off the engine's own trail, so a ladder renamed on
              * Settings > Approvals Config renames this badge too. */}
            {req && (
              <div className="flex items-center gap-2">
                <StatusPill
                  status={isPending && trail.data?.stage_name
                    ? `Pending at ${trail.data.stage_name}`
                    : req.status}
                />
                {isAdmin && isPending && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-500/10 text-purple-700 border border-purple-500/20">
                    Admin Override
                  </span>
                )}
              </div>
            )}
            <Button variant="subtle" onClick={() => nav("/procurement/requisitions")}>
              Back
            </Button>
            {isDraft && (
              <Can do="requisition.create">
                <Button
                  variant="subtle"
                  onClick={() => nav(`/procurement/requisitions/${reqId}/edit`)}
                >
                  Edit
                </Button>
                <Button className={TONE_SUBMIT} disabled={busy} onClick={() => submit.mutate()}>
                  Send for approval
                </Button>
              </Can>
            )}
            {canDecide && (can("requisition.approve") || isAdmin) && (
              <>
                <Button className={TONE_REJECT} variant="subtle" disabled={busy} onClick={() => reject.mutate()}>
                  Reject
                </Button>
                <Button className={TONE_APPROVE} disabled={busy} onClick={() => approve.mutate()}>
                  {isAdmin && !req?.awaiting_me ? "Approve (Admin Override)" : "Approve"}
                </Button>
              </>
            )}
            {/* Explicit, never automatic: approving a requisition does not send it
              * out. A buyer decides who is asked and when, and the form opens
              * pre-filled with everything this document already says. */}
            {isApproved && !req?.has_rfq && !req?.has_consolidation && (
              <Can do="rfq.create">
                <Button onClick={() => nav(`/procurement/rfqs/new?requisition=${reqId}`)}>
                  Create RFQ
                </Button>
              </Can>
            )}
            {!["ORDERED", "CANCELLED"].includes(req?.status ?? "") && (
              <Can do="requisition.create">
                <Button variant="subtle" disabled={busy} onClick={() => cancel.mutate()}>
                  Cancel
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={error ?? submit.error ?? approve.error ?? reject.error ?? cancel.error} />

      <DetailShell
        main={(
          <>
            {req && (
              <SectionCard title="Request">
                <FactGrid
                  facts={[
                    { label: "Raised by", value: req.created_by_name ?? "—" },
                    {
                      label: isPending ? "With" : "Approved by",
                      value: req.current_approver_name ?? req.approved_by_name ?? "—",
                    },
                    { label: "Needed by", value: req.required_date ? fmtDate(req.required_date) : "—" },
                    {
                      label: "Priority",
                      value: req.priority
                        ? <span className="capitalize">{req.priority.toLowerCase()}</span>
                        : "—",
                    },
                    { label: "Department", value: req.department_name ?? "—" },
                    { label: "Shipment Address", value: req.warehouse_name ?? "—" },
                    { label: "Project", value: req.project_name ?? "—" },
                    { label: "Company", value: req.company_name ?? "—" },
                  ]}
                />

                {/* Every material request folded in, not just the first: a consolidated
                    requisition serves several and the header is where they are named. */}
                <div className="mt-4 border-t border-line/60 pt-4">
                  <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
                    From material request{(req.source_mr_nos ?? []).length > 1 ? "s" : ""}
                  </div>
                  <div className="mt-1.5">
                    {(req.source_mr_nos ?? []).length
                      ? <RefChips items={req.source_mr_nos!.map((no) => ({ no }))} />
                      : <span className="text-sm text-muted">Raised directly</span>}
                  </div>
                </div>

                {req.remarks && (
                  <p className="mt-4 border-t border-line/60 pt-4 text-sm text-body">{req.remarks}</p>
                )}
              </SectionCard>
            )}

            <SectionCard title="Lines" className="p-2">
              <ResponsiveList
                data={req?.items ?? []}
                columns={columns}
                keyOf={(r) => r.id}
                loading={isLoading}
                empty="No lines on this requisition."
                renderCard={(r) => (
                  <div className="space-y-1.5">
                    <div className="text-sm font-medium text-ink">
                      {r.item_name ?? `Item ${r.item_id}`}
                    </div>
                    <div className="font-mono text-[11px] text-muted">{r.item_code ?? "—"}</div>
                    <div className="text-xs text-body">{r.quantity} {r.uom_code ?? ""}</div>
                  </div>
                )}
              />
            </SectionCard>
          </>
        )}
        rail={(
          <>
            {req && (
              <SectionCard>
                {/* A routing figure, not a price — the ladder needs a number before
                    anybody has quoted. The paragraph that used to explain that is
                    gone; the label carries it. */}
                <RailStat label="Estimated value" value={money(req.estimated_value)} />
              </SectionCard>
            )}
            <ApprovalTrail docType="REQUISITION" docId={Number(id)} />
          </>
        )}
      />
    </div>
  );
}
