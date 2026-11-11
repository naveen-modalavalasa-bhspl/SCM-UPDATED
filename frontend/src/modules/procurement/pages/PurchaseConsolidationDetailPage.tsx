import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, StatusPill, useAction } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { Button } from "../components/ActionButton";
import { fmtDate } from "@/shared/datetime";
import { consolidationApi } from "../api";
import { ApprovalTrail } from "../components/ApprovalTrail";
import { DetailShell, SectionCard, RailStat } from "../components/DetailKit";
import { money } from "./RequisitionListPage";
import { TONE_APPROVE, TONE_REJECT, TONE_SUBMIT } from "@/shared/components/tones";
import { CombinationTag } from "@/shared/combination";

const EDITABLE = ["DRAFT"];

/**
 * One consolidated sheet: the item-wise roll-up, and what each line came from.
 *
 * `approved_qty` can go DOWN freely, and UP to the replenishment ceiling the
 * backend serves per line (`max_allowed_qty` = requested + max−available at the
 * shipment warehouses that asked for it). Where no replenishment rule exists the
 * ceiling equals what was requested, so the line stays decrease-only.
 */
export function PurchaseConsolidationDetailPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const consId = Number(id);

  const [edits, setEdits] = useState<Record<number, string>>({});
  const [reject, setReject] = useState(false);
  const [note, setNote] = useState("");

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["consolidation", id],
    queryFn: () => consolidationApi.get(consId),
  });
  const { data: sources } = useQuery({
    queryKey: ["consolidation-sources", id],
    queryFn: () => consolidationApi.sources(consId),
  });

  useEffect(() => {
    if (!doc) return;
    setEdits(Object.fromEntries(
      doc.items.map((line) => [line.id, String(Number(line.approved_qty))]),
    ));
  }, [doc]);

  const invalidates = [["consolidations"], ["consolidation", id]];
  const saveLines = useAction({
    run: () => consolidationApi.setLines(consId, doc!.items.map((line) => ({
      line_id: line.id,
      approved_qty: Number(edits[line.id] ?? line.approved_qty),
    }))),
    success: "Quantities saved", invalidates,
  });
  const submit = useAction({
    run: () => consolidationApi.submit(consId),
    success: "Sent for approval", invalidates,
  });
  const approve = useAction({
    run: () => consolidationApi.approve(consId),
    success: "Sheet approved", invalidates,
  });
  const doReject = useAction({
    run: () => consolidationApi.reject(consId, note),
    success: "Sheet rejected", invalidates,
    onDone: () => { setReject(false); setNote(""); },
  });
  const cancel = useAction({
    run: () => consolidationApi.cancel(consId),
    success: "Sheet cancelled", invalidates,
  });

  if (isLoading) return <div className="p-6 text-muted">Loading…</div>;
  if (!doc) return <ErrorBanner error={error} />;

  const editable = EDITABLE.includes(doc.status);
  const trimmed = doc.items.some(
    (line) => Number(line.approved_qty) < Number(line.quantity),
  );
  const toppedUp = doc.items.some(
    (line) => Number(line.approved_qty) > Number(line.quantity),
  );

  const { can, me } = useAuth();
  const isAdmin = can("admin.workflow.manage") || Boolean(me?.roles.includes("ADMIN")) || Boolean(me?.roles.includes("SUPERUSER"));
  const canDecide = doc.status === "PENDING_APPROVAL" && (Boolean(doc.awaiting_me) || isAdmin);

  return (
    <div>
      <PageHeader
        back={{ to: "/procurement/consolidations", label: "Back to Purchase sheets" }}
        eyebrow="Procurement"
        title={doc.cons_no}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/procurement/consolidations")}>
              Back
            </Button>
            {editable && (
              <Can do="consolidation.create">
                <Button variant="ghost" onClick={() => saveLines.mutate()}
                  disabled={saveLines.isPending}>
                  Save quantities
                </Button>
                <Button className={TONE_SUBMIT} onClick={() => submit.mutate()} disabled={submit.isPending}>
                  Send for approval
                </Button>
              </Can>
            )}
            {canDecide && (can("consolidation.approve") || isAdmin) && (
              <>
                <Button className={TONE_REJECT} variant="ghost" onClick={() => setReject(true)}>Reject</Button>
                <Button className={TONE_APPROVE} onClick={() => approve.mutate()} disabled={approve.isPending}>
                  {isAdmin && !doc.awaiting_me ? "Approve (Admin Override)" : "Approve"}
                </Button>
              </>
            )}
            {["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(doc.status) && (
              <Can do="consolidation.create">
                <Button variant="ghost" onClick={() => cancel.mutate()}
                  disabled={cancel.isPending}>
                  Cancel
                </Button>
              </Can>
            )}
            {doc.status === "APPROVED" && !doc.has_rfq && (
              <Can do="rfq.create">
                <Button onClick={() => nav(`/procurement/rfqs/new?consolidation=${doc.id}`)}>
                  Create RFQ
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={saveLines.error ?? submit.error ?? approve.error
        ?? doReject.error ?? cancel.error} />

      <DetailShell
        main={(
          <SectionCard
            title={doc.title ?? "Consolidated demand"}
            action={doc.period_label
              ? <span className="text-sm text-muted">{doc.period_label}</span>
              : undefined}
          >
            {trimmed && (
              <p className="mb-3 rounded-lg border border-info/30 bg-info-bg px-3 py-2 text-sm text-info">
                Trimmed below what was requested — only the approved quantity is tendered.
              </p>
            )}
            {toppedUp && (
              <p className="mb-3 rounded-lg border border-info/30 bg-info-bg px-3 py-2 text-sm text-info">
                Topped up above what was requested, within each line's replenishment ceiling.
              </p>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left">
                    {["Item", "Requested", "To buy", "Rate", "Value", "Needed by", "Asked by"].map((head, i) => (
                      <th
                        key={head}
                        className={`whitespace-nowrap px-3 py-2 text-[11px] font-bold uppercase tracking-[0.06em] text-muted ${
                          i >= 1 && i <= 4 ? "text-right" : ""
                        }`}
                      >
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {doc.items.map((line) => (
                    <tr key={line.id} className="border-b border-line/50 align-top transition-colors hover:bg-content2/40">
                      <td className="px-3 py-3">
                        <div className="font-medium text-ink">{line.item_name ?? "—"}</div>
                        <div className="font-mono text-[11px] text-muted">{line.item_code}</div>
                        <CombinationTag value={line} className="mt-1" />
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-body">
                        {Number(line.quantity)} {line.uom_code}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {editable ? (
                          <div className="ml-auto w-28">
                            <Input
                              type="number"
                              data-uom={line.uom_code ?? ""}
                              value={edits[line.id] ?? ""}
                              max={Number(line.max_allowed_qty ?? line.quantity)}
                              onChange={(e) => setEdits({ ...edits, [line.id]: e.target.value })}
                            />
                            {Number(line.replenishment_qty ?? 0) > 0 ? (
                              <div className="mt-1 text-[11px] leading-tight text-muted">
                                Up to {Number(line.max_allowed_qty ?? line.quantity)} {line.uom_code}
                                {" "}(+{Number(line.replenishment_qty)} top-up
                                {line.replenishment_at ? ` at ${line.replenishment_at}` : ""})
                              </div>
                            ) : (
                              <div className="mt-1 text-[11px] leading-tight text-muted">
                                Max {Number(line.quantity)} {line.uom_code} — no top-up (no replenishment rule here)
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="font-semibold text-ink">{Number(line.approved_qty)}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-body">
                        {money(line.estimated_rate)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums text-ink">
                        {money(line.estimated_amount)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-body">{fmtDate(line.required_date)}</td>
                      <td className="px-3 py-3 text-[11px] text-muted">
                        {line.sources ?? `${line.source_count} requisition(s)`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        )}
        rail={(
          <>
            <SectionCard>
              <div className="mb-4 flex items-center justify-between gap-2 border-b border-line/60 pb-4">
                <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Status</span>
                <StatusPill status={doc.status} />
              </div>
              <RailStat label="Estimated" value={money(doc.estimated_value)} />
              <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line/60 pt-4">
                <RailStat label="Requisitions" value={doc.source_count} />
                <RailStat label="Item lines" value={doc.total_items} />
                {doc.organization_name && (
                  <RailStat label="Organisation" value={doc.organization_name} />
                )}
                {doc.org_department_name && (
                  <RailStat label="Department" value={doc.org_department_name} />
                )}
              </div>
            </SectionCard>

            <SectionCard title="Rolled up from">
              {(sources ?? []).length === 0
                ? <p className="text-sm text-muted">No requisitions linked.</p>
                : (
                  <ul className="space-y-0.5">
                    {(sources ?? []).map((source) => (
                      <li key={source.id}>
                        <button
                          type="button"
                          onClick={() => nav(`/procurement/requisitions/${source.requisition_id}`)}
                          className="w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-content2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        >
                          <div className="font-mono text-[13px] font-semibold text-brand">
                            {source.requisition_no}
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-muted">
                            {source.project_name ?? "—"} · {source.item_count} line
                            {source.item_count === 1 ? "" : "s"} · {money(source.estimated_value)}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </SectionCard>

            <ApprovalTrail docType="CONSOLIDATION" docId={Number(id)} />
          </>
        )}
      />


      <ConfirmModal
        isOpen={reject}
        title={`Reject ${doc.cons_no}?`}
        message="The requisitions go back to approved so they can be consolidated again."
        confirmLabel="Reject"
        danger
        busy={doReject.isPending}
        confirmDisabled={!note.trim()}
        onConfirm={() => doReject.mutate()}
        onClose={() => setReject(false)}
      >
        <Field label="Reason">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmModal>
    </div>
  );
}
