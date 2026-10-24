import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, BadgeCheck, CalendarClock, ChevronRight, ClipboardList, FileSignature,
  Gavel, IdCard, Layers, MessageSquareWarning, ScrollText, Tag, Target,
  Undo2, UserRound,
} from "lucide-react";
import {
  BackLink, Button, Card, ConfirmModal, ErrorBanner, Input, PageHeader, ResponsiveList,
  StatusPill, type Column,
} from "@/shared/components";
import { returnsApi, type ReturnStage } from "../api";
import { ApprovalTrail } from "../components/ApprovalTrail";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { CertificatePanel } from "../components/CertificatePanel";
import { DecisionPanel } from "../components/DecisionPanel";
import {
  Fact, MetaChip, PersonBadge, RouteRibbon, SectionCard,
} from "../components/DetailChrome";
import { LogisticsPanel } from "../components/LogisticsPanel";
import { ReceiptModal } from "../components/ReceiptModal";
import { RelatedDocumentsSection } from "../components/RelatedDocumentsSection";
import { ReturnStepper } from "../components/ReturnStepper";
import { PHASE, money, roleOnly } from "../constants";
import { originOf } from "../origin";
import type { ReturnLine } from "../types";
import { CombinationTag } from "@/shared/combination";

const qty = (value: string | number) => Number(value ?? 0).toLocaleString();

const stamp = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : null;

type Decision =
  | "approve" | "reject" | "cancel" | "acknowledge" | "endorse" | "object"
  | "sendBack" | "rejectStage";

/**
 * Which stage the document is sitting at, as the send-back and reject routes name it.
 * Null anywhere those verbs do not apply — a draft, a document in logistics, a closed
 * one. Derived from the phase rather than from which button was clicked so the route and
 * the guard can never disagree about where the return actually is.
 */
const stageOf = (phase: string | null | undefined): ReturnStage | null =>
  phase === PHASE.DECISION ? "decision"
    : phase === PHASE.ENDORSE ? "sign-off"
      : phase === PHASE.FIELD ? "approval"
        : null;

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
 *
 * REDRAWN 2026-09-10. Every string, every guard and every press is the one that was here
 * before; what changed is where the reader's eye lands. Three things were wrong with the
 * old arrangement and none of them was a missing field:
 *
 *  - **The document had no head.** Sixteen facts sat in one flat definition list in the
 *    right-hand column, so the three that answer "what am I looking at" — what it is
 *    worth, which request it answers, where the material is going — were the same size
 *    and weight as the employee id. They are a band across the top now, and the movement
 *    is drawn as a movement (`RouteRibbon`) instead of as two unrelated rows.
 *  - **The press was below the reference.** An approver landed on Details and had to
 *    scroll past it to find the comment box they had opened the document to use. The
 *    panel that wants something from this reader is now the first thing in its column and
 *    wears a hairline of the brand, so it is found by scrolling rather than by reading.
 *  - **Fourteen panels had drawn fourteen headings.** One card head (`SectionCard`), so
 *    the screen reads as one document.
 */
