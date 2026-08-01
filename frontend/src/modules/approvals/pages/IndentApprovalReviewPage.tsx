import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, RotateCcw, X } from "lucide-react";
import { Button, Card, ConfirmModal, PageHeader, StatusPill } from "@/shared/components";
import { approvalsApi } from "../api";

type Decision = "approve" | "reject" | "return" | null;
const CHECKS = [
  "I checked every requested item and quantity.",
  "I checked the business need and priority.",
  "I checked the approved quantities shown below.",
];
const asNumber = (value: string | undefined) =>
  value === "" || value == null ? 0 : Number(value);

/** Normal page-based review. This is deliberately not a drawer or overlay. */
export function IndentApprovalReviewPage({ indentId: suppliedIndentId }: { indentId?: number } = {}) {
  const { id } = useParams();
  const indentId = suppliedIndentId ?? Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [comments, setComments] = useState("");
  const [reason, setReason] = useState("");
  const [checks, setChecks] = useState([false, false, false]);
  const [confirming, setConfirming] = useState<Decision>(null);

  const indent = useQuery({
    queryKey: ["approvals", "indent", indentId],
    queryFn: () => approvalsApi.getIndent(indentId),
    enabled: Number.isFinite(indentId) && indentId > 0,
  });
  const history = useQuery({
    queryKey: ["approvals", "history", "INDENT", indentId],
    queryFn: () => approvalsApi.history("INDENT", indentId),
    enabled: Number.isFinite(indentId) && indentId > 0,
  });

  useEffect(() => {
    if (!indent.data) return;
    setQuantities(Object.fromEntries(
      indent.data.items.map((line) => [line.id, String(line.approved_quantity)]),
    ));
  }, [indent.data]);

  const invalidQuantity = useMemo(() => (indent.data?.items ?? []).some((line) => {
    const value = asNumber(quantities[line.id]);
    return !Number.isFinite(value) || value < 0 || value > line.requested_quantity;
  }), [indent.data, quantities]);

  const finish = () => {
    qc.invalidateQueries({ queryKey: ["approvals"] });
    nav("/approvals");
  };
  const approve = useMutation({
    mutationFn: () => approvalsApi.approveIndent(
      indentId,
      (indent.data?.items ?? []).map((line) => ({
        line_id: line.id,
        approved_quantity: asNumber(quantities[line.id]),
      })),
      comments,
    ),
    onSuccess: finish,
  });
  const reject = useMutation({
    mutationFn: () => approvalsApi.rejectIndent(indentId, reason),
    onSuccess: finish,
  });
  const returnForCorrection = useMutation({
    mutationFn: () => approvalsApi.returnIndent(indentId, reason),
    onSuccess: finish,
  });
  const busy = approve.isPending || reject.isPending || returnForCorrection.isPending;
  const actionError = approve.error || reject.error || returnForCorrection.error;

  const confirm = () => {
    if ((confirming === "reject" || confirming === "return") && !reason.trim()) return;
    if (confirming === "approve") approve.mutate();
    if (confirming === "reject") reject.mutate();
    if (confirming === "return") returnForCorrection.mutate();
  };

  if (indent.isLoading) return <p className="p-6 text-sm text-muted">Loading approval details…</p>;
  if (indent.error) return <p className="rounded-lg bg-danger/10 p-4 text-danger">{(indent.error as Error).message}</p>;
  if (!indent.data) return <p className="p-6 text-muted">Approval not found.</p>;

  return <>
    <Button variant="ghost" onClick={() => nav("/approvals")}><ArrowLeft className="h-4 w-4" /> Back to approvals</Button>
    <PageHeader eyebrow="Approval review" title={indent.data.indent_no} actions={<StatusPill status={indent.data.current_stage_name ?? indent.data.status} />} />

    <div className="space-y-5">
      <Card className="p-4"><dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-muted">Requested by</dt><dd className="font-semibold text-ink">{indent.data.requested_by_name ?? "—"}</dd></div><div><dt className="text-muted">Department</dt><dd>{indent.data.department_name ?? "—"}</dd></div><div><dt className="text-muted">Priority</dt><dd><StatusPill status={indent.data.priority} /></dd></div></dl></Card>

      <section>
        <h2 className="mb-2 font-semibold text-ink">Quantity comparison</h2>
        <div className="overflow-x-auto rounded-xl border border-line"><table className="w-full text-left text-sm"><thead className="bg-content2 text-xs text-muted"><tr><th className="p-3">Item</th><th className="p-3 text-right">Requested</th><th className="p-3 text-right">Approved at this level</th><th className="p-3 text-right">Difference</th></tr></thead><tbody className="divide-y divide-line">{indent.data.items.map((line) => {
          const proposed = asNumber(quantities[line.id]);
          const difference = proposed - line.requested_quantity;
          return <tr key={line.id}><td className="p-3"><strong className="text-ink">{line.item_name}</strong><p className="font-mono text-xs text-muted">{line.item_code}</p></td><td className="p-3 text-right">{line.requested_quantity} {line.uom_code}</td><td className="p-3 text-right"><input type="number" min={0} max={line.requested_quantity} step="0.001" aria-label={`Approved quantity for ${line.item_name ?? line.id}`} value={quantities[line.id] ?? ""} onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))} className="h-11 w-28 rounded-lg border border-line bg-content1 px-3 text-right text-ink" /><span className="ml-1 text-xs text-muted">{line.uom_code}</span></td><td className={`p-3 text-right ${difference < 0 ? "font-semibold text-warning" : "text-muted"}`}>{difference === 0 ? "No change" : difference}</td></tr>;
        })}</tbody></table></div>
        {invalidQuantity && <p className="mt-2 text-sm text-danger">Every quantity must be between zero and the requested quantity.</p>}
      </section>

      <section><h2 className="mb-2 font-semibold text-ink">Approval checklist</h2><Card className="space-y-2 p-4">{CHECKS.map((label, index) => <label key={label} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-body"><input type="checkbox" checked={checks[index]} onChange={(event) => setChecks((current) => current.map((value, item) => item === index ? event.target.checked : value))} className="h-5 w-5" />{label}</label>)}</Card></section>

      <section><label className="text-sm font-semibold text-ink">Comments<textarea value={comments} onChange={(event) => setComments(event.target.value)} placeholder="Optional approval comment" className="mt-2 min-h-24 w-full rounded-lg border border-line bg-content1 p-3 text-sm text-ink" /></label></section>

      <section><h2 className="mb-2 font-semibold text-ink">Previous approvals</h2><Card className="divide-y divide-line p-0">{history.isLoading && <p className="p-4 text-sm text-muted">Loading history…</p>}{(history.data ?? []).map((row) => <div key={row.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><strong className="text-ink">{row.actor_name ?? "System"}</strong><p className="text-xs text-muted">{row.stage_name ?? `Stage ${row.stage_sequence}`} · {row.actor_position ?? "Position unavailable"}</p></div><StatusPill status={row.action} /></div>{row.comments && <p className="mt-2 text-sm text-body">{row.comments}</p>}<p className="mt-1 text-xs text-muted">{row.acted_at ? new Date(row.acted_at).toLocaleString() : "—"}</p></div>)}{!history.isLoading && !(history.data ?? []).length && <p className="p-4 text-sm text-muted">No previous approval actions.</p>}</Card></section>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line py-4"><Button variant="ghost" disabled={busy} onClick={() => { setReason(""); setConfirming("return"); }}><RotateCcw className="h-4 w-4" /> Return for correction</Button><Button variant="danger" disabled={busy} onClick={() => { setReason(""); setConfirming("reject"); }}><X className="h-4 w-4" /> Reject</Button><Button disabled={busy || invalidQuantity || !checks.every(Boolean)} onClick={() => setConfirming("approve")}><Check className="h-4 w-4" /> Approve</Button></div>
    </div>

    <ConfirmModal isOpen={confirming !== null} title={confirming === "approve" ? "Approve this request?" : confirming === "reject" ? "Reject this request?" : "Return for correction?"} message={confirming === "approve" ? "The saved quantities move to the next approval level or complete the approval." : confirming === "reject" ? "The request will stop and the requester will see your reason." : "Your correction instructions will be recorded in approval history."} confirmLabel={confirming === "approve" ? "Approve" : confirming === "reject" ? "Reject" : "Return"} danger={confirming === "reject"} busy={busy} error={actionError} onClose={() => setConfirming(null)} onConfirm={confirm}>
      {(confirming === "reject" || confirming === "return") && <label className="text-sm font-semibold text-ink">{confirming === "reject" ? "Rejection reason" : "What must be corrected?"}<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-24 w-full rounded-lg border border-line bg-content1 p-3 text-sm text-ink" placeholder="Required" />{!reason.trim() && <p className="mt-1 text-xs text-danger">A reason is required.</p>}</label>}
    </ConfirmModal>
  </>;
}
