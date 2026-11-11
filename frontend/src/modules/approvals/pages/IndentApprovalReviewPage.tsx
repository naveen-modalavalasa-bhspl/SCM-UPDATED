import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle, ArrowLeft, Building2, CalendarDays, Check, CheckCircle2, ClipboardCheck,
  Flag, History, Info, MessageSquare, PackageCheck, RotateCcw, ShieldAlert, TriangleAlert, User, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card, ConfirmModal, PageHeader, StatusPill } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import { QuantityInput } from "@/shared/components/QuantityInput";
import { approvalsApi } from "../api";
import { ReturnTargetSelect, targetLabel } from "@/modules/indents/components/ReturnTargetSelect";
import { IssueFromStockPanel } from "../components/IssueFromStockPanel";
import { StrSourcePanel } from "../components/StrSourcePanel";
import { HistoryTimeline } from "../components/HistoryTimeline";
import {
  allowedRange, approvalCeiling, formatQuantity, isRejectedLine, lineDecimals, lineMinimum,
  quantityError, quantityValue, signedTotal, wasReducedBelow,
} from "../quantityRules";
import { strDecision } from "../strDecision";
import { isIndentModuleQuery } from "@/modules/indents/api";
import { displayUom } from "@/modules/indents/displayFormat";
import { alerts } from "@/modules/alerts";
import type { ApprovalIndentLine } from "../types";
import { TONE_APPROVE, TONE_REJECT } from "@/shared/components/tones";

type Decision = "approve" | "reject" | "return" | null;
const CHECKS = [
  "I checked every requested item and quantity.",
  "I checked the business need and priority.",
  "I checked the approved quantities shown below.",
];

/** What a level below already allocated on this line, under the item's name. */
function ServedNote({ line, unit }: { line: ApprovalIndentLine; unit: string }) {
  if (!line.served_quantity) return null;
  return (
    <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 py-0.5 text-[11px] font-semibold text-ok">
      <PackageCheck className="h-3 w-3" aria-hidden />
      {formatQuantity(line.served_quantity)} {unit} allocated
    </p>
  );
}

/** Stands in for the quantity box when nothing is left on a line to decide. */
function FullyServed() {
  return (
    <p className="flex min-h-11 items-center justify-end gap-1.5 text-sm font-semibold text-ok">
      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> Fully allocated
    </p>
  );
}

/* ---------------------------------------------------------------------------
 * Local presentation pieces.
 *
 * The screen is one long act — read the request, set the numbers, confirm, sign —
 * and it used to read as one long wall: three paragraphs of guidance, a 980px table,
 * a checklist, a comment box and a history list all stacked at the same weight, with
 * the decision buttons stranded at the bottom of the scroll.
 *
 * These give each stage of that act a surface of its own: a titled section head so a
 * card announces what it is for, a fact cell for the document's identity, and a
 * quantity field that is the same control in the table and on a phone. Everything
 * with a shared primitive behind it — Button, Card, StatusPill, ConfirmModal — still
 * comes from `@/shared/components` untouched.
 * ------------------------------------------------------------------------- */

