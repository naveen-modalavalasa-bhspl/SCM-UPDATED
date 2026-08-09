import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button, Card, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { poApi } from "../api";
import { alerts } from "@/modules/alerts";
import { fmtDate } from "@/shared/datetime";

const money = (value: number) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value);

/** Purchase-order document view used by both the approval inbox and My Decisions. */
export function PODetailPage() {
  const { id } = useParams();
  const poId = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const approvalView = params.get("approval") === "1";
  const decisionView = params.get("decision") === "1";
  const [comments, setComments] = useState("");

  const po = useQuery({
    queryKey: ["purchase-order", poId],
    queryFn: () => poApi.get(poId),
    enabled: Number.isFinite(poId) && poId > 0,
  });
  const decide = useMutation({
    mutationFn: (action: "approve" | "reject") => action === "approve"
      ? poApi.approve(poId, comments)
      : poApi.reject(poId, comments),
    onSuccess: (_result, action) => {
      const number = po.data?.po_no ?? "The purchase order";
      void alerts.success(action === "approve" ? "po.approved" : "po.rejected", { number });
      qc.invalidateQueries({ queryKey: ["purchase-order", poId] });
      qc.invalidateQueries({ queryKey: ["approvals"] });
      nav("/approvals");
    },
  });

  const decideWithConfirm = async (action: "approve" | "reject") => {
    if (decide.isPending || !po.data) return;
    const asked = action === "approve"
      ? await alerts.confirm("po.approve", {
        number: po.data.po_no,
        amount: money(po.data.total_amount ?? 0),
      })
      : await alerts.confirm("po.reject", { number: po.data.po_no });
    if (asked) decide.mutate(action);
  };

  if (po.isLoading) return <p className="p-6 text-sm text-muted">Loading purchase order…</p>;
  if (po.error) return <p className="rounded-lg bg-danger/10 p-4 text-danger">{(po.error as Error).message}</p>;
  if (!po.data) return <p className="p-6 text-muted">Purchase order not found.</p>;

  const canDecide = approvalView && po.data.status === "PENDING_APPROVAL";
  const backTo = decisionView ? "/approvals/decisions" : approvalView ? "/approvals" : "/pos";

  return <>
    <Button variant="ghost" onClick={() => nav(backTo)}>
      <ArrowLeft className="h-4 w-4" /> {decisionView ? "Back to My Decisions" : approvalView ? "Back to approvals" : "Back to purchase orders"}
    </Button>
    <PageHeader
      eyebrow="Purchase order"
      title={po.data.po_no}
      actions={<StatusPill status={po.data.status} />}
    />

    <Card className="mb-4 p-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-muted">Vendor</dt><dd className="font-semibold text-ink">{po.data.vendor_name ?? "—"}</dd></div>
        <div><dt className="text-muted">Indent</dt><dd className="font-mono text-ink">{po.data.indent_no ?? "—"}</dd></div>
        <div><dt className="text-muted">Expected date</dt><dd className="text-ink">{fmtDate(po.data.expected_date)}</dd></div>
        <div><dt className="text-muted">Total</dt><dd className="font-semibold text-ink">{money(po.data.total_amount)}</dd></div>
      </dl>
    </Card>

    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-left text-sm">
        <thead className="bg-content2 text-xs text-muted"><tr><th className="p-3">Item</th><th className="p-3 text-right">Quantity</th><th className="p-3 text-right">Rate</th><th className="p-3 text-right">Tax</th><th className="p-3 text-right">Amount</th></tr></thead>
        <tbody className="divide-y divide-line">{po.data.items.map((item) => <tr key={item.id}>
          <td className="p-3"><strong className="text-ink">{item.item_name ?? "—"}</strong><p className="font-mono text-xs text-muted">{item.item_code ?? `#${item.item_id}`}</p></td>
          <td className="p-3 text-right">{item.quantity} {item.uom_code ?? ""}</td>
          <td className="p-3 text-right">{money(item.rate)}</td>
          <td className="p-3 text-right">{item.tax_percent}%</td>
          <td className="p-3 text-right font-semibold">{money(item.amount)}</td>
        </tr>)}</tbody>
      </table>
    </div>

    {canDecide && <Card className="mt-4 space-y-3 p-4">
      <Field label="Comments">
        <Input value={comments} onChange={(event) => setComments(event.target.value)} placeholder="Optional approval comment" />
      </Field>
      {decide.error && <p className="text-sm text-danger">{(decide.error as Error).message}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="danger" disabled={decide.isPending} onClick={() => void decideWithConfirm("reject")}><X className="h-4 w-4" /> Reject</Button>
        <Button disabled={decide.isPending} onClick={() => void decideWithConfirm("approve")}><Check className="h-4 w-4" /> Approve</Button>
      </div>
    </Card>}
  </>;
}
