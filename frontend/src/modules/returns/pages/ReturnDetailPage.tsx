import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft } from "lucide-react";
import {
  Button, Card, ConfirmModal, ErrorBanner, Input, PageHeader, ResponsiveList,
  StatusPill, type Column,
} from "@/shared/components";
import { returnsApi } from "../api";
import { ApprovalTrail } from "../components/ApprovalTrail";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { CertificatePanel } from "../components/CertificatePanel";
import { DecisionPanel } from "../components/DecisionPanel";
import { ReturnStepper } from "../components/ReturnStepper";
import { money } from "../constants";
import type { ReturnLine } from "../types";
import { TONE_APPROVE, TONE_REJECT } from "@/shared/components/tones";

const qty = (value: string | number) => Number(value ?? 0).toLocaleString();

type Decision =
  | "approve" | "reject" | "cancel" | "acknowledge" | "endorse" | "object";

/**
 * One return, its journey, and the decision on it — the indent detail screen's layout:
 * stepper across the top, line items and evidence below, the trail beside them.
 *
 * Approve and reject live here rather than in the Approvals module: this module owns
 * its own decision screen so nothing outside `modules/returns` had to change. The
 * buttons render off `can_act`, which the backend computes from the live workflow task
 * — not from a permission — so a person who holds `stock.transfer.approve` but is not
 * the current rung sees the document without an action on it. `can_acknowledge` works
 * the same way: only the raiser, and only once the stock has actually moved.
 */