/** A card's own header: what this part of the review is, said once, at the top. */
function SectionHead({
  icon: Icon, title, hint, right,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-050 text-brand">
          <Icon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-[15px] font-bold leading-tight text-ink">{title}</h2>
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

/** One fact about the document, in the strip under the title. */
function Fact({
  icon: Icon, label, children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-content2 text-muted">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</dt>
        <dd className="truncate text-sm font-semibold text-ink">{children}</dd>
      </div>
    </div>
  );
}

/** A tinted note. Guidance an approver needs at the moment they type, not a paragraph
 *  of prose above the numbers — so it is boxed, titled and kept to two lines. */
function Note({
  tone, icon: Icon, title, children,
}: {
  tone: "info" | "warn";
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  const skin = tone === "warn"
    ? "border-warn/30 bg-warn-bg text-warn"
    : "border-line bg-content2 text-body";
  return (
    <div className={`flex gap-2.5 rounded-xl border p-3 ${skin}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 text-xs leading-relaxed">
        <strong className="block font-semibold">{title}</strong>
        <span className={tone === "warn" ? "" : "text-muted"}>{children}</span>
      </div>
    </div>
  );
}

/**
 * The approved quantity for one line — the only control on the screen that changes
 * what is signed, so it is the same control in the table and in the phone card.
 *
 * The unit is a SIBLING of the input, never an overlay on top of it. Absolutely
 * positioned it sat over the field's own text: the number is right-aligned and grew
 * straight under a unit the padding was not wide enough to clear, so typing into
 * "UOM-BOX" was unreadable. As a flex row the input takes the space that is left and
 * the two can never collide, whatever the unit is called. The border and the focus
 * ring live on the wrapper, so it still reads and behaves as one field.
 */
function QuantityField({
  line, unit, value, error, isZero, onChange,
}: {
  line: ApprovalIndentLine;
  unit: string;
  value: string;
  error: string | null;
  isZero?: boolean;
  onChange: (raw: string) => void;
}) {
  return (
    <div className="w-full">
      <div
        className={`flex h-11 items-center rounded-xl border bg-content1 pr-3 transition focus-within:ring-2 ${
          error
            ? "border-bad bg-bad-bg/40 focus-within:ring-bad/30"
            : isZero
              ? "border-danger/40 bg-danger/5 focus-within:border-danger focus-within:ring-danger/25"
              : "border-line focus-within:border-brand focus-within:ring-brand/25"
        }`}
      >
        <QuantityInput
          decimals={lineDecimals(line)}
          min={lineMinimum(line)}
          max={approvalCeiling(line)}
          data-uom={line.uom_code ?? ""}
          aria-label={`Approved quantity for ${line.item_name ?? line.id}`}
          aria-invalid={Boolean(error)}
          aria-describedby={`qty-help-${line.id}`}
          value={value}
          onChange={onChange}
          className={`h-full min-w-0 flex-1 rounded-xl bg-transparent px-3 text-right font-semibold tabular-nums outline-none ${
            isZero ? "text-danger" : "text-ink"
          }`}
        />
        <span className="shrink-0 whitespace-nowrap text-xs font-medium text-muted">{unit}</span>
      </div>
      {/* The range is on screen before anything goes wrong, and repeated inside the
          error when it does — the approver never has to work out the cap. */}
      <p
        id={`qty-help-${line.id}`}
        role={error ? "alert" : undefined}
        className={`mt-1.5 flex items-start gap-1.5 text-left text-[11px] leading-snug ${
          error ? "font-medium text-bad" : isZero ? "font-medium text-danger" : "text-muted"
        }`}
      >
        {error && <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />}
        {isZero && !error && <X className="mt-px h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />}
        <span>
          {error ?? (isZero ? `Item rejected (0 ${unit})` : `You can approve ${allowedRange(line)}.`)}
        </span>
      </p>
    </div>
  );
}

/** The difference this approver is making to a line, as a chip rather than a number
 *  in a column of numbers: "no change" should never look like a decision. */
function DifferenceChip({ difference, unit, isZero }: { difference: number | null; unit: string; isZero?: boolean }) {
  if (difference == null) return <span className="text-xs text-muted">—</span>;
  if (isZero) {
    return (
      <span className="inline-flex min-h-7 items-center gap-1 rounded-full bg-danger/10 px-2.5 text-xs font-semibold text-danger">
        <X className="h-3 w-3" /> Rejected
      </span>
    );
  }
  if (difference === 0) {
    return (
      <span className="inline-flex min-h-7 items-center rounded-full bg-content2 px-2.5 text-xs font-semibold text-muted">
        No change
      </span>
    );
  }
  return (
    <span className="inline-flex min-h-7 items-center gap-1 rounded-full bg-warn-bg px-2.5 text-xs font-semibold tabular-nums text-warn">
      {formatQuantity(difference)} {unit}
    </span>
  );
}

/** Shape of the screen while it loads, rather than a bare line of text: an approver
 *  who lands here on a slow connection should see the page they are about to read. */
function ReviewSkeleton() {
  return (
    <div role="status" className="space-y-4">
      <span className="sr-only">Loading approval details…</span>
      <div className="h-9 w-56 animate-pulse rounded-xl bg-content2" />
      <Card className="p-4 sm:p-5">
        {/* mobile-ok — four placeholder blocks stay legible when they stack */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((cell) => (
            <div key={cell} className="h-11 animate-pulse rounded-xl bg-content2" />
          ))}
        </div>
      </Card>
      <Card className="space-y-3 p-4 sm:p-5">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="h-12 animate-pulse rounded-xl bg-content2" />
        ))}
      </Card>
    </div>
  );
}

/** Normal page-based review. This is deliberately not a drawer or overlay. */
export function IndentApprovalReviewPage({ indentId: suppliedIndentId }: { indentId?: number } = {}) {
  const { id } = useParams();
  const indentId = suppliedIndentId ?? Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const isAdmin = can("admin.workflow.manage") || Boolean(me?.roles.includes("ADMIN")) || Boolean(me?.roles.includes("SUPERUSER"));
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [comments, setComments] = useState("");
  const [reason, setReason] = useState("");
  const [checks, setChecks] = useState([false, false, false]);
  const [confirming, setConfirming] = useState<Decision>(null);
  // Which earlier step a return goes to. Null means "the default": the step just below.
  const [targetSequence, setTargetSequence] = useState<number | null>(null);
  // Closed to start: opening it is what fetches the approver's own stock, so the
  // review screen costs one request until they ask to serve.
  const [serving, setServing] = useState(false);

  const indent = useQuery({
    queryKey: ["approvals", "indent", indentId],
    queryFn: () => approvalsApi.getIndent(indentId),
    enabled: Number.isFinite(indentId) && indentId > 0,
  });
  // Fetched only once the approver opens the Return dialog.
  const returnTargets = useQuery({
    queryKey: ["approvals", "return-targets", indentId],
    queryFn: () => approvalsApi.returnTargets(indentId),
    enabled: confirming === "return" && Number.isFinite(indentId) && indentId > 0,
  });
  const targetOptions = returnTargets.data ?? [];
  const defaultTarget = targetOptions.find((target) => target.is_default)?.sequence ?? null;
  const chosenTarget = targetSequence ?? defaultTarget;
  const chosenOption = targetOptions.find((target) => target.sequence === chosenTarget);
  const availability = useQuery({
    queryKey: ["approvals", "availability", indentId],
    queryFn: () => approvalsApi.indentAvailability(indentId),
    enabled: Number.isFinite(indentId) && indentId > 0,
  });
  // An STR's source verdict (2026-11-04). The panel reads the same cached query; the
  // page needs it only to word the footer and to ask a forwarding approver why.
  const isStr = indent.data?.indent_type === "STR";
  const strReview = useQuery({
    queryKey: ["approvals", "str-source", indentId],
    queryFn: () => approvalsApi.strSource(indentId),
    enabled: isStr && Number.isFinite(indentId) && indentId > 0,
  });
  // What approving means here, worded once for the panel, the button and the dialog.
  const decision = strDecision(isStr ? strReview.data : undefined);
  const history = useQuery({
    queryKey: ["approvals", "history", "INDENT", indentId],
    queryFn: () => approvalsApi.history("INDENT", indentId),
    enabled: Number.isFinite(indentId) && indentId > 0,
  });

  // Active items to review: lines already cut to zero or excluded by an earlier
  // approver are dropped and not forwarded to this level for approval.
  const reviewItems = useMemo(() => {
    const availableByLine = new Map(
      (availability.data?.items ?? []).map((line) => [line.line_id, line]),
    );
    return (indent.data?.items ?? [])
      .filter((line) => !line.is_excluded && approvalCeiling(line) > 0)
      .map((line) => {
        const available = availableByLine.get(line.id);
        if (available === undefined) return line;
        const outstanding = Math.max(0, Number(available.remainder));
        const served = Number(available.allocated_quantity) + Number(available.committed_quantity);
        return {
          ...line,
          approved_quantity: Math.min(line.approved_quantity, outstanding),
          max_quantity: Math.min(line.max_quantity, outstanding),
          served_quantity: served,
          fully_served: outstanding <= 0 && served > 0,
        };
      });
  }, [availability.data, indent.data]);

  useEffect(() => {
    if (!indent.data) return;
    // Prefilled with the ceiling, so "approve as asked" is the no-edit path and the
    // approver only touches the lines they mean to cut.
    setQuantities(Object.fromEntries(
      reviewItems.map((line) => [line.id, formatQuantity(approvalCeiling(line))]),
    ));
  }, [indent.data, reviewItems]);

  const errorByLine = useMemo(() => Object.fromEntries(
    reviewItems.map((line) => [line.id, quantityError(line, quantities[line.id])]),
  ), [quantities, reviewItems]);
  const invalidCount = Object.values(errorByLine).filter(Boolean).length;
  const invalidQuantity = invalidCount > 0;
  const anyReducedBelow = reviewItems.some(wasReducedBelow);
  const checksDone = checks.every(Boolean);
  const checkedCount = checks.filter(Boolean).length;
  // Display only: how many lines this approver is actually cutting. The count is the
  // one thing a reviewer wants confirmed before signing, and counting the rows by eye
  // is exactly what a wide table makes hard.
  const cutCount = useMemo(() => reviewItems.filter((line) => (
    !errorByLine[line.id] && quantityValue(quantities[line.id]) < approvalCeiling(line)
  )).length, [errorByLine, quantities, reviewItems]);

  const zeroLinesCount = useMemo(() => reviewItems.filter((line) => (
    !errorByLine[line.id] && isRejectedLine(line, quantities[line.id])
  )).length, [errorByLine, quantities, reviewItems]);

  const allZero = reviewItems.length > 0 && zeroLinesCount === reviewItems.length;

  // Every keystroke is kept; the message under the field does the correcting. Refusing
  // the key instead leaves the approver staring at a box that will not take their 16.
  const setQuantity = (line: { id: number }, raw: string) => {
    setQuantities((current) => ({ ...current, [line.id]: raw }));
  };

  /** Announced before the queries are dropped, so the number is still readable. */
  const announce = (decision: "approve" | "reject" | "return") => {
    const number = indent.data?.indent_no ?? "The indent";
    const raiser = indent.data?.requested_by_name || "the raiser";
    if (decision === "approve") {
      if (allZero) void alerts.success("indent.rejected", { number, raiser });
      else void alerts.success("indent.approved", { number });
    }
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
      reviewItems.map((line) => ({
        line_id: line.id,
        approved_quantity: signedTotal(line, quantities[line.id]),
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
    mutationFn: () => approvalsApi.returnIndent(
      indentId, reason.trim(), chosenTarget === null ? undefined : chosenTarget),
    onSuccess: finish("return"),
  });
  const busy = approve.isPending || reject.isPending || returnForCorrection.isPending;
  const actionError = approve.error || reject.error || returnForCorrection.error;
  const canReturnForCorrection = Boolean(indent.data?.can_return_for_correction);

  const confirm = () => {
    if ((confirming === "reject" || confirming === "return") && !reason.trim()) return;
    // Forwarding an STR whose source is not yours says why, for the next rung.
    if (confirming === "approve" && !allZero && (!decision.canApprove || (decision.needsReason && !comments.trim()))) return;
    if (confirming === "return" && !canReturnForCorrection) return;
    if (confirming === "return" && returnTargets.isLoading) return;
    if (busy) return;
    if (confirming === "approve") approve.mutate();
    if (confirming === "reject") reject.mutate();
    if (confirming === "return") returnForCorrection.mutate();
  };

  if (indent.isLoading || availability.isLoading) return <ReviewSkeleton />;
  // A document that has left approval is not an error, it is an outcome — somebody
  // signed it, or this approver served it and came back on the browser's back button.
  // Painting it red reads as "your action failed" over an act that succeeded.
  if (indent.error) {
    const message = (indent.error as Error).message;
    const movedOn = /not awaiting approval/i.test(message);
    return (
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <span
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
              movedOn ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"
            }`}
          >
            {movedOn ? <CheckCircle2 className="h-5 w-5" /> : <TriangleAlert className="h-5 w-5" />}
          </span>
          <div className="min-w-0">
            <p className={`font-display text-base font-bold ${movedOn ? "text-ink" : "text-bad"}`}>
              {movedOn ? "This indent has already moved on" : "This approval could not be opened"}
            </p>
            <p className="mt-1 text-sm text-muted">
              {movedOn ? "It is no longer waiting on you." : message}
            </p>
            {movedOn && <p className="mt-1 text-xs text-muted">{message}</p>}
            <div className="mt-3">
              <Button variant="subtle" onClick={() => nav("/approvals")}>
                <ArrowLeft className="h-4 w-4" /> Back to approvals
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }
  // A cached review can outlive the workflow task when another tab or approver moves
  // the indent on. Never leave live decision buttons over a completed document.
  if (indent.data && indent.data.status !== "PENDING_APPROVAL") {
    return (
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ok-bg text-ok">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-base font-bold text-ink">This indent has already moved on</p>
            <p className="mt-1 text-sm text-muted">It is now {indent.data.status.replace(/_/g, " ").toLowerCase()} and is no longer awaiting approval.</p>
            <Button className="mt-3" variant="subtle" onClick={() => nav("/approvals")}>
              <ArrowLeft className="h-4 w-4" /> Back to approvals
            </Button>
          </div>
        </div>
      </Card>
    );
  }
  if (!indent.data) return <p className="p-6 text-muted">Approval not found.</p>;

  const historyRows = history.data ?? [];

  const isOverride = Boolean(
    isAdmin && indent.data?.current_approver_name && indent.data?.current_approver_name !== me?.employee?.name
  );

  return <>
    <Button variant="ghost" onClick={() => nav("/approvals")}>
      <ArrowLeft className="h-4 w-4" /> Back to approvals
    </Button>
    <PageHeader
      eyebrow={isOverride ? "Approval review · Admin Override" : "Approval review"}
      title={indent.data.indent_no}
      actions={<>
        <StatusPill status={indent.data.current_stage_name ?? indent.data.status} />
        {/* Next to the status, and deliberately NOT the primary button: serving from
            your own stock is an action on the whole document, like approving, but the
            decision this screen exists for is the one in the bar at the foot of it.
            An STR serves through its source card instead — one door, not two. */}
        {!isStr && (
          <Button variant="subtle" onClick={() => setServing((open) => !open)}>
            <PackageCheck className="h-4 w-4" /> {serving ? "Hide own stock" : "Serve from own stock"}
          </Button>
        )}
      </>}
    />

    <div className="space-y-4 pb-4">
      {isOverride && (
        <div className="flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-amber-900 dark:text-amber-200">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/20 text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <div className="min-w-0 text-xs leading-relaxed">
            <strong className="block text-sm font-semibold">Admin Workflow Override Mode</strong>
            <span>
              This indent is currently pending with <strong>{indent.data.current_approver_name}</strong>. As an administrator, your decision will advance the workflow and be officially recorded as an Admin Override in the audit log.
            </span>
          </div>
        </div>
      )}

      {/* Who is asking, and for what — the context the numbers below are judged
          against, on one strip instead of a paragraph of definition lists. */}
      <Card className="p-4 sm:p-5">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Fact icon={User} label="Requested by">{indent.data.requested_by_name ?? "—"}</Fact>
          <Fact icon={Building2} label="Department">{indent.data.department_name ?? "—"}</Fact>
          <Fact icon={CalendarDays} label="Raised on">{fmtDate(indent.data.created_at)}</Fact>
          {/* When the goods are needed decides whether this is urgent, so it is read
              beside the raise date. Nothing behind it is drawn as nothing — the raise
              date under this label would say the goods were wanted the day it was asked. */}
          <Fact icon={CalendarDays} label="Required date">
            {indent.data.required_date ? fmtDate(indent.data.required_date) : "—"}
          </Fact>
          <Fact icon={Flag} label="Priority">
            <StatusPill status={indent.data.priority} />
          </Fact>
        </dl>
      </Card>

      {isStr && (
        <StrSourcePanel
          indentId={indentId}
          lines={Object.fromEntries(reviewItems.map((line) => [
            line.id, { name: line.item_name ?? line.item_code ?? `Line ${line.id}`, unit: displayUom(line.uom_code) },
          ]))}
          signed={reviewItems.map((line) => ({
            line_id: line.id, approved_quantity: signedTotal(line, quantities[line.id]),
          }))}
          ready={!invalidQuantity && !allZero && checksDone}
          blocker={invalidQuantity
            ? "Correct the highlighted quantities below first."
            : allZero ? "Every item is at 0 — this request can only be rejected."
              : !checksDone ? "Confirm the checklist below to enable these buttons." : null}
          onForward={() => setConfirming("approve")}
          onForwarded={finish("approve")}
          onAllocated={(result) => {
            if (result.closed) finish("approve")();
            else {
              qc.invalidateQueries({ queryKey: ["approvals"], refetchType: "all" });
              qc.invalidateQueries({ predicate: isIndentModuleQuery, refetchType: "all" });
            }
          }}
        />
      )}

      {/* Serve-from-own-stock sits above the decision, not after it: an approver who
          holds the goods should give them and let only the remainder climb. Behind a
          button because most approvals are a straight pass-up — the panel opens for
          the approver who means to give stock, and the quantities stay in view for
          everyone else. */}
      {serving && <section aria-label="Serve from your own stock">
        <h2 className="mb-2 flex items-center gap-2 font-display text-[15px] font-bold text-ink">
          <PackageCheck className="h-4 w-4 text-brand" /> Serve from your own stock
        </h2>
        {/* Serving every line IS the decision: the ladder ends there, so the screen
            leaves exactly as it does after Approve rather than refetching a document
            that is no longer awaiting anyone. */}
        <IssueFromStockPanel indentId={indentId} onClosed={finish("approve")} />
      </section>}

      <Card>
        <SectionHead
          icon={ClipboardCheck}
          title="Items and quantities"
          hint="Set what you approve on each line. Everything is prefilled at your ceiling."
          right={<div className="flex items-center gap-2">
            <span className="inline-flex min-h-7 items-center rounded-full bg-content2 px-2.5 text-xs font-semibold text-body">
              {reviewItems.length} {reviewItems.length === 1 ? "line" : "lines"}
            </span>
            {cutCount > 0 && (
              <span className="inline-flex min-h-7 items-center rounded-full bg-warn-bg px-2.5 text-xs font-semibold text-warn">
                {cutCount} reduced
              </span>
            )}
          </div>}
        />

        <div className="space-y-3 p-4 sm:p-5">
          <div className="grid gap-2 lg:grid-cols-2">
            <Note tone="info" icon={Info} title="How much you may approve">
              A quantity may be reduced down to zero, never increased. Entering 0 rejects that specific item.{" "}
              {anyReducedBelow
                ? "Lines already cut by an earlier approver are capped at that lower quantity, not at the original request."
                : "Each field shows the range you may enter."}
            </Note>
            {/* The one thing an approver holding part of the stock gets wrong. Cutting
                the quantity here and issuing what you hold LOOK the same on this screen
                and are opposites: a cut ends the request, an issue leaves the rest
                travelling. Said beside the boxes that do it, because that is where the
                choice is made. */}
            <Note tone="warn" icon={TriangleAlert} title="Reducing is not the same as serving">
              Reduce a quantity only to cut the request for good — the difference is not owed to
              anyone afterwards. If you simply do not hold enough, leave the quantity as it is
              {isStr
                ? <> and use <strong>Transfer source</strong> above; what the point cannot give stays owed and moves on with the request.</>
                : <> and enter what you can give under <strong>Serve from own stock</strong>; the remainder stays on this indent and carries on to the fulfilment queue.</>}
            </Note>
          </div>

          {/* Desktop: one row per line, so the four numbers that matter line up down
              the page and a cut is visible as a column, not as a paragraph. */}
          <div className="hidden overflow-x-auto rounded-xl border border-line lg:block">
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col className="w-[32%]" /><col className="w-[13%]" /><col className="w-[17%]" />
                <col className="w-[24%]" /><col className="w-[14%]" />
              </colgroup>
              <thead className="bg-content2">
                <tr className="text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-3 text-left font-semibold">Item</th>
                  <th className="px-4 py-3 text-right font-semibold">Requested</th>
                  <th className="px-4 py-3 text-right font-semibold">Current request</th>
                  <th className="px-4 py-3 text-right font-semibold">Approved at this level</th>
                  <th className="px-4 py-3 text-right font-semibold">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {reviewItems.map((line, index) => {
                  const ceiling = approvalCeiling(line);
                  const raw = quantities[line.id] ?? "";
                  const lineError = errorByLine[line.id];
                  const isZero = !lineError && raw.trim() !== "" && quantityValue(raw) === 0;
                  const difference = lineError ? null : quantityValue(raw) - ceiling;
                  const reduced = wasReducedBelow(line);
                  const unit = displayUom(line.uom_code);
                  return (
                    <tr
                      key={line.id}
                      className={`transition-colors ${
                        lineError
                          ? "bg-bad-bg/40"
                          : isZero
                            ? "bg-danger/5"
                            : difference != null && difference < 0
                              ? "bg-warn-bg/40"
                              : "hover:bg-content2/50"
                      }`}
                    >
                      <td className="px-4 py-3 align-top">
                        <div className="flex min-w-0 items-start gap-2.5">
                          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-content2 text-[11px] font-bold tabular-nums text-muted">
                            {index + 1}
                          </span>
                          <div className="min-w-0">
                            <strong className="block truncate font-semibold text-ink" title={line.item_name ?? undefined}>
                              {line.item_name}
                            </strong>
                            <p className="truncate font-mono text-xs text-muted">{line.item_code}</p>
                            <ServedNote line={line} unit={unit} />
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right align-top tabular-nums text-body">
                        {formatQuantity(line.requested_quantity)} {unit}
                      </td>
                      <td className="px-4 py-3 text-right align-top">
                        <span className={`whitespace-nowrap font-semibold tabular-nums ${reduced ? "text-warn" : "text-ink"}`}>
                          {formatQuantity(ceiling)} {unit}
                        </span>
                        {reduced && <p className="text-[11px] text-muted">Cut by a previous approver</p>}
                      </td>
                      {/* One right-aligned block per cell, the same width as the
                          column's right-aligned header: the field, its unit and the
                          help line share the block's edges, so nothing drifts out
                          from under the box. */}
                      <td className="px-4 py-3 align-top">
                        <div className="ml-auto max-w-44">
                          {line.fully_served ? <FullyServed /> : (
                            <QuantityField
                              line={line}
                              unit={unit}
                              value={raw}
                              error={lineError}
                              isZero={isZero}
                              onChange={(value) => setQuantity(line, value)}
                            />
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right align-top">
                        <DifferenceChip difference={difference} unit={unit} isZero={isZero} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Phone and tablet: the same four numbers as a card, so nothing has to be
              scrolled sideways to be signed. */}
          <div className="space-y-3 lg:hidden">
            {reviewItems.map((line, index) => {
              const ceiling = approvalCeiling(line);
              const raw = quantities[line.id] ?? "";
              const lineError = errorByLine[line.id];
              const isZero = !lineError && raw.trim() !== "" && quantityValue(raw) === 0;
              const difference = lineError ? null : quantityValue(raw) - ceiling;
              const reduced = wasReducedBelow(line);
              const unit = displayUom(line.uom_code);
              return (
                <div
                  key={line.id}
                  className={`rounded-xl border p-3 ${
                    lineError
                      ? "border-bad/40 bg-bad-bg/30"
                      : isZero
                        ? "border-danger/30 bg-danger/5"
                        : "border-line bg-content1"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-content2 text-[11px] font-bold tabular-nums text-muted">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <strong className="block truncate font-semibold text-ink">{line.item_name}</strong>
                      <p className="truncate font-mono text-xs text-muted">{line.item_code}</p>
                      <ServedNote line={line} unit={unit} />
                    </div>
                    <DifferenceChip difference={difference} unit={unit} isZero={isZero} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-content2 px-3 py-2">
                      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted">Requested</span>
                      <span className="block text-sm font-semibold tabular-nums text-ink">
                        {formatQuantity(line.requested_quantity)} {unit}
                      </span>
                    </div>
                    <div className="rounded-xl bg-content2 px-3 py-2">
                      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted">Current request</span>
                      <span className={`block text-sm font-semibold tabular-nums ${reduced ? "text-warn" : "text-ink"}`}>
                        {formatQuantity(ceiling)} {unit}
                      </span>
                    </div>
                  </div>
                  {reduced && <p className="mt-1 text-[11px] text-muted">Cut by a previous approver</p>}
                  <div className="mt-3">
                    <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">
                      Approved at this level
                    </span>
                    {line.fully_served ? <FullyServed /> : (
                      <QuantityField
                        line={line}
                        unit={unit}
                        value={raw}
                        error={lineError}
                        isZero={isZero}
                        onChange={(value) => setQuantity(line, value)}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {/* The two things the approver adds to the decision, side by side rather than
          stacked: neither is long enough to earn a full page-width band of its own. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <SectionHead
            icon={CheckCircle2}
            title="Before you approve"
            hint="All three confirm the Approve button."
            right={<span
              className={`inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-semibold tabular-nums ${
                checksDone ? "bg-ok-bg text-ok" : "bg-content2 text-muted"
              }`}
            >{checkedCount} of {CHECKS.length}</span>}
          />
          <div className="space-y-2 p-4 sm:p-5">
            {CHECKS.map((label, index) => (
              <label
                key={label}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors ${
                  checks[index]
                    ? "border-ok/30 bg-ok-bg/60 text-ink"
                    : "border-line bg-content1 text-body hover:border-brand/40"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checks[index]}
                  onChange={(event) => setChecks((current) =>
                    current.map((value, item) => (item === index ? event.target.checked : value)))}
                  className="h-5 w-5 shrink-0 cursor-pointer accent-brand"
                />
                {label}
              </label>
            ))}
          </div>
        </Card>

        <Card>
          <SectionHead
            icon={MessageSquare}
            title="Comments"
            hint="Optional — recorded with your decision."
          />
          <div className="p-4 sm:p-5">
            <textarea
              value={comments}
              onChange={(event) => setComments(event.target.value)}
              aria-label="Approval comment"
              placeholder="Anything the next approver or the requester should know"
              className="min-h-28 w-full rounded-xl border border-line bg-content1 p-3 text-sm text-ink outline-none transition placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/25"
            />
          </div>
        </Card>
      </div>

      <Card>
        <SectionHead
          icon={History}
          title="Previous approvals"
          hint="Every rung this request has already passed."
          right={historyRows.length > 0 && <span className="inline-flex min-h-7 items-center rounded-full bg-content2 px-2.5 text-xs font-semibold text-body">
            {historyRows.length}
          </span>}
        />
        {history.isLoading && <p className="p-4 text-sm text-muted sm:p-5">Loading history…</p>}
        {!history.isLoading && historyRows.length === 0 && (
          <p className="p-4 text-sm text-muted sm:p-5">
            No previous approval actions — you are the first rung on this request.
          </p>
        )}
        {historyRows.length > 0 && <HistoryTimeline rows={historyRows} />}
      </Card>
    </div>

    {/* The decision rides the foot of the screen instead of waiting at the bottom of
        the scroll. An approver who has read the lines should never have to hunt for
        the button, and what is blocking Approve is said in the same bar as the button
        it is blocking — a greyed-out Approve with no reason beside it is the other
        half of the same confusion. */}
    <div className="sticky bottom-24 z-20 md:bottom-6">
      <Card className="flex flex-wrap items-center justify-between gap-3 border-brand/30 bg-content1/95 p-3 shadow-lg backdrop-blur">
        <p
          role="status"
          className={`flex min-w-0 items-center gap-2 text-sm font-medium ${
            invalidQuantity ? "text-bad" : allZero ? "text-danger" : checksDone ? "text-ok" : "text-muted"
          }`}
        >
          {invalidQuantity
            ? <><AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
                Correct the {invalidCount === 1 ? "highlighted quantity" : `${invalidCount} highlighted quantities`} before approving.</>
            : allZero
              ? <><X className="h-4 w-4 shrink-0 text-danger" aria-hidden />
                  All requested items are set to 0. Submitting will stop this request as REJECTED.</>
              : !decision.canApprove
              ? <><TriangleAlert className="h-4 w-4 shrink-0 text-warn" aria-hidden />
                  <span className="text-warn">{decision.blocker}</span></>
              : checksDone
                ? <><CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                    Ready to sign — {reviewItems.length - zeroLinesCount} approved
                    {zeroLinesCount > 0 ? `, ${zeroLinesCount} rejected` : ""}.</>
                : <><Info className="h-4 w-4 shrink-0" aria-hidden />
                    Confirm every item on the checklist before approving ({checkedCount} of {CHECKS.length}).</>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {canReturnForCorrection && (
            <Button variant="ghost" disabled={busy} onClick={() => { setReason(""); setTargetSequence(null); setConfirming("return"); }}>
              <RotateCcw className="h-4 w-4" /> Return for correction
            </Button>
          )}
          <Button className={TONE_REJECT} variant="danger" disabled={busy} onClick={() => { setReason(""); setConfirming("reject"); }}>
            <X className="h-4 w-4" /> Reject
          </Button>
          <Button
            className={allZero ? TONE_REJECT : TONE_APPROVE}
            variant={allZero ? "danger" : "primary"}
            disabled={busy || invalidQuantity || (!allZero && (!checksDone || !decision.canApprove))}
            title={!allZero && !decision.canApprove ? decision.message : undefined}
            onClick={() => setConfirming("approve")}
          >
            {allZero ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            {allZero ? "Reject Indent (All items 0)" : decision.label}
          </Button>
        </div>
      </Card>
    </div>

    <ConfirmModal
      isOpen={confirming !== null}
      title={allZero && confirming === "approve"
        ? "Reject this request?"
        : confirming === "approve"
          ? "Approve this request?"
          : confirming === "reject"
            ? "Reject this request?"
            : "Return for correction?"}
      message={allZero && confirming === "approve"
        ? "All items have been set to 0 quantity. This request will stop here and be marked as REJECTED."
        : confirming === "approve"
          ? (zeroLinesCount > 0
              ? `${zeroLinesCount} item(s) with 0 quantity will be rejected. The remaining ${reviewItems.length - zeroLinesCount} item(s) will move forward.`
              : decision.message)
          : confirming === "reject"
            ? "The request will stop and the requester will see your reason."
            : chosenOption
              ? `It goes back to ${targetLabel(chosenOption)}, `
                + "who corrects it and resubmits. Every approval after that step is asked again. "
                + "Your instructions are recorded in approval history."
              : "Your correction instructions will be recorded in approval history."}
      confirmLabel={allZero && confirming === "approve" ? "Reject Request" : confirming === "approve" ? decision.label : confirming === "reject" ? "Reject" : "Return for correction"}
      danger={confirming === "reject" || (allZero && confirming === "approve")}
      busy={busy || ((confirming === "reject" || confirming === "return") && !reason.trim())
        || (confirming === "return" && returnTargets.isLoading)}
      confirmDisabled={confirming === "approve" && decision.needsReason && !allZero && !comments.trim()}
      error={actionError}
      onClose={() => !busy && setConfirming(null)}
      onConfirm={confirm}
    >
      {confirming === "return" && targetOptions.length > 0 && (
        <ReturnTargetSelect
          targets={targetOptions}
          value={chosenTarget}
          onChange={setTargetSequence}
        />
      )}
      {confirming === "approve" && decision.needsReason && !allZero && (
        <label className="block text-sm font-semibold text-ink">
          Why are you forwarding it?
          <textarea
            autoFocus
            value={comments}
            onChange={(event) => setComments(event.target.value)}
            className="mt-2 min-h-24 w-full rounded-xl border border-line bg-content1 p-3 text-sm font-normal text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/25"
            placeholder="e.g. The source point is not under me"
          />
          {!comments.trim() && <p className="mt-1 text-xs font-normal text-danger">A reason is required.</p>}
        </label>
      )}
      {(confirming === "reject" || confirming === "return") && (
        <label className="block text-sm font-semibold text-ink">
          {confirming === "reject" ? "Rejection reason" : "What must be corrected?"}
          <textarea
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="mt-2 min-h-24 w-full rounded-xl border border-line bg-content1 p-3 text-sm font-normal text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/25"
            placeholder="Required"
          />
          {!reason.trim() && <p className="mt-1 text-xs font-normal text-danger">A reason is required.</p>}
        </label>
      )}
    </ConfirmModal>
  </>;
}
