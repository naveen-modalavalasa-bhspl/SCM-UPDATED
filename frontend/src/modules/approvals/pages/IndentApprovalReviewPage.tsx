import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { AlertCircle, ArrowLeft, Check, PackageCheck, RotateCcw, X } from "lucide-react";
import { Button, Card, ConfirmModal, PageHeader, StatusPill } from "@/shared/components";
import { approvalsApi } from "../api";
import { IssueFromStockPanel } from "../components/IssueFromStockPanel";
import {
  allowedRange, approvalCeiling, formatQuantity, quantityError,
  quantityValue, wasReducedBelow,
} from "../quantityRules";
import { isIndentModuleQuery } from "@/modules/indents/api";
import { alerts } from "@/modules/alerts";

type Decision = "approve" | "reject" | "return" | null;
const CHECKS = [
  "I checked every requested item and quantity.",
  "I checked the business need and priority.",
  "I checked the approved quantities shown below.",
];

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
  // Closed to start: opening it is what fetches the approver's own stock, so the
  // review screen costs one request until they ask to serve.
  const [serving, setServing] = useState(false);

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
    // Prefilled with the ceiling, so "approve as asked" is the no-edit path and the
    // approver only touches the lines they mean to cut.
    setQuantities(Object.fromEntries(
      indent.data.items.map((line) => [line.id, formatQuantity(approvalCeiling(line))]),
    ));
  }, [indent.data]);

  const errorByLine = useMemo(() => Object.fromEntries(
    (indent.data?.items ?? []).map((line) => [line.id, quantityError(line, quantities[line.id])]),
  ), [indent.data, quantities]);
  const invalidCount = Object.values(errorByLine).filter(Boolean).length;
  const invalidQuantity = invalidCount > 0;
  const anyReducedBelow = (indent.data?.items ?? []).some(wasReducedBelow);
  const checksDone = checks.every(Boolean);

  // Every keystroke is kept; the message under the field does the correcting. Refusing
  // the key instead leaves the approver staring at a box that will not take their 16.
  const setQuantity = (line: { id: number }, raw: string) => {
    setQuantities((current) => ({ ...current, [line.id]: raw }));
  };

  /** Announced before the queries are dropped, so the number is still readable. */
  const announce = (decision: "approve" | "reject" | "return") => {
    const number = indent.data?.indent_no ?? "The indent";
    const raiser = indent.data?.requested_by_name || "the raiser";
    if (decision === "approve") void alerts.success("indent.approved", { number });
    else if (decision === "reject") void alerts.success("indent.rejected", { number, raiser });
    else void alerts.success("indent.returned", { number, raiser });
  };

  const finish = (decision: "approve" | "reject" | "return") => () => {
    announce(decision);
    // Dropped rather than invalidated: the decision just took the document out of
    // approval, so a refetch answers 422 ("Indent is not awaiting approval") and
    // paints an error over a screen that succeeded.
    qc.removeQueries({ queryKey: ["approvals", "indent", indentId] });
    qc.removeQueries({ queryKey: ["approvals", "history", "INDENT", indentId] });
    qc.invalidateQueries({ queryKey: ["approvals"], refetchType: "all" });
    qc.invalidateQueries({ predicate: isIndentModuleQuery, refetchType: "all" });
    nav("/approvals");
  };
  const approve = useMutation({
    mutationFn: () => approvalsApi.approveIndent(
      indentId,
      (indent.data?.items ?? []).map((line) => ({
        line_id: line.id,
        approved_quantity: quantityValue(quantities[line.id]),
      })),
      comments,
    ),
    onSuccess: finish("approve"),
  });
  const reject = useMutation({
    mutationFn: () => approvalsApi.rejectIndent(indentId, reason),
    onSuccess: finish("reject"),
  });
  const returnForCorrection = useMutation({
    mutationFn: () => approvalsApi.returnIndent(indentId, reason.trim()),
    onSuccess: finish("return"),
  });
  const busy = approve.isPending || reject.isPending || returnForCorrection.isPending;
  const actionError = approve.error || reject.error || returnForCorrection.error;
  const canReturnForCorrection = Boolean(indent.data?.can_return_for_correction);

  const confirm = () => {
    if ((confirming === "reject" || confirming === "return") && !reason.trim()) return;
    if (confirming === "return" && !canReturnForCorrection) return;
    if (busy) return;
    if (confirming === "approve") approve.mutate();
    if (confirming === "reject") reject.mutate();
    if (confirming === "return") returnForCorrection.mutate();
  };

  if (indent.isLoading) return <p className="p-6 text-sm text-muted">Loading approval details…</p>;
  if (indent.error) return <p className="rounded-lg bg-danger/10 p-4 text-danger">{(indent.error as Error).message}</p>;
  if (!indent.data) return <p className="p-6 text-muted">Approval not found.</p>;

  return <>
    <Button variant="ghost" onClick={() => nav("/approvals")}><ArrowLeft className="h-4 w-4" /> Back to approvals</Button>
    <PageHeader
      eyebrow="Approval review"
      title={indent.data.indent_no}
      actions={<>
        <StatusPill status={indent.data.current_stage_name ?? indent.data.status} />
        {/* Top right, next to the status: serving from your own stock is an action on
            the whole document, like approving, not a field inside the comparison. */}
        <Button variant="primary" onClick={() => setServing((open) => !open)}>
          <PackageCheck className="h-4 w-4" /> {serving ? "Hide own stock" : "Serve from own stock"}
        </Button>
      </>}
    />

    <div className="space-y-5">
      <Card className="p-4"><dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-muted">Requested by</dt><dd className="font-semibold text-ink">{indent.data.requested_by_name ?? "—"}</dd></div><div><dt className="text-muted">Department</dt><dd>{indent.data.department_name ?? "—"}</dd></div><div><dt className="text-muted">Priority</dt><dd><StatusPill status={indent.data.priority} /></dd></div></dl></Card>

      {/* Serve-from-own-stock sits above the decision, not after it: an approver who
          holds the goods should give them and let only the remainder climb. Behind a
          button because most approvals are a straight pass-up — the panel opens for
          the approver who means to give stock, and the quantities stay in view for
          everyone else. */}
      {serving && <section className="space-y-2">
        <h2 className="font-semibold text-ink">Serve from your own stock</h2>
        {/* Serving every line IS the decision: the ladder ends there, so the screen
            leaves exactly as it does after Approve rather than refetching a document
            that is no longer awaiting anyone. */}
        <IssueFromStockPanel indentId={indentId} onClosed={finish("approve")} />
      </section>}

      <section>
        <h2 className="font-semibold text-ink">Quantity comparison</h2>
        <p className="mb-2 max-w-3xl text-xs leading-relaxed text-muted">A quantity may be reduced down to zero, never increased, and what you approve becomes the maximum the next approver can pass on. {anyReducedBelow ? "Lines already cut by an earlier approver are capped at that lower quantity, not at the original request." : "Each field shows the range you may enter."}</p>
        <div className="overflow-x-auto rounded-xl border border-line"><table className="w-full min-w-[980px] table-fixed text-left text-sm"><colgroup><col className="w-[34%]" /><col className="w-[13%]" /><col className="w-[22%]" /><col className="w-[19%]" /><col className="w-[12%]" /></colgroup><thead className="bg-content2 text-xs text-muted"><tr><th className="px-4 py-3 text-left font-semibold">Item</th><th className="px-4 py-3 text-right font-semibold">Requested</th><th className="px-4 py-3 text-right font-semibold">Most you can approve</th><th className="px-4 py-3 text-right font-semibold">Approved at this level</th><th className="px-4 py-3 text-right font-semibold">Difference</th></tr></thead><tbody className="divide-y divide-line">{indent.data.items.map((line) => {
          const ceiling = approvalCeiling(line);
          const raw = quantities[line.id] ?? "";
          const lineError = errorByLine[line.id];
          const difference = lineError ? null : quantityValue(raw) - ceiling;
          const reduced = wasReducedBelow(line);
          return <tr key={line.id}><td className="px-4 py-3 align-top"><strong className="block truncate text-ink" title={line.item_name ?? undefined}>{line.item_name}</strong><p className="font-mono text-xs text-muted">{line.item_code}</p></td><td className="whitespace-nowrap px-4 py-3 text-right align-top tabular-nums">{formatQuantity(line.requested_quantity)} {line.uom_code}</td><td className="px-4 py-3 text-right align-top"><span className={`whitespace-nowrap tabular-nums ${reduced ? "font-semibold text-warning" : "text-body"}`}>{formatQuantity(ceiling)} {line.uom_code}</span>{reduced && <p className="text-xs text-muted">Cut by a previous approver</p>}</td><td className="px-4 py-3 text-right align-top">
            {/* One right-aligned block per cell, the same width as the column's
                right-aligned header: the input, its unit and the help line share
                the block's left and right edges, so nothing drifts out from under
                the field. The unit sits inside the field rather than beside it —
                hung outside, it pushed the box left of the header above it. */}
            <div className="ml-auto w-36">
              {/* The unit is a SIBLING of the input, not an overlay on top of it.
                  Absolutely positioned, it sat over the field's own text: the number
                  is right-aligned and grew straight under a unit the padding was not
                  wide enough to clear, so typing into "UOM-BOX" was unreadable. As a
                  flex row the input takes the space that is left and the two can
                  never collide, whatever the unit is called. The border and focus
                  ring move to the wrapper so it still reads as one control. */}
              <div className={`flex h-10 items-center rounded-lg border bg-content1 pr-3 transition focus-within:ring-2 ${lineError ? "border-danger bg-danger/5 focus-within:ring-danger/30" : "border-line focus-within:border-brand focus-within:ring-brand/25"}`}>
                <input type="text" inputMode="decimal" autoComplete="off" aria-label={`Approved quantity for ${line.item_name ?? line.id}`} aria-invalid={Boolean(lineError)} aria-describedby={`qty-help-${line.id}`} value={raw} onChange={(event) => setQuantity(line, event.target.value)} className="h-full min-w-0 flex-1 rounded-lg bg-transparent px-3 text-right tabular-nums text-ink outline-none" />
                <span className="shrink-0 whitespace-nowrap text-xs text-muted">{line.uom_code}</span>
              </div>
              {/* The range is on screen before anything goes wrong, and repeated inside
                  the error when it does — the approver never has to work out the cap. */}
              <p id={`qty-help-${line.id}`} className={`mt-1.5 flex items-start gap-1.5 text-left text-xs leading-snug ${lineError ? "text-danger" : "text-muted"}`} role={lineError ? "alert" : undefined}>
                {lineError && <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />}
                <span>{lineError ?? `You can approve ${allowedRange(line)}.`}</span>
              </p>
            </div>
          </td><td className={`whitespace-nowrap px-4 py-3 text-right align-top tabular-nums ${difference != null && difference < 0 ? "font-semibold text-warning" : "text-muted"}`}>{difference == null ? "—" : difference === 0 ? "No change" : `${formatQuantity(difference)} ${line.uom_code ?? ""}`.trim()}</td></tr>;
        })}</tbody></table></div>
      </section>

      <section><h2 className="mb-2 font-semibold text-ink">Approval checklist</h2><Card className="space-y-2 p-4">{CHECKS.map((label, index) => <label key={label} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-body"><input type="checkbox" checked={checks[index]} onChange={(event) => setChecks((current) => current.map((value, item) => item === index ? event.target.checked : value))} className="h-5 w-5" />{label}</label>)}</Card></section>

      <section><label className="text-sm font-semibold text-ink">Comments<textarea value={comments} onChange={(event) => setComments(event.target.value)} placeholder="Optional approval comment" className="mt-2 min-h-24 w-full rounded-lg border border-line bg-content1 p-3 text-sm text-ink" /></label></section>

      <section><h2 className="mb-2 font-semibold text-ink">Previous approvals</h2><Card className="divide-y divide-line p-0">{history.isLoading && <p className="p-4 text-sm text-muted">Loading history…</p>}{(history.data ?? []).map((row) => <div key={row.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><strong className="text-ink">{row.actor_name ?? "System"}</strong><p className="text-xs text-muted">{row.stage_name ?? `Stage ${row.stage_sequence}`} · {row.actor_position ?? "Position unavailable"}</p></div><StatusPill status={row.action} /></div>{row.comments && <p className="mt-2 text-sm text-body">{row.comments}</p>}<p className="mt-1 text-xs text-muted">{row.acted_at ? new Date(row.acted_at).toLocaleString() : "—"}</p></div>)}{!history.isLoading && !(history.data ?? []).length && <p className="p-4 text-sm text-muted">No previous approval actions.</p>}</Card></section>

      <div className="border-t border-line py-4">
        {/* A greyed-out Approve with no reason is the other half of the same confusion. */}
        {(invalidQuantity || !checksDone) && <div className={`mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${invalidQuantity ? "border-danger/30 bg-danger/10 text-danger" : "border-line bg-content2 text-muted"}`} role="status"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span>{invalidQuantity ? `Correct the ${invalidCount === 1 ? "highlighted quantity" : `${invalidCount} highlighted quantities`} before approving.` : "Confirm every item on the checklist before approving."}</span></div>}
        <div className="flex flex-wrap justify-end gap-2">{canReturnForCorrection && <Button variant="ghost" disabled={busy} onClick={() => { setReason(""); setConfirming("return"); }}><RotateCcw className="h-4 w-4" /> Return for correction</Button>}<Button variant="danger" disabled={busy} onClick={() => { setReason(""); setConfirming("reject"); }}><X className="h-4 w-4" /> Reject</Button><Button disabled={busy || invalidQuantity || !checksDone} onClick={() => setConfirming("approve")}><Check className="h-4 w-4" /> Approve</Button></div>
      </div>
    </div>

    <ConfirmModal isOpen={confirming !== null} title={confirming === "approve" ? "Approve this request?" : confirming === "reject" ? "Reject this request?" : "Return for correction?"} message={confirming === "approve" ? "The saved quantities move to the next approval level or complete the approval." : confirming === "reject" ? "The request will stop and the requester will see your reason." : "Your correction instructions will be recorded in approval history."} confirmLabel={confirming === "approve" ? "Approve" : confirming === "reject" ? "Reject" : "Return for correction"} danger={confirming === "reject"} busy={busy || ((confirming === "reject" || confirming === "return") && !reason.trim())} error={actionError} onClose={() => !busy && setConfirming(null)} onConfirm={confirm}>
      {(confirming === "reject" || confirming === "return") && <label className="text-sm font-semibold text-ink">{confirming === "reject" ? "Rejection reason" : "What must be corrected?"}<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-24 w-full rounded-lg border border-line bg-content1 p-3 text-sm text-ink" placeholder="Required" />{!reason.trim() && <p className="mt-1 text-xs text-danger">A reason is required.</p>}</label>}
    </ConfirmModal>
  </>;
}
