import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PageHeader, Button, Can, Card, Field, Input, ResponsiveList, StatusPill,
  type Column,
} from "@/shared/components";
import { approveMaterialRequest, getMaterialRequest, rejectMaterialRequest } from "../api";
import { alerts } from "@/modules/alerts";
import type { MaterialRequestItem } from "../types";

/**
 * One material request: the shortfall an allocation could not cover, and the buttons
 * procurement uses to accept or refuse it.
 */
export function MaterialRequestDetailPage() {
  const { id } = useParams();
  const mrId = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [comments, setComments] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["material-request", mrId],
    queryFn: () => getMaterialRequest(mrId),
    enabled: Number.isFinite(mrId),
  });

  const act = useMutation({
    mutationFn: (approve: boolean) =>
      approve ? approveMaterialRequest(mrId, comments) : rejectMaterialRequest(mrId, comments),
    onSuccess: (_result, approve) => {
      const number = data?.mr_no ?? "The request";
      void alerts.success(
        approve ? "material_request.approved" : "material_request.rejected",
        { number },
      );
      qc.invalidateQueries({ queryKey: ["material-request", mrId] });
      qc.invalidateQueries({ queryKey: ["material-requests"] });
    },
  });

  const decide = async (approve: boolean) => {
    if (act.isPending || !data) return;
    const first = data.items[0];
    const asked = approve
      ? await alerts.confirm("material_request.approve", {
        number: data.mr_no,
        qty: first ? `${first.quantity} ${first.uom_code ?? ""}`.trim() : "the requested quantity",
        item: first?.item_name ?? first?.item_code ?? "the requested items",
      })
      : await alerts.confirm("material_request.reject", { number: data.mr_no });
    if (asked) act.mutate(approve);
  };

  if (isLoading) return <p className="p-6 text-muted">Loading…</p>;
  if (error) return <p className="p-6 text-danger">{(error as Error).message}</p>;
  if (!data) return null;

  const columns: Column<MaterialRequestItem>[] = [
    { key: "line", header: "#", render: (r) => <span className="tabular text-muted">{r.line_no}</span> },
    { key: "code", header: "Code", render: (r) => <span className="mono text-muted">{r.item_code}</span> },
    { key: "name", header: "Item", render: (r) => r.item_name ?? "—" },
    {
      key: "qty",
      header: "Needed",
      render: (r) => (
        <span className="tabular font-semibold text-ink">
          {r.quantity} {r.uom_code ?? ""}
        </span>
      ),
    },
    {
      key: "ordered",
      header: "Ordered",
      render: (r) => <span className="tabular text-muted">{r.ordered_quantity}</span>,
      hideOnNarrow: true,
    },
  ];

  const open = data.status === "PENDING_APPROVAL";

  return (
    <>
      <PageHeader
        eyebrow="Material request"
        title={data.mr_no}
        actions={<StatusPill status={data.status} />}
      />

      <Card className="mb-4 p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Raised for</dt>
            <dd className="mono font-semibold text-ink">
              <button className="underline" onClick={() => nav(`/indents/${data.indent_id}`)}>
                {data.indent_no ?? "—"}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Department</dt>
            <dd className="text-ink">{data.department_name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted">With</dt>
            <dd className="text-ink">{data.current_approver_name ?? "—"}</dd>
          </div>
        </dl>
        {data.remarks && <p className="mt-3 text-sm text-muted">{data.remarks}</p>}
      </Card>

      <ResponsiveList
        data={data.items ?? []}
        keyOf={(r) => r.id}
        columns={columns}
        empty="No lines on this request."
        renderCard={(r) => (
          <div className="space-y-1">
            <span className="mono text-xs text-muted">{r.item_code}</span>
            <p className="font-semibold text-ink">{r.item_name}</p>
            <p className="tabular text-sm text-muted">
              {r.quantity} {r.uom_code ?? ""}
            </p>
          </div>
        )}
      />

      {open && (
        <div className="mt-4 space-y-3">
          <Field label="Comments">
            <Input
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              placeholder="Optional — why you are approving or refusing"
            />
          </Field>
          {act.error && <p className="text-danger">{(act.error as Error).message}</p>}
          <div className="flex gap-2">
            <Can do="mr.approve">
              <Button onClick={() => void decide(true)} disabled={act.isPending}>
                Approve
              </Button>
            </Can>
            <Can do="mr.reject">
              <Button variant="subtle" onClick={() => void decide(false)} disabled={act.isPending}>
                Reject
              </Button>
            </Can>
          </div>
        </div>
      )}
    </>
  );
}