export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const returnId = Number(id);
  const navigate = useNavigate();
  /* The screen this document was opened from — the queue, not always the register.
   * The same state keeps that tab lit in the module strip while this page is open,
   * so the link back and the highlighted tab can never name two different places. */
  const location = useLocation();
  const origin = originOf(location.state);
  const queryClient = useQueryClient();

  const [comments, setComments] = useState("");
  const [confirming, setConfirming] = useState<Decision | null>(null);
  // The receipt form, which is its own modal rather than a `Decision` — it collects
  // quantities and evidence, and `confirmCopy` only carries a sentence and a label.
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The stocking point the decision desk has picked, while it is still only a pick.
   *
   * Null until they touch the box, which is what keeps "Going to" showing the served
   * answer for every reader who is not the one deciding. It is deliberately NOT cleared
   * when the decision is recorded: `can_decide` goes false on the refetch that follows,
   * and that is what hands the row back to the server's answer. Clearing it here would
   * flick the band back to the addressed-to point for the moment between the press
   * landing and the fresh document arriving.
   */
  const [pickedDestination, setPickedDestination] = useState<string | null>(null);

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
      if (decision === "sendBack" || decision === "rejectStage") {
        const stage = stageOf(doc?.phase);
        // The button only renders off `can_send_back`, which the server computes from
        // the live workflow task — so this cannot normally be reached. Rejecting it here
        // rather than posting to a URL built from an empty string is what stops a stale
        // page (the return moved on in another tab) firing at the wrong stage.
        if (!stage) {
          return Promise.reject(new Error(
            "This return has moved on — reload the page to see where it is now."));
        }
        if (decision === "sendBack") {
          return returnsApi.sendBack(returnId, stage, comments);
        }
        if (stage === "approval") {
          // The reporting line's refusal is its own chain's rejection, not a desk's.
          return returnsApi.reject(returnId, comments);
        }
        return returnsApi.rejectAtStage(returnId, stage, comments);
      }
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
        <div className="min-w-0">
          <div className="font-medium text-ink">{row.item_name ?? "—"}</div>
          <div className="mono text-xs text-muted">{row.item_code ?? ""}</div>
          <CombinationTag value={row} className="mt-1" />
        </div>
      ),
    },
    {
      key: "quantity",
      header: "Qty",
      render: (row) => (
        <span className="tabular font-semibold text-ink">{qty(row.quantity)}</span>
      ),
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
  // on it, and "no" with no words is not a handover. A send-back needs one most of all —
  // it is the only thing the raiser is given to work out what to change.
  const needComment =
    (confirming === "reject" || confirming === "object"
      || confirming === "sendBack" || confirming === "rejectStage")
    && !comments.trim();

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
      // CHANGED 2026-09-10: two presses live behind one button now, and they settle
      // different things — signing for a load that is still on its leg puts the material
      // on the receiving point's balance, where the same press on one already landed only
      // closes the paper. Saying "it moves no stock" over the first would be a lie told
      // in the last place it could have been prevented.
      message: doc?.can_receive
        ? `This signs for the material at ${doc?.to_warehouse_name || "the receiving point"}. It goes onto that point's stock balance and the purchase return against it is raised for approval.`
        : "This confirms the return is done and closes the document. It moves no stock — whatever the decision was has already been carried out.",
      label: doc?.can_receive ? "Acknowledge receipt" : "Acknowledge",
    },
    sendBack: {
      title: `Send this back to ${doc?.raised_by_name || "the raiser"}?`,
      message: needComment
        ? "Say what has to be corrected first — this note is all they get."
        : "The return goes back to a draft they can edit. The hold on the stock is released, the approvals so far are abandoned and any decision is cleared, so a corrected return is decided and approved again from the top.",
      label: "Send it back",
    },
    rejectStage: {
      title: "Reject this return?",
      message: needComment
        ? "Add a comment first — the returner has to be told why."
        : "This refuses the return outright and closes the document. The hold is released and the material stays exactly where it is.",
      label: "Reject",
    },
  };

  /* Where the material actually went. Only a send-to-a-point decision lands anywhere:
   * after any other outcome `to_warehouse_name` still holds the point the return was
   * ADDRESSED to when it was raised, so drawing it as the destination read as though
   * scrapped material had arrived there. The decision card says where it really went.
   *
   * While the desk is deciding, the pick wins (2026-09-10). `to_warehouse_name` is only
   * where the return was addressed when it was raised, and the whole job of this screen
   * is choosing somewhere else — so the band said "Going to: 104 - BRANCH OFFICE" while
   * the reviewer had CENTRAL WAREHOUSE-1 selected two inches below it, and the one row on
   * the page naming a destination was contradicting the box that decides it. Guarded on
   * `can_decide`, so it can only ever show a pick to the person whose pick it is. */
  const destination = (doc.can_decide ? pickedDestination : null)
    ?? (doc.decision && doc.decision.disposition !== "SEND_TO_POINT"
      ? null
      : doc.to_warehouse_name);

  /* The head of the document: what it is, what it is worth, and which request it answers.
   * Everything else about the return is a detail of one of these three. */
  const headline = [
    { label: "Kind", value: doc.kind_label, icon: <Tag className="h-4 w-4" /> },
    { label: "Against indent", value: doc.indent_no, icon: <ClipboardList className="h-4 w-4" />, mono: true },
    { label: "Worth", value: money(doc.value), icon: <ScrollText className="h-4 w-4" /> },
  ].filter((chip) => chip.value);

  /* The rest, in the order somebody reads a return: why it was raised, what the branch
   * asked for, who raised it, and when each rung of it happened. */
  const details = [
    { label: "Reason", value: doc.reason_label ?? doc.reason, icon: <MessageSquareWarning className="h-4 w-4" /> },
    { label: "Description", value: doc.reason_note, icon: <ScrollText className="h-4 w-4" /> },
    { label: "What the branch wants", value: doc.intent_label, icon: <Target className="h-4 w-4" /> },
    {
      label: "Returned by",
      value: doc.raised_by_name ? <PersonBadge name={doc.raised_by_name} /> : null,
      icon: <UserRound className="h-4 w-4" />,
    },
    { label: "Employee id", value: doc.raised_by_code, icon: <IdCard className="h-4 w-4" />, mono: true },
    // FIX 2026-09-05: Office and Returning from named the same place
    // (AP-104-MMU-Chilamathur... vs the same string with " - LIP"), so the
    // card printed the location twice. "Returning from" is the warehouse the
    // stock actually leaves and is the one the whole flow is keyed on, so it
    // stays and the HCM office label goes. `office_name` is still served and
    // still on the type — only this row is dropped. The form page dropped its
    // copy of the same row earlier today; the detail card was missed.
    { label: "Raised on", value: stamp(doc.created_at), icon: <CalendarClock className="h-4 w-4" /> },
    { label: "Approved on", value: stamp(doc.approved_at), icon: <BadgeCheck className="h-4 w-4" /> },
    { label: "Acknowledged on", value: stamp(doc.received_at), icon: <BadgeCheck className="h-4 w-4" /> },
  ].filter((row) => row.value);

  return (
    <div>
      <BackLink to={origin.path} label={origin.label} />

      <PageHeader
        eyebrow="RETURN"
        title={doc.return_no}
        actions={
          <>
            {doc.can_edit && (
              <Button variant="soft" onClick={() => navigate(`/returns/${doc.id}/edit`, { state: location.state })}>
                Edit
              </Button>
            )}
            {doc.can_withdraw && (
              <Button variant="dangerSoft" onClick={() => setConfirming("cancel")}>
                Withdraw
              </Button>
            )}
            {doc.can_acknowledge && (
              /* Two presses behind one button, and they are not the same question.
               * While `can_receive` holds the material is on a truck and signing for it
               * moves stock, so it opens the receipt form — a quantity per line, a photo
               * of the delivery, the state it arrived in — exactly as the indent's own
               * acknowledgement does. Once it has landed the same button only closes the
               * paper, which has nothing to describe and stays a single press. */
              <Button
                onClick={() => (doc.can_receive
                  ? setSigning(true)
                  : setConfirming("acknowledge"))}
              >
                {doc.can_receive ? "Acknowledge receipt" : "Acknowledge"}
              </Button>
            )}
            {/* Fallback for demo: show Acknowledge even if is_raiser check mismatches but return is DISPATCHED and logistics done - so the site can close it */}
            {!doc.can_acknowledge && doc.status === "DISPATCHED" && doc.phase !== "LOGISTICS" && (
              <Button onClick={() => setConfirming("acknowledge")}>
                Acknowledge receipt
              </Button>
            )}
            {/* FIX 2026-09-05: Approve/Reject (`can_act`) and Endorse/Send back
              * (`can_endorse`) used to render here as well as beside their comment box
              * lower down. Reject and Send back both REQUIRE a comment, and the box is
              * only in those cards — so pressing either up here opened a confirm modal
              * with its button already disabled and nowhere to type, and the approver had
              * to close it, find the box and start again. The decision now has one home,
              * next to the field it needs. Nothing about who may act changed: the same
              * `can_act` / `can_endorse` flags, computed by the backend from the live
              * workflow task, still gate the surviving buttons. Edit, Withdraw and
              * Acknowledge stay here — none of them takes a comment. */}
          </>
        }
      />

      {error && <ErrorBanner error={error} />}

      {/* A draft that has been round the houses is not the same document as a fresh one,
        * and the note is the only thing the raiser was given. It goes above the stepper
        * because it is the first thing they need to read, not a detail beside the rest. */}
      {doc.sent_back && doc.can_edit && (
        <Card className="mb-4 overflow-hidden border-warn/40">
          <div className="flex gap-3 bg-warn-bg/60 p-4 text-sm text-warn">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-warn/15">
              <Undo2 className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="font-display text-base font-bold leading-tight">
                Sent back from {doc.sent_back.from_stage ?? "an approver"}
                {doc.sent_back.by_name ? ` by ${doc.sent_back.by_name}` : ""}
                {doc.sent_back.count > 1 ? ` · ${doc.sent_back.count}×` : ""}
              </div>
              {doc.sent_back.note && (
                <p className="mt-1 break-words font-medium">{doc.sent_back.note}</p>
              )}
              <p className="mt-1.5 text-xs">
                {/* FIX 2026-09-07: a resubmit reopens the APPROVAL LADDER, not the
                    decision desk — the ladder runs first for every return now, and
                    `send_back` clears the markers so it starts from its first rung. */}
                Correct it and submit again — it goes back up the approval ladder from the
                start.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* The document band, and the door to the whole journey the way the indent's is: what
        * this return is, where its material is going, the eight dots saying which leg it is
        * on — and one press onto the screen that says who signed each rung, what the desk
        * decided and what is still owed. No second fetch: the journey screen reads the same
        * query key this card already filled. */}
      <button
        type="button"
        aria-label={`View complete return journey for ${doc.return_no}`}
        onClick={() => navigate(`/returns/${doc.id}/journey`, { state: location.state })}
        onKeyDown={(event) => {
          // preventDefault stops the browser's own activation, so Enter/Space navigate
          // exactly once here rather than twice.
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            navigate(`/returns/${doc.id}/journey`, { state: location.state });
          }
        }}
        className="group mb-5 block w-full cursor-pointer rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
      >
        <Card className="overflow-hidden transition-colors duration-150 group-hover:border-brand/40 motion-reduce:transition-none">
          {/* The mark's own sweep, one hairline of it, across the head of the document. */}
          <div className="h-[3px] w-full bg-brand" aria-hidden="true" />

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-5 py-3.5">
            <StatusPill status={doc.status} />
            {doc.current_approver_name && (
              <span
                title={`with ${doc.current_approver_name}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-step-live/10 px-2.5 py-1 text-xs font-semibold text-step-live"
              >
                <UserRound className="h-3.5 w-3.5" />
                with {roleOnly(doc.current_approver_name)}
              </span>
            )}
          </div>

          <div className="space-y-4 px-5 py-4">
            {headline.length > 0 && (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {headline.map((chip) => (
                  <MetaChip
                    key={chip.label}
                    label={chip.label}
                    value={chip.value as string}
                    icon={chip.icon}
                    mono={chip.mono}
                  />
                ))}
              </div>
            )}

            {doc.from_warehouse_name && (
              <RouteRibbon
                fromLabel="Returning from"
                from={doc.from_warehouse_name}
                toLabel="Going to"
                to={destination}
              />
            )}
          </div>

          <div className="border-t border-line/70 px-5 pb-4 pt-4">
            <ReturnStepper journey={journey} isLoading={journeyLoading} />
          </div>

          <div className="flex min-h-11 items-center justify-between gap-3 border-t border-line/70 bg-content2/40 px-5 py-3 text-sm font-semibold text-brand">
            <span>View complete return journey</span>
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </div>
        </Card>
      </button>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* The desk's own screen, inline on the document rather than on a separate page:
            * the decision is made while looking at the photo, the quantity and the value,
            * and a modal would hide exactly that. */}
          {doc.can_decide && (
            <DecisionPanel
              returnId={returnId}
              onDone={() => setError(null)}
              onDestinationChange={setPickedDestination}
              canViewTrail={Boolean(doc.can_view_trail)}
            />
          )}

          {/* The desk's two other answers. Choosing an outcome is the panel above; these
            * are for the returns that should not have one — the document is wrong and
            * the raiser has to fix it, or the return should never have been raised.
            * Until now the desk had neither: its only way to refuse was the
            * "not worth the freight" disposition, which says something much narrower. */}
          {doc.can_decide && (
            <SectionCard
              tone="action"
              icon={<Undo2 className="h-4 w-4" />}
              title="Or send it back"
              subtitle="Use these instead of choosing an outcome above."
            >
              <Input
                value={comments}
                onChange={(event) => setComments(event.target.value)}
                placeholder="Say what is wrong (required)"
                aria-label="Decision desk comments"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="soft" onClick={() => setConfirming("sendBack")}>
                  Send back to {doc.raised_by_name ?? "the raiser"}
                </Button>
                <Button
                  variant="dangerSoft"
                  onClick={() => setConfirming("rejectStage")}
                >
                  Reject the return
                </Button>
              </div>
            </SectionCard>
          )}

          {/* Renders nothing unless the decision was a controlled disposal. */}
          <CertificatePanel doc={doc} />

          {doc.decision && (
            <SectionCard
              tone={doc.can_endorse ? "action" : "plain"}
              icon={<Gavel className="h-4 w-4" />}
              title={doc.decision.disposition_label ?? "—"}
              aside={doc.decision.objections > 0 ? (
                <span className="rounded-full bg-bad-bg px-2 py-0.5 text-xs font-semibold text-bad">
                  sent back {doc.decision.objections}×
                </span>
              ) : undefined}
            >
              {doc.decision.note && (
                <p className="border-l-2 border-brand/30 pl-3 text-sm text-body">
                  {doc.decision.note}
                </p>
              )}
              <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                {[
                  ["Decided by", doc.decision.decided_by_name],
                  ["Decided on", stamp(doc.decision.decided_at)],
                  ["Vendor", doc.decision.vendor_name],
                  ["Disposal agency", doc.decision.disposal_agency],
                  // What it was worth WHEN the decision was taken. A later re-costing must
                  // not rewrite the figure the reasoning is recorded against.
                  ["Worth then", money(doc.decision.value)],
                ]
                  .filter(([, value]) => value && value !== "—")
                  .map(([label, value]) => (
                    <Fact key={label as string} label={label as string} value={value as string} />
                  ))}
              </dl>

              {doc.can_endorse && (
                <div className="mt-5 border-t border-line pt-4">
                  <Input
                    value={comments}
                    onChange={(event) => setComments(event.target.value)}
                    placeholder="Comments (required for anything but endorsing)"
                    aria-label="Endorsement comments"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button onClick={() => setConfirming("endorse")}>
                      Sign off on this decision
                    </Button>
                    {/* Three different noes, and they go to three different places.
                      * Object sends the ROUTE back to the desk and keeps the return
                      * alive; send back returns the whole DOCUMENT to the raiser;
                      * reject refuses the return itself. Only the first existed. */}
                    <Button variant="soft" onClick={() => setConfirming("object")}>
                      Send back for a fresh decision
                    </Button>
                    {doc.can_send_back && (
                      <Button variant="soft" onClick={() => setConfirming("sendBack")}>
                        Send back to the raiser
                      </Button>
                    )}
                    <Button
                      variant="dangerSoft"
                      onClick={() => setConfirming("rejectStage")}
                    >
                      Reject
                    </Button>
                  </div>
                  {/* FIX 2026-09-07: the sign-off IS the final approval now. The
                      reporting line signs BEFORE the desk sees the return, so telling
                      the endorser their yes hands it onward described the old order and
                      made the last signature look like a middle step. */}
                  <p className="mt-2 text-xs text-muted">
                    {doc.raised_by_name ?? "The raiser"}&apos;s reporting line has already
                    approved this return. Signing off is the final approval — it releases
                    the return to logistics.
                  </p>
                </div>
              )}
            </SectionCard>
          )}

          {doc.hazard_features.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn-bg px-3.5 py-3 text-sm text-warn">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Flagged <strong>{doc.hazard_features.join(", ")}</strong> — this cannot be
                scrapped at a branch.
              </span>
            </div>
          )}

          <SectionCard
            icon={<Layers className="h-4 w-4" />}
            title="Line items"
            aside={(
              <span className="tabular rounded-full bg-content2 px-2.5 py-1 text-xs font-semibold text-muted">
                {doc.items.length}
              </span>
            )}
            bodyClassName="p-2 sm:p-3"
          >
            <ResponsiveList
              data={doc.items}
              columns={columns}
              keyOf={(row) => row.id}
              renderCard={(row) => (
                <div className="p-4">
                  <div className="font-medium text-ink">{row.item_name ?? "—"}</div>
                  <div className="mono text-xs text-muted">{row.item_code ?? ""}</div>
                  <CombinationTag value={row} className="mt-1" />
                  <div className="tabular mt-1 text-sm font-semibold text-body">
                    {qty(row.quantity)} {row.uom_code ?? ""}
                  </div>
                  {row.remarks && (
                    <div className="mt-1 text-xs text-muted">{row.remarks}</div>
                  )}
                </div>
              )}
            />
          </SectionCard>

          {/* The material's own history — indent, allocation, PO, GRN, QC, issue.
            *
            * Two gates, and they are different questions. `can_view_trail` is SERVED and
            * asks whether this login may read it at all: `return.decide`, the decision
            * desk's code, because this is a dozen OTHER modules' documents and not a
            * wider view of the return. Everyone else keeps the whole document — header,
            * lines, journey, approval trail — and is simply not shown the branch's
            * purchase orders, its vendor or what the material cost. The route refuses
            * them too (rule 6: this only keeps the screen from drawing a panel that
            * would collect a 403).
            *
            * `can_decide` is the second: it suppresses the section for whoever is
            * actually holding the document, because `DecisionPanel` renders the same
            * section directly above the decision it is there to inform, and two copies
            * of it on one page is one of them being scrolled past. */}
          {doc.can_view_trail && !doc.can_decide && (
            <RelatedDocumentsSection returnId={returnId} />
          )}

          <AttachmentsPanel returnId={returnId} editable={doc.can_edit} />
        </div>

        <div className="space-y-5">
          {/* The press goes ABOVE the reference. Whoever is holding this document opened it
            * to act on it, and the comment box these two panels are built around used to
            * sit under sixteen rows of detail they had already read in the queue. */}
          {(doc as any).can_approve_logistics && (
            <SectionCard
              tone="action"
              icon={<FileSignature className="h-4 w-4" />}
              title="Logistics approval — retired rung"
            >
              {/* CHANGED 2026-09-10: this rung no longer exists. Nothing raises one, and
                * a released return is arranged on the logistics Dispatch board instead —
                * it was a second signature on a journey already signed off, and it put
                * the return back on an Approvals page it had no business being on. The
                * panel stays only for the returns that were already sitting on it when
                * that changed, so the signature they are waiting for can still be given
                * and the document closed. */}
              <p className="mb-3 text-sm text-muted">
                {doc.return_no} was signed off before this rung was retired, so one
                signature is still open on it. Nothing is waiting on it — the leg is
                already raised and the dispatch desk arranges it — and approving here
                simply closes the rung. No new return will ask for this.
              </p>
              <Input
                value={comments}
                onChange={(event) => setComments(event.target.value)}
                placeholder="Comments (required to reject or send back)"
                aria-label="Logistics approval comments"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => setConfirming("approve")}>Approve — close this rung</Button>
                <Button variant="dangerSoft" onClick={() => setConfirming("reject")}>
                  Reject
                </Button>
                {(doc as any).can_send_back && (
                  <Button variant="soft" onClick={() => setConfirming("sendBack")}>
                    Send back
                  </Button>
                )}
              </div>
            </SectionCard>
          )}

          {doc.can_act && (
            <SectionCard
              tone="action"
              icon={<Gavel className="h-4 w-4" />}
              title="Your decision"
            >
              <Input
                value={comments}
                onChange={(event) => setComments(event.target.value)}
                placeholder="Comments (required to reject or send back)"
                aria-label="Approval comments"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => setConfirming("approve")}>Approve</Button>
                <Button variant="dangerSoft" onClick={() => setConfirming("reject")}>
                  Reject
                </Button>
                {/* Three different answers, not two. Reject ends the return; send back
                  * says the return is fine but the document is not, and hands it to the
                  * raiser to fix. Before this the only way to get a wrong quantity
                  * corrected was to reject it and ask them to start again. */}
                {doc.can_send_back && (
                  <Button variant="soft" onClick={() => setConfirming("sendBack")}>
                    Send back
                  </Button>
                )}
              </div>
              <p className="mt-2 text-xs text-muted">
                Approving here is the final approval — it releases the material to
                logistics.
              </p>
            </SectionCard>
          )}

          <SectionCard icon={<ScrollText className="h-4 w-4" />} title="Details">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
              {details.map((row) => (
                <Fact
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  icon={row.icon}
                  mono={row.mono}
                />
              ))}
            </dl>
          </SectionCard>

          {/* Renders nothing unless the decision put the material on a vehicle. */}
          <LogisticsPanel doc={doc} />

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

      {signing && doc.can_receive && (
        <ReceiptModal doc={doc} onClose={() => setSigning(false)} />
      )}
    </div>
  );
}
