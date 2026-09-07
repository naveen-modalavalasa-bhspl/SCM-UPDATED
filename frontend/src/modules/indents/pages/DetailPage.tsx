import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ChevronRight, FileText, Loader2, Pencil, RefreshCw, Send, Trash2,
} from "lucide-react";
import {
  CardBody, Skeleton,
  Table, TableBody, TableCell, TableColumn, TableHeader, TableRow,
} from "@heroui/react";
import { PageHeader, Button, Can, Card, ErrorBanner, useToast } from "@/shared/components";
import { alerts } from "@/modules/alerts";
import { useAuth } from "@/shared/auth/AuthContext";
import { FlowStepper } from "../components/FlowStepper";
import { IndentStatusBadge } from "../components/IndentStatusBadge";
import { activityLedgerReturnUrlFromState } from "../context/ActivityLedgerUrlState";
import { allRequestsReturnUrlFromState } from "../context/AllRequestsUrlState";
import { notificationsReturnUrlFromState } from "../context/NotificationsUrlState";
import {
  INDENT_QUERY_GC_TIME, INDENT_QUERY_STALE_TIME, indentApi, indentKeys,
  isIndentModuleQuery, isIndentUnavailableError, useIndentAccountCacheIsolation,
  useIndentAccountScope,
} from "../api";
import { cancelIndentDecisionReads } from "../approvalRefresh";
import { INDENT_STATUS, indentTypeLabel } from "../constants";
import { displayUom, splitDeliveryOffice } from "../displayFormat";
import type { Indent } from "../types";
import { TONE_MINT, TONE_RED, TONE_YELLOW } from "../buttonTones";
import { TONE_SUBMIT } from "@/shared/components/tones";

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-body">{value || "—"}</dd>
    </div>
  );
}

function InlineSpinner() {
  return <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
}

function nonEmptyText(value?: string | null) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function returnedByFromJourney(journey?: { stages?: Array<{ status?: string; approver_name?: string | null; position_name?: string | null }> }) {
  const returnedStage = journey?.stages?.find((stage) =>
    String(stage.status ?? "").trim().toUpperCase() === "RETURNED"
    || String(stage.status ?? "").trim().toUpperCase() === INDENT_STATUS.RETURNED_FOR_CORRECTION
  );
  return nonEmptyText(returnedStage?.approver_name) ?? nonEmptyText(returnedStage?.position_name);
}

