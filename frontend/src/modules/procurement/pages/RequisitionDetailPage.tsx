import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Can, Card, ErrorBanner, PageHeader, ResponsiveList, StatusPill,
  useToast, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { requisitionApi } from "../api";
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
            {isApproved && (
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
        <Card className="mb-4 p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Status</dt>
              <dd className="mt-1"><StatusPill status={req.status} /></dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Raised by</dt>
              <dd className="mt-1 text-body">{req.created_by_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {req.status === "PENDING_APPROVAL" ? "With" : "Approved by"}
              </dt>
              <dd className="mt-1 text-body">
                {req.current_approver_name ?? req.approved_by_name ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Estimated value</dt>
              <dd className="mt-1 font-semibold text-ink">{money(req.estimated_value)}</dd>
              {/* Asked of every buyer who sees it, so the screen answers before they
                * ask. It is a routing figure, not a price — the approval ladder needs
                * a number and the vendors have not quoted yet. */}
              <dd className="mt-1 text-[11px] leading-snug text-muted">
                From the preferred vendor's last rate, then any vendor's last rate,
                then the item's purchase price. Not a quote.
              </dd>
            </div>
          </dl>

          {/* Who is asking, for what, and on whose budget. None of it was on screen
            * before, and an approver cannot place a requisition without it. Department
            * and company are read off the raiser's HCM record and the install
            * settings — they are not typed on the document. */}
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Department</dt>
              <dd className="mt-1 text-body">{req.department_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Warehouse</dt>
              <dd className="mt-1 text-body">{req.warehouse_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Project</dt>
              <dd className="mt-1 text-body">{req.project_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Company</dt>
              <dd className="mt-1 text-body">{req.company_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Priority</dt>
              <dd className="mt-1 text-body">{req.priority ?? "Normal"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Needed by</dt>
              <dd className="mt-1 text-body">
                {req.required_date ? fmtDate(req.required_date) : "—"}
              </dd>
            </div>
            {/* Every material request folded in, not just the first. A consolidated
              * requisition serves several, and the header is where they are named. */}
            <div className="col-span-2">
              <dt className="text-xs text-muted">
                From material request{(req.source_mr_nos ?? []).length > 1 ? "s" : ""}
              </dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {(req.source_mr_nos ?? []).length
                  ? req.source_mr_nos!.map((no) => (
                      <span
                        key={no}
                        className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-body"
                      >
                        {no}
                      </span>
                    ))
                  : <span className="text-body">Raised directly</span>}
              </dd>
            </div>
          </dl>

          {req.remarks && (
            <p className="mt-4 border-t border-line pt-4 text-sm text-body">{req.remarks}</p>
          )}
        </Card>
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
