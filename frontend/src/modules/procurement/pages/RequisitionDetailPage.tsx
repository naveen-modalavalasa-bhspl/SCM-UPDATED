import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Can, Card, ErrorBanner, PageHeader, ResponsiveList, StatusPill,
  useToast, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { requisitionApi } from "../api";
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
    {
      key: "ordered",
      header: "Ordered",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => r.ordered_qty,
    },
    {
      key: "rate",
      header: "Est. rate",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => money(r.estimated_rate),
    },
    {
      key: "amount",
      header: "Estimated",
      className: "text-right",
      render: (r) => <span className="font-semibold text-ink">{money(r.estimated_amount)}</span>,
    },
    {
      key: "needed",
      header: "Needed by",
      hideOnNarrow: true,
      render: (r) => (r.required_date ? fmtDate(r.required_date) : "—"),
    },
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
            {isApproved && (
              <Can do="rfq.create">
                <Button onClick={() => nav(`/procurement/rfqs/new?requisition=${reqId}`)}>
                  Raise RFQ
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
              <div className="text-xs text-body">
                {r.quantity} {r.uom_code ?? ""} · {money(r.estimated_amount)}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
