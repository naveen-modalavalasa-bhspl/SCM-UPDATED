import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Can, Card, ErrorBanner, PageHeader, ResponsiveList, StatusPill,
  useToast, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { approvalTrailApi, approvalTrailKey, requisitionApi } from "../api";
import { ApprovalTrail } from "../components/ApprovalTrail";
import { money } from "./RequisitionListPage";
import type { ReqItem } from "../types";

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
        eyebrow="Procurement"
        title={req?.req_no ?? "Requisition"}
        actions={
          <>
            {/* Where the document is, said once, in the place every other screen says
              * it. The rung comes off the engine's own trail, so a ladder renamed on
              * Settings > Approvals Config renames this badge too. */}
            {req && (
              <StatusPill
                status={isPending && trail.data?.stage_name
                  ? `Pending at ${trail.data.stage_name}`
                  : req.status}
              />
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
                <Button disabled={busy} onClick={() => submit.mutate()}>
                  Send for approval
                </Button>
              </Can>
            )}
            {isPending && (
              <Can do="requisition.approve">
                <Button variant="subtle" disabled={busy} onClick={() => reject.mutate()}>
                  Reject
                </Button>
                <Button disabled={busy} onClick={() => approve.mutate()}>
                  Approve
                </Button>
              </Can>
            )}
            {/* Explicit, never automatic: approving a requisition does not send it
              * out. A buyer decides who is asked and when, and the form opens
              * pre-filled with everything this document already says. */}
            {isApproved && !req?.has_rfq && (
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

      {req && (
        <>
          {/* The three things a buyer reads first — who wants it, when, and what it is
            * likely to cost — on one line, before the detail. The estimate sits apart
            * because it is the figure the ladder routed on, not a fact about the
            * request. */}
          <Card className="mb-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-muted">Raised by</p>
                <p className="text-lg font-semibold text-ink">{req.created_by_name ?? "—"}</p>
                <p className="mt-1 text-sm text-muted">
                  {req.status === "PENDING_APPROVAL" ? "With " : "Approved by "}
                  <span className="text-body">
                    {req.current_approver_name ?? req.approved_by_name ?? "—"}
                  </span>
                  {req.required_date ? ` · needed by ${fmtDate(req.required_date)}` : ""}
                  {req.priority ? ` · ${req.priority.toLowerCase()} priority` : ""}
                </p>
              </div>
              <div className="rounded-xl bg-content2 px-4 py-3 text-right">
                <p className="text-xs uppercase tracking-wide text-muted">Estimated value</p>
                <p className="text-xl font-bold text-ink">{money(req.estimated_value)}</p>
                {/* Asked of every buyer who sees it, so the screen answers before they
                  * ask. It is a routing figure, not a price — the approval ladder needs
                  * a number and the vendors have not quoted yet. */}
                <p className="mt-1 max-w-56 text-[11px] leading-snug text-muted">
                  Preferred vendor's last rate, then any vendor's, then the item's
                  purchase price. Not a quote.
                </p>
              </div>
            </div>

            {/* Who is asking, for what, and on whose budget. Department and company are
              * read off the raiser's HCM record and the install settings — they are not
              * typed on the document. */}
            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4 text-sm sm:grid-cols-4">
              {[
                ["Department", req.department_name],
                ["Warehouse", req.warehouse_name],
                ["Project", req.project_name],
                ["Company", req.company_name],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
                  <dd className="mt-0.5 truncate text-body" title={(value as string) ?? undefined}>
                    {(value as string) ?? "—"}
                  </dd>
                </div>
              ))}
            </dl>

            {/* Every material request folded in, not just the first. A consolidated
              * requisition serves several, and the header is where they are named. */}
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <span className="text-[11px] uppercase tracking-wide text-muted">
                From material request{(req.source_mr_nos ?? []).length > 1 ? "s" : ""}
              </span>
              {(req.source_mr_nos ?? []).length
                ? req.source_mr_nos!.map((no) => (
                    <span
                      key={no}
                      className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-body"
                    >
                      {no}
                    </span>
                  ))
                : <span className="text-sm text-body">Raised directly</span>}
            </div>

            {req.remarks && (
              <p className="mt-4 border-t border-line pt-4 text-sm text-body">{req.remarks}</p>
            )}
          </Card>
        </>
      )}

      <Card className="p-2">
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
      </Card>

      <ApprovalTrail docType="REQUISITION" docId={Number(id)} />
    </div>
  );
}
