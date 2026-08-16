import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader, StatCard,
  StatusPill, useAction,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { consolidationApi } from "../api";
import { money } from "./RequisitionListPage";

const EDITABLE = ["DRAFT"];

/**
 * One consolidated sheet: the item-wise roll-up, and what each line came from.
 *
 * `approved_qty` is the only editable number and it can only go DOWN. The sheet is
 * where over-ordering gets trimmed; buying more than the approved requisitions asked
 * for is demand nobody signed off, so the backend refuses it and the input says so
 * before the save rather than after.
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

  return (
    <div>
      <PageHeader
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
                <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
                  Send for approval
                </Button>
              </Can>
            )}
            {doc.status === "PENDING_APPROVAL" && (
              <Can do="consolidation.approve">
                <Button variant="ghost" onClick={() => setReject(true)}>Reject</Button>
                <Button onClick={() => approve.mutate()} disabled={approve.isPending}>
                  Approve
                </Button>
              </Can>
            )}
            {["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(doc.status) && (
              <Can do="consolidation.create">
                <Button variant="ghost" onClick={() => cancel.mutate()}
                  disabled={cancel.isPending}>
                  Cancel
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={saveLines.error ?? submit.error ?? approve.error
        ?? doReject.error ?? cancel.error} />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Status" value={<StatusPill status={doc.status} />} />
        <StatCard label="Requisitions" value={doc.source_count} />
        <StatCard label="Item lines" value={doc.total_items} />
        <StatCard label="Estimated" value={money(doc.estimated_value)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <Card className="space-y-3 p-5 lg:col-span-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-lg font-semibold text-ink">
              {doc.title ?? "Consolidated demand"}
            </h2>
            {doc.period_label && (
              <span className="text-sm text-muted">{doc.period_label}</span>
            )}
          </div>

          {trimmed && (
            <p className="rounded-md bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:bg-sky-900/20 dark:text-sky-200">
              Some lines have been trimmed below what was requested. Only the approved
              quantity will be tendered.
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2">Item</th>
                  <th className="py-2 text-right">Requested</th>
                  <th className="py-2 text-right">To buy</th>
                  <th className="py-2 text-right">Rate</th>
                  <th className="py-2 text-right">Value</th>
                  <th className="py-2">Needed by</th>
                  <th className="py-2">Asked by</th>
                </tr>
              </thead>
              <tbody>
                {doc.items.map((line) => (
                  <tr key={line.id} className="border-b border-line/50 align-top">
                    <td className="py-2">
                      <div className="text-ink">{line.item_name ?? "—"}</div>
                      <div className="font-mono text-[11px] text-muted">
                        {line.item_code}
                      </div>
                    </td>
                    <td className="py-2 text-right">
                      {Number(line.quantity)} {line.uom_code}
                    </td>
                    <td className="py-2 text-right">
                      {editable ? (
                        <div className="ml-auto w-24">
                          <Input
                            type="number"
                            value={edits[line.id] ?? ""}
                            max={Number(line.quantity)}
                            onChange={(e) => setEdits({ ...edits, [line.id]: e.target.value })}
                          />
                        </div>
                      ) : (
                        <span className="font-semibold text-ink">
                          {Number(line.approved_qty)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">{money(line.estimated_rate)}</td>
                    <td className="py-2 text-right font-semibold text-ink">
                      {money(line.estimated_amount)}
                    </td>
                    <td className="py-2">{fmtDate(line.required_date)}</td>
                    <td className="py-2">
                      <span className="text-[11px] text-muted">
                        {line.sources ?? `${line.source_count} requisition(s)`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="space-y-3 p-5">
          <h2 className="font-display text-lg font-semibold text-ink">
            Rolled up from
          </h2>
          {(sources ?? []).length === 0 ? (
            <p className="text-sm text-muted">No requisitions linked.</p>
          ) : (
            <ul className="space-y-2">
              {(sources ?? []).map((source) => (
                <li key={source.id} className="border-b border-line/50 pb-2 last:border-0">
                  <button
                    className="text-left"
                    onClick={() => nav(`/procurement/requisitions/${source.requisition_id}`)}
                  >
                    <div className="font-mono text-xs font-semibold text-ink">
                      {source.requisition_no}
                    </div>
                    <div className="text-[11px] text-muted">
                      {source.project_name ?? "—"} · {source.item_count} line
                      {source.item_count === 1 ? "" : "s"} ·{" "}
                      {money(source.estimated_value)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {doc.approved_by_name && (
            <p className="pt-2 text-xs text-muted">
              Approved by {doc.approved_by_name}
            </p>
          )}
          {doc.current_approver_name && (
            <p className="pt-2 text-xs text-muted">
              With {doc.current_approver_name}
            </p>
          )}
        </Card>
      </div>

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