export function IndentDetailPage() {
  const { id } = useParams();
  const indentId = Number(id);
  const nav = useNavigate();
  const location = useLocation();
  const decisionView = new URLSearchParams(location.search).get("decision") === "1";
  const allRequestsReturnUrl = allRequestsReturnUrlFromState(location.state);
  const activityLedgerReturnUrl = activityLedgerReturnUrlFromState(location.state);
  const notificationsReturnUrl = notificationsReturnUrlFromState(location.state);
  const returnUrl = decisionView
    ? "/approvals/decisions"
    : notificationsReturnUrl ?? activityLedgerReturnUrl ?? allRequestsReturnUrl;
  const returnLabel = decisionView
    ? "My Decisions"
    : notificationsReturnUrl
    ? "Alert & Notification"
    : activityLedgerReturnUrl ? "Activity ledger" : "All indents";
  const unavailableReturnLabel = decisionView
    ? "Back to My Decisions"
    : notificationsReturnUrl
    ? "Back to Alert & Notification"
    : activityLedgerReturnUrl ? "Back to Activity ledger" : "Back to All requests";
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const {
    data: indent, isLoading, isFetching, error: loadError, refetch: refetchIndent,
  } = useQuery({
    queryKey: indentKeys.detail(accountScope, indentId),
    queryFn: ({ signal }) => indentApi.get(indentId, signal),
    enabled: Number.isFinite(indentId),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    // Matches the journey page, so the card and the journey cannot drift apart
    // after a decision taken in another tab.
    refetchOnWindowFocus: true,
  });

  const { data: journey, isLoading: isJourneyLoading } = useQuery({
    queryKey: indentKeys.journey(accountScope, indentId),
    queryFn: ({ signal }) => indentApi.journey(indentId, signal),
    enabled: Number.isFinite(indentId),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    refetchOnWindowFocus: true,
  });

  const isRaiser = Boolean(indent && indent.requested_by_id === me?.employee.id);
  const { data: shipments } = useQuery({
    queryKey: indentKeys.shipments(accountScope, indentId),
    queryFn: ({ signal }) => indentApi.shipmentsForIndent(indentId, signal),
    enabled: Number.isFinite(indentId) && isRaiser,
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    refetchOnWindowFocus: true,
  });

  const prefetchJourney = useCallback(() => {
    if (!Number.isFinite(indentId)) return;
    qc.prefetchQuery({
      queryKey: indentKeys.journey(accountScope, indentId),
      queryFn: ({ signal }) => indentApi.journey(indentId, signal),
      staleTime: INDENT_QUERY_STALE_TIME,
      gcTime: INDENT_QUERY_GC_TIME,
    });
  }, [accountScope, indentId, qc]);

  const refreshAfterAction = (updated: Indent, refetchJourney: boolean) => {
    setError(null);
    // Write the mutation response immediately so status and actions update at once.
    qc.setQueryData(indentKeys.detail(accountScope, indentId), updated);
    // Actions actively refresh the mounted journey without hiding cached data.
    qc.invalidateQueries({
      queryKey: indentKeys.journey(accountScope, indentId),
      refetchType: refetchJourney ? "active" : "none",
    });
    qc.invalidateQueries({
      predicate: (query) => isIndentModuleQuery(query) && query.queryKey[3] !== "journey",
    });
  };
  // `e.message` is already the sentence the shared client wrote (shared/api/errors.ts),
  // so a refusal reaches the banner below in the same words it would anywhere else.
  const onErr = (e: Error) => setError(e.message);

  const submit = useMutation({
    mutationFn: () => indentApi.submit(indentId),
    onMutate: () => cancelIndentDecisionReads(qc, accountScope, indentId),
    onSuccess: (updated) => {
      refreshAfterAction(updated, true);
      // The screen stays put and only the stepper moves, so without this the most
      // consequential press a requester makes — the one that starts the approval
      // chain and locks the indent — looked like nothing happened.
      toast.success({
        title: "Sent for approval",
        message: `${updated.indent_no} is with its approver and can no longer be edited.`,
      });
    },
    onError: onErr,
  });
  const deleteDraft = useMutation({
    mutationFn: () => indentApi.delete(indentId),
    onSuccess: () => {
      setError(null);
      qc.removeQueries({ queryKey: indentKeys.detail(accountScope, indentId) });
      qc.removeQueries({ queryKey: indentKeys.journey(accountScope, indentId) });
      qc.invalidateQueries({ predicate: isIndentModuleQuery });
      nav("/indents");
      // After the navigation on purpose: the toast outlives this screen, so it is
      // still on the list page the user lands on — which is the only place left to
      // tell them the draft is actually gone.
      toast.success({
        title: "Draft deleted",
        message: `${indent?.indent_no ?? "The draft"} has been removed.`,
      });
    },
    onError: onErr,
  });
  const resubmitCorrection = useMutation({
    mutationFn: () => indentApi.resubmitCorrection(indentId),
    onSuccess: (updated) => {
      refreshAfterAction(updated, true);
      qc.invalidateQueries({ queryKey: ["approvals"], refetchType: "all" });
      toast.success({
        title: "Sent back for approval",
        message: `${updated.indent_no} has gone back to its approver with your corrections.`,
      });
    },
    onError: onErr,
  });

  const unavailable = isIndentUnavailableError(loadError);
  useEffect(() => {
    if (unavailable) {
      qc.removeQueries({ queryKey: indentKeys.detail(accountScope, indentId) });
      qc.removeQueries({ queryKey: indentKeys.journey(accountScope, indentId) });
    }
  }, [accountScope, indentId, qc, unavailable]);

  if (unavailable) {
    return (
      <div className="space-y-4 rounded-xl border border-line bg-content1 p-5">
        <p className="text-sm font-semibold text-body">This indent is not available to your current account</p>
        <Button variant="secondary" onClick={() => nav(returnUrl)}>
          <ArrowLeft className="h-4 w-4" /> {unavailableReturnLabel}
        </Button>
      </div>
    );
  }

  // A failed load must never sit on a loading placeholder — say so, and offer a retry.
  if (loadError && !indent) {
    return (
      <div className="space-y-4 rounded-xl border border-bad/30 bg-content1 p-5">
        <p className="text-sm font-semibold text-body">This indent could not be loaded</p>
        <p className="break-words text-sm text-muted">{loadError.message}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => refetchIndent()} disabled={isFetching}>
            {isFetching ? <InlineSpinner /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            {isFetching ? "Retrying..." : "Try again"}
          </Button>
          <Button variant="secondary" onClick={() => nav(returnUrl)}>
            <ArrowLeft className="h-4 w-4" /> {unavailableReturnLabel}
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading || !indent) return <Skeleton className="h-40 rounded-2xl" />;

  const isDraft = indent.status === INDENT_STATUS.DRAFT;
  const isReturnedForCorrection = indent.status === INDENT_STATUS.RETURNED_FOR_CORRECTION;
  const isDraftOwner = isDraft && indent.requested_by_id === me?.employee.id;
  const showDeleteDraft = !decisionView && !isReturnedForCorrection && isDraft && (isDraftOwner || can("indent.delete"));
  const showCorrectionActions = !decisionView
    && isReturnedForCorrection
    && indent.can_resubmit_correction;
  // Approve/Reject live in the Approvals module only — this page is read-only for approvers.
  const showActions = !decisionView && !isReturnedForCorrection && indent.can_submit;
  const actionPending = submit.isPending || deleteDraft.isPending || resubmitCorrection.isPending;
  const delivery = splitDeliveryOffice(indent.office_name, indent.vehicle_number);
  const officeSac = nonEmptyText(indent.office_sac)
    ?? (indent.office_id === me?.active_position?.office_id
      ? nonEmptyText(me?.active_position?.office_sac) : null)
    ?? (indent.office_id === me?.employee.office_id
      ? nonEmptyText(me?.employee.office_sac) : null)
    // `me?.positions?.` and not `me?.positions.` — the optional chain has to cover the
    // array too. A session with no positions list took the whole detail page down with
    // it, and this is the last of four fallbacks: an SAC nobody can find is a blank
    // field, never a blank screen.
    ?? nonEmptyText(me?.positions?.find((position) => position.office_id === indent.office_id)?.office_sac);
  const returnedBy = returnedByFromJourney(journey);
  const correctionOwner = nonEmptyText(indent.correction_owner?.employee_name)
    ?? (indent.correction_owner?.employee_id ? `Employee #${indent.correction_owner.employee_id}` : null);

  return (
    <>
      <button
        type="button"
        onClick={() => nav(returnUrl)}
        className="mb-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-body"
      >
        <ArrowLeft className="h-4 w-4" /> {returnLabel}
      </button>

      <PageHeader
        eyebrow="Indent"
        title={indent.indent_no}
        actions={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            <IndentStatusBadge status={indent.status} journey={journey} />
            {/* The indent as a document. A new tab, so the screen the user is working
                keeps its place; the print route re-reads the indent under the same
                token, so nothing here decides what a viewer may print. */}
            <Can do="indent.view">
              <Button
                variant="secondary"
                className={TONE_YELLOW}
                onClick={() => window.open(`/indents/${indent.id}/print`, "_blank", "noopener")}
              >
                <FileText className="h-4 w-4" /> PDF
              </Button>
            </Can>
            {isDraftOwner && (
              <Can do="indent.edit">
                <Button
                  variant="primary"
                  className={TONE_MINT}
                  disabled={actionPending}
                  onClick={() => nav(`/indents/new?edit=${indent.id}`)}
                >
                  <Pencil className="h-4 w-4" /> Edit Indent
                </Button>
              </Can>
            )}
            {!decisionView && isReturnedForCorrection && indent.can_edit_correction && (
              <Button
                variant="primary"
                className={TONE_MINT}
                disabled={actionPending}
                onClick={() => nav(`/indents/new?edit=${indent.id}`)}
              >
                <Pencil className="h-4 w-4" /> Edit correction
              </Button>
            )}
            {showDeleteDraft && (
              <Button
                variant="danger"
                className={TONE_RED}
                disabled={actionPending}
                onClick={async () => {
                  // The catalog's own copy (`indent.delete`), so this reads the same
                  // as every other destructive confirm in the app instead of being
                  // the browser's unstyled grey box.
                  if (await alerts.confirm("indent.delete", { number: indent.indent_no })) {
                    deleteDraft.mutate();
                  }
                }}
              >
                {deleteDraft.isPending ? <InlineSpinner /> : <Trash2 className="h-4 w-4" />}
                {deleteDraft.isPending ? "Deleting..." : "Delete Draft"}
              </Button>
            )}
          </div>
        )}
      />

      {isReturnedForCorrection && (
        <Card className="mb-5 border-warn/40 bg-warn-bg">
          <CardBody className="p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-warn">Returned for correction</p>
                <p className="mt-1 break-words text-sm font-medium text-body">
                  {nonEmptyText(indent.correction_comment) ?? "Correction instructions were not supplied."}
                </p>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:min-w-[420px]">
                <Detail label="Returned by" value={returnedBy} />
                <Detail label="Returned stage" value={indent.returned_from_stage} />
                <Detail label="Correction comment" value={indent.correction_comment} />
                <Detail label="Correction owner" value={correctionOwner} />
                <Detail label="Resubmit target stage" value={indent.resubmit_target_stage} />
              </dl>
            </div>
          </CardBody>
        </Card>
      )}

      <button
        type="button"
        aria-label={`View complete indent journey for ${indent.indent_no}`}
        onClick={() => nav(`/indents/${indent.id}/journey`)}
        onPointerEnter={prefetchJourney}
        onPointerDown={prefetchJourney}
        onFocus={prefetchJourney}
        onKeyDown={(event) => {
          // preventDefault stops the browser's own activation, so Enter/Space
          // navigate exactly once here rather than twice.
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            nav(`/indents/${indent.id}/journey`);
          }
        }}
        className="group mb-5 block w-full cursor-pointer rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
      >
        <Card className="transition-colors duration-150 group-hover:border-brand/40 group-hover:bg-content2 motion-reduce:transition-none">
          <CardBody className="p-5">
            <FlowStepper
              status={indent.status}
              journey={journey}
              shipments={isRaiser ? shipments : undefined}
              isLoading={isJourneyLoading}
            />
            <div className="mt-4 flex min-h-11 items-center justify-between gap-3 border-t border-line pt-3 text-sm font-semibold text-brand">
              <span>View complete indent journey</span>
              <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </div>
          </CardBody>
        </Card>
      </button>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody className="p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Line items</h2>
            <Table removeWrapper aria-label="Line items"
                   classNames={{ th: "bg-content2 text-[11px] uppercase tracking-wider text-muted", td: "py-3" }}>
              <TableHeader>
                <TableColumn>Item</TableColumn>
                <TableColumn className="text-right">Qty</TableColumn>
                <TableColumn className="text-right">UOM</TableColumn>
              </TableHeader>
              <TableBody items={indent.items}>
                {(it) => (
                  <TableRow key={it.id}>
                    <TableCell>
                      <div className="font-medium text-body">{it.item_name}</div>
                      <div className="mono text-xs text-muted">{it.item_code}</div>
                    </TableCell>
                    <TableCell className="text-right tabular font-semibold">{it.quantity}</TableCell>
                    <TableCell className="text-right text-muted">{displayUom(it.uom_code) || "—"}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardBody>
        </Card>

        <Card className="h-fit">
          <CardBody className="p-5">
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-1">
              <Detail label="Type" value={indentTypeLabel(indent.indent_type)} />
              <Detail label="Requested by" value={indent.requested_by_name} />
              <Detail label="Position" value={indent.position_name} />
              <Detail label="Department" value={indent.department_name} />
              <Detail label="Deliver to" value={delivery.officeName} />
              <Detail label="Vehicle" value={delivery.vehicleNumber} />
              {/* The delivery office's code, not the viewer's: an approver reading
                  someone else's indent sees the SAC it will be delivered against. */}
              <Detail label="Service area code (SAC)" value={officeSac} />
              <Detail label="Priority" value={indent.priority} />
              {indent.current_approver_name && (
                <Detail label="With" value={indent.current_approver_name} />
              )}
            </dl>
          </CardBody>
        </Card>
      </div>

      {error && (
        <ErrorBanner error={error} className="mt-4" />
      )}

      {showActions && (
        <div className="fixed inset-x-0 bottom-0 z-10 flex gap-3 border-t border-line bg-content1 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:static md:mt-6 md:justify-end md:border-0 md:bg-transparent md:p-0">
          {indent.can_submit && (
            <Button className={`flex-1 md:flex-none ${TONE_SUBMIT}`} disabled={actionPending} onClick={() => !actionPending && submit.mutate()}>
              {submit.isPending ? <InlineSpinner /> : <Send className="h-4 w-4" />} {submit.isPending ? "Submitting..." : "Submit for approval"}
            </Button>
          )}
        </div>
      )}

      {showCorrectionActions && (
        <div className="fixed inset-x-0 bottom-0 z-10 flex gap-3 border-t border-line bg-content1 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:static md:mt-6 md:justify-end md:border-0 md:bg-transparent md:p-0">
          {indent.can_resubmit_correction && (
            <Button
              className="flex-1 md:flex-none"
              disabled={actionPending}
              onClick={() => {
                if (actionPending) return;
                setError(null);
                resubmitCorrection.mutate();
              }}
            >
              {resubmitCorrection.isPending ? <InlineSpinner /> : <Send className="h-4 w-4" />}
              {resubmitCorrection.isPending ? "Resubmitting..." : "Resubmit correction"}
            </Button>
          )}
        </div>
      )}

    </>
  );
}
