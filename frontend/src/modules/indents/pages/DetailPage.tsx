import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Loader2, Pencil, Send, Trash2 } from "lucide-react";
import {
  CardBody, Skeleton, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow,
} from "@heroui/react";
import { PageHeader, Button, Can, Card } from "@/shared/components";
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
import type { Indent } from "../types";

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

  const { data: indent, isLoading, error: loadError } = useQuery({
    queryKey: indentKeys.detail(accountScope, indentId),
    queryFn: () => indentApi.get(indentId),
    enabled: Number.isFinite(indentId),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    refetchOnWindowFocus: false,
  });

  const { data: journey, isLoading: isJourneyLoading } = useQuery({
    queryKey: indentKeys.journey(accountScope, indentId),
    queryFn: () => indentApi.journey(indentId),
    enabled: Number.isFinite(indentId) && Boolean(indent),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    refetchOnWindowFocus: false,
  });

  // The delivery half of the journey. Served by the warehouse module, which owns the
  // issue and dispatch rows the indents module may not read (rule 5).
  const { data: fulfilment } = useQuery({
    queryKey: ["indent-fulfilment", accountScope, indentId],
    queryFn: () => indentApi.fulfilment(indentId),
    enabled: Number.isFinite(indentId) && Boolean(indent),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
    refetchOnWindowFocus: false,
  });

  const prefetchJourney = useCallback(() => {
    if (!Number.isFinite(indentId)) return;
    qc.prefetchQuery({
      queryKey: indentKeys.journey(accountScope, indentId),
      queryFn: () => indentApi.journey(indentId),
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
  const onErr = (e: Error) => setError(e.message);

  const submit = useMutation({
    mutationFn: () => indentApi.submit(indentId),
    onSuccess: (updated) => refreshAfterAction(updated, true),
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

  if (isLoading || !indent) return <Skeleton className="h-40 rounded-2xl" />;

  const isDraft = indent.status === "DRAFT";
  const isDraftOwner = isDraft && indent.requested_by_id === me?.employee.id;
  const showDeleteDraft = !decisionView && isDraft && (isDraftOwner || can("indent.delete"));
  const isPending = indent.status === "PENDING_APPROVAL";
  const showActions = !decisionView && indent.can_submit;
  const actionPending = submit.isPending || deleteDraft.isPending;

  return (
    <>
      <button onClick={() => nav(returnUrl)} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-body">
        <ArrowLeft className="h-4 w-4" /> {returnLabel}
      </button>

      <PageHeader
        eyebrow="Indent"
        title={indent.indent_no}
        actions={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            <IndentStatusBadge status={indent.status} journey={journey} />
            {isDraftOwner && (
              <Can do="indent.edit">
                <Button
                  variant="primary"
                  disabled={actionPending}
                  onClick={() => nav(`/indents/new?edit=${indent.id}`)}
                >
                  <Pencil className="h-4 w-4" /> Edit Indent
                </Button>
              </Can>
            )}
            {showDeleteDraft && (
              <Button
                variant="danger"
                disabled={actionPending}
                onClick={() => {
                  if (window.confirm(`Delete draft ${indent.indent_no}? This cannot be undone.`)) {
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

      <button
        type="button"
        aria-label={`View complete approval journey for ${indent.indent_no}`}
        onClick={() => nav(`/indents/${indent.id}/journey`)}
        onPointerEnter={prefetchJourney}
        onPointerDown={prefetchJourney}
        onFocus={prefetchJourney}
        onKeyDown={(event) => {
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
              isLoading={isJourneyLoading}
              fulfilment={fulfilment}
            />
            <div className="mt-4 flex min-h-11 items-center justify-between gap-3 border-t border-line pt-3 text-sm font-semibold text-brand">
              <span>View complete approval journey</span>
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
                    <TableCell className="text-right text-muted">{it.uom_code}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardBody>
        </Card>

        <Card className="h-fit">
          <CardBody className="p-5">
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-1">
              <Detail label="Requested by" value={indent.requested_by_name} />
              <Detail label="Position" value={indent.position_name} />
              <Detail label="Department" value={indent.department_name} />
              <Detail label="Deliver to" value={indent.office_name} />
              <Detail label="Priority" value={indent.priority} />
              {isPending && <Detail label="With" value={indent.current_approver_name} />}
            </dl>
          </CardBody>
        </Card>
      </div>

      {error && (
        <div className="mt-4 rounded-xl bg-bad-bg px-4 py-3 text-sm font-medium text-bad">{error}</div>
      )}

      {showActions && (
        <div className="fixed inset-x-0 bottom-0 z-10 flex gap-3 border-t border-line bg-content1 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:static md:mt-6 md:justify-end md:border-0 md:bg-transparent md:p-0">
          {indent.can_submit && (
            <Button className="flex-1 md:flex-none" disabled={actionPending} onClick={() => !actionPending && submit.mutate()}>
              {submit.isPending ? <InlineSpinner /> : <Send className="h-4 w-4" />} {submit.isPending ? "Submitting..." : "Submit for approval"}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