export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const returnId = Number(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [comments, setComments] = useState("");
  const [confirming, setConfirming] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["returns", returnId],
    queryFn: () => returnsApi.get(returnId),
  });

  const { data: journey, isLoading: journeyLoading } = useQuery({
    queryKey: ["returns", returnId, "journey"],
    queryFn: () => returnsApi.journey(returnId),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["returns"] });
  };

  const act = useMutation({
    mutationFn: (decision: Decision) => {
      if (decision === "approve") return returnsApi.approve(returnId, comments);
      if (decision === "reject") return returnsApi.reject(returnId, comments);
      if (decision === "acknowledge") return returnsApi.acknowledge(returnId);
      if (decision === "endorse") return returnsApi.endorse(returnId, comments);
      if (decision === "object") return returnsApi.objectToDecision(returnId, comments);
      return returnsApi.cancel(returnId);
    },
    onSuccess: () => {
      setError(null);
      setComments("");
      setConfirming(null);
      refresh();
    },
    onError: (err: any) => {
      setConfirming(null);
      setError(err?.response?.data?.error ?? "That action could not be completed.");
    },
  });

  if (isLoading) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (!doc) return <ErrorBanner error="This return could not be found." />;

  const columns: Column<ReturnLine>[] = [
    {
      key: "item",
      header: "Item",
      render: (row) => (
        <div>
          <div className="font-medium text-ink">{row.item_name ?? "—"}</div>
          <div className="text-xs text-muted">{row.item_code ?? ""}</div>
        </div>
      ),
    },
    {
      key: "quantity",
      header: "Qty",
      render: (row) => <span className="text-ink">{qty(row.quantity)}</span>,
    },
    {
      key: "uom",
      header: "UOM",
      render: (row) => <span className="text-muted">{row.uom_code ?? "—"}</span>,
    },
    {
      key: "remarks",
      header: "Note",
      hideOnNarrow: true,
      render: (row) => <span className="text-sm text-body">{row.remarks ?? "—"}</span>,
    },
  ];

  // An objection needs a reason for the same reason a rejection does: somebody has to act
  // on it, and "no" with no words is not a handover.
  const needComment =
    (confirming === "reject" || confirming === "object") && !comments.trim();

  const confirmCopy: Record<Decision, { title: string; message: string; label: string }> = {
    approve: {
      title: "Approve this return?",
      message:
        "If you are the last approver on the reporting line, the return moves on to the decision desk, which decides where the stock actually goes.",
      label: "Approve",
    },
    endorse: {
      title: "Endorse this decision?",
      message: doc?.decision
        ? `${doc.decision.disposition_label}. If you are the last sign-off, this is carried out straight away.`
        : "If you are the last sign-off, the decision is carried out straight away.",
      label: "Endorse",
    },
    object: {
      title: "Send this decision back?",
      message: needComment
        ? "Say what is wrong with it first — the desk has to decide again."
        : "The decision is cleared and the desk decides again. The return itself stands and the hold on the stock stays.",
      label: "Send it back",
    },
    reject: {
      title: "Reject this return?",
      message: needComment
        ? "Add a comment first — the returner has to be told why."
        : "The hold on the stock is released and it stays where it is.",
      label: "Reject",
    },
    cancel: {
      title: "Withdraw this return?",
      message: "The hold on the stock is released and this return is closed.",
      label: "Withdraw",
    },
    acknowledge: {
      title: "Acknowledge this return?",
      message:
        "This confirms the return is done and closes the document. It moves no stock — whatever the decision was has already been carried out.",
      label: "Acknowledge",
    },
  };

  return (
    <div>
      <Link
        to="/returns"
        className="mb-2 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted hover:text-body"
      >
        <ChevronLeft className="h-4 w-4" /> All returns
      </Link>

      <PageHeader
        eyebrow="RETURN"
        title={doc.return_no}
        actions={
          <>
            {doc.can_edit && (
              <Button variant="soft" onClick={() => navigate(`/returns/${doc.id}/edit`)}>
                Edit
              </Button>
            )}
            {doc.can_withdraw && (
              <Button variant="dangerSoft" onClick={() => setConfirming("cancel")}>
                Withdraw
              </Button>
            )}
            {doc.can_acknowledge && (
              <Button onClick={() => setConfirming("acknowledge")}>
                Acknowledge receipt
              </Button>
            )}
            {doc.can_act && (
              <>
                <Button className={TONE_APPROVE} onClick={() => setConfirming("approve")}>Approve</Button>
                <Button className={TONE_REJECT} variant="dangerSoft" onClick={() => setConfirming("reject")}>
                  Reject
                </Button>
              </>
            )}
            {/* The floor's two verbs. Not Approve and Reject: the return is not in
              * question at this point, the route is. */}
            {doc.can_endorse && (
              <>
                <Button onClick={() => setConfirming("endorse")}>Endorse</Button>
                <Button variant="dangerSoft" onClick={() => setConfirming("object")}>
                  Send back
                </Button>
              </>
            )}
          </>
        }
      />

      {error && <ErrorBanner error={error} />}

      <Card className="mb-4 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <StatusPill status={doc.status} />
          {doc.current_approver_name && (
            <span className="text-sm text-muted">with {doc.current_approver_name}</span>
          )}
        </div>
        <ReturnStepper journey={journey} isLoading={journeyLoading} />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* The desk's own screen, inline on the document rather than on a separate page:
            * the decision is made while looking at the photo, the quantity and the value,
            * and a modal would hide exactly that. */}
          {doc.can_decide && (
            <DecisionPanel returnId={returnId} onDone={() => setError(null)} />
          )}

          {/* Renders nothing unless the decision was a controlled disposal. */}
          <CertificatePanel doc={doc} />

          {doc.decision && (
            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold text-ink">
                  {doc.decision.disposition_label}
                </h2>
                {doc.decision.objections > 0 && (
                  <span className="rounded-full bg-bad-bg px-2 py-0.5 text-xs font-semibold text-bad">
                    sent back {doc.decision.objections}×
                  </span>
                )}
              </div>
              <p className="text-sm text-body">{doc.decision.note}</p>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                {[
                  ["Decided by", doc.decision.decided_by_name],
                  [
                    "Decided on",
                    doc.decision.decided_at
                      ? new Date(doc.decision.decided_at).toLocaleString()
                      : null,
                  ],
                  ["Vendor", doc.decision.vendor_name],
                  ["Disposal agency", doc.decision.disposal_agency],
                  // What it was worth WHEN the decision was taken. A later re-costing must
                  // not rewrite the figure the reasoning is recorded against.
                  ["Worth then", money(doc.decision.value)],
                ]
                  .filter(([, value]) => value && value !== "—")
                  .map(([label, value]) => (
                    <div key={label as string}>
                      <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                        {label}
                      </dt>
                      <dd className="text-ink">{value as string}</dd>
                    </div>
                  ))}
              </dl>

              {doc.can_endorse && (
                <div className="mt-4 border-t border-line pt-4">
                  <Input
                    value={comments}
                    onChange={(event) => setComments(event.target.value)}
                    placeholder="Comments (required to send it back)"
                    aria-label="Endorsement comments"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button onClick={() => setConfirming("endorse")}>
                      Endorse — carry it out
                    </Button>
                    <Button variant="dangerSoft" onClick={() => setConfirming("object")}>
                      Send back for a fresh decision
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {doc.hazard_features.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl bg-warn-bg px-3 py-2 text-sm text-warn">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Flagged <strong>{doc.hazard_features.join(", ")}</strong> — this cannot be
                scrapped at a branch.
              </span>
            </div>
          )}

          <Card className="p-4">
            <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
              Line items
            </h2>
            <ResponsiveList
              data={doc.items}
              columns={columns}
              keyOf={(row) => row.id}
              renderCard={(row) => (
                <div className="p-4">
                  <div className="font-medium text-ink">{row.item_name ?? "—"}</div>
                  <div className="text-xs text-muted">{row.item_code ?? ""}</div>
                  <div className="mt-1 text-sm text-body">
                    {qty(row.quantity)} {row.uom_code ?? ""}
                  </div>
                  {row.remarks && (
                    <div className="mt-1 text-xs text-muted">{row.remarks}</div>
                  )}
                </div>
              )}
            />
          </Card>

          <AttachmentsPanel returnId={returnId} editable={doc.can_edit} />
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
              Details
            </h2>
            <dl className="space-y-3 text-sm">
              {[
                ["Kind", doc.kind_label],
                ["Reason", doc.reason_label ?? doc.reason],
                ["Description", doc.reason_note],
                ["What the branch wants", doc.intent_label],
                // "—" where nothing on the return has a cost recorded anywhere. Never ₹0.
                ["Worth", money(doc.value)],
                ["Returning from", doc.from_warehouse_name],
                // Only a send-to-a-point decision lands anywhere. After any other outcome
                // this still holds the point the return was ADDRESSED to when it was
                // raised, so printing it read as though scrapped material had arrived
                // there. The decision card says where it actually went.
                [
                  "Going to",
                  doc.decision && doc.decision.disposition !== "SEND_TO_POINT"
                    ? null
                    : doc.to_warehouse_name,
                ],
                ["Returned by", doc.raised_by_name],
                ["Employee id", doc.raised_by_code],
                ["Office", doc.office_name],
                ["Raised on", doc.created_at ? new Date(doc.created_at).toLocaleString() : null],
                ["Approved on", doc.approved_at ? new Date(doc.approved_at).toLocaleString() : null],
                [
                  "Acknowledged on",
                  doc.received_at ? new Date(doc.received_at).toLocaleString() : null,
                ],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label as string}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {label}
                    </dt>
                    <dd className="text-ink">{value as string}</dd>
                  </div>
                ))}
            </dl>
          </Card>

          {doc.can_act && (
            <Card className="p-4">
              <h2 className="mb-3 font-display text-lg font-bold text-ink">
                Your decision
              </h2>
              <Input
                value={comments}
                onChange={(event) => setComments(event.target.value)}
                placeholder="Comments (required to reject)"
                aria-label="Approval comments"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button className={TONE_APPROVE} onClick={() => setConfirming("approve")}>Approve</Button>
                <Button className={TONE_REJECT} variant="dangerSoft" onClick={() => setConfirming("reject")}>
                  Reject
                </Button>
              </div>
            </Card>
          )}

          <ApprovalTrail returnId={returnId} />
        </div>
      </div>

      {confirming && (
        <ConfirmModal
          isOpen
          danger={
            confirming === "reject" ||
            confirming === "cancel" ||
            confirming === "object"
          }
          busy={act.isPending}
          confirmDisabled={needComment}
          title={confirmCopy[confirming].title}
          message={confirmCopy[confirming].message}
          confirmLabel={confirmCopy[confirming].label}
          onConfirm={() => {
            if (needComment) return;
            act.mutate(confirming);
          }}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
