import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Unlock } from "lucide-react";
import { Can, Card, ConfirmModal, ErrorBanner, FilterBar, FilterMenu, PageHeader, ResponsiveList, StatusPill, Textarea, useToast, type Column } from "@/shared/components";
import { Button } from "../components/ActionButton";
import { fmtDate } from "@/shared/datetime";
import { rfqApi } from "../api";
import type { RFQListRow } from "../types";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { RFQKpis } from "../components/ProcurementKpis";
import { useUrlFilters } from "../urlFilters";

/** RFQStatus, as the backend enum spells it. */
const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "PUBLISHED", label: "Open to vendors" },
  { value: "CLOSED", label: "Closed" },
  { value: "AWARDED", label: "Awarded" },
  { value: "CANCELLED", label: "Cancelled" },
];

/** How soon an RFQ shuts. Overdue is its own row: a tender past its date with no
 *  quotes in is the one a buyer has to act on today. */
const CLOSING = [
  { value: "overdue", label: "Past due" },
  { value: "7", label: "Next 7 days" },
  { value: "30", label: "Next 30 days" },
];

const SIZE = 20;

/** Every filter this screen owns, so Clear knows what to drop. */
const FILTER_KEYS = ["status", "search", "closing", "pending_for_me", "ready_to_award"];

export function RFQListPage() {
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  // Filters live in the URL — see `../urlFilters`. The KPI strip above sets them.
  const { get, getBool, set, clear, page, setPage, activeCount } = useUrlFilters();
  const status = get("status");
  const closing = get("closing");
  const search = get("search");
  const pendingForMe = getBool("pending_for_me");
  const readyToAward = getBool("ready_to_award");
  const debouncedSearch = useDebouncedValue(search);

  // Unfreeze modal state
  const [unfreezeTarget, setUnfreezeTarget] = useState<{ id: number; no: string } | null>(null);
  const [unfreezeReason, setUnfreezeReason] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["rfqs", status, debouncedSearch, pendingForMe, readyToAward, page],
    queryFn: () => rfqApi.list({
      status: status || undefined,
      search: debouncedSearch || undefined,
      pending_for_me: pendingForMe || undefined,
      ready_to_award: readyToAward || undefined,
      page, size: SIZE,
    }),
  });

  const freezeMutation = useMutation({
    mutationFn: (id: number) => rfqApi.freeze(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      toast.success("RFQ prices locked");
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to freeze prices";
      toast.error(msg);
    },
  });

  const unfreezeMutation = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => rfqApi.unfreeze(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      setUnfreezeTarget(null);
      setUnfreezeReason("");
      toast.success("Bidding reopened");
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to unfreeze prices";
      toast.error(msg);
    },
  });

  const all = data?.items ?? [];
  const rows = all.filter((r) => {
    if (!closing) return true;
    if (!r.due_date) return false;
    const due = new Date(r.due_date);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (closing === "overdue") return due < today;
    const limit = new Date(today);
    limit.setDate(limit.getDate() + Number(closing));
    return due >= today && due <= limit;
  });
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));

  const columns: Column<RFQListRow>[] = [
    {
      key: "rfq",
      header: "RFQ",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink flex items-center gap-1.5">
            {r.is_price_frozen && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-700 border border-amber-500/20" title="Prices locked">
                <Lock className="h-3 w-3" /> Locked
              </span>
            )}
            {r.rfq_no}
          </div>
          <div className="truncate text-[11px] text-muted">{r.title && r.title.trim() !== "" && r.title !== "Untitled" ? r.title : null}</div>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "with",
      header: "Pending with",
      hideOnNarrow: true,
      render: (r) => (r.pending_with?.length
        ? r.pending_with.join(", ")
        : (r.current_approver_name ?? "—")),
    },
    {
      key: "responses",
      header: "Responses",
      className: "text-right",
      render: (r) => (
        <span className="text-sm text-body">
          {r.response_count} of {r.vendor_count}
        </span>
      ),
    },
    { key: "lines", header: "Lines", className: "text-right", hideOnNarrow: true, render: (r) => r.total_items },
    {
      key: "due",
      header: "Closes",
      render: (r) => (r.due_date ? fmtDate(r.due_date) : "—"),
    },
    {
      key: "awarded",
      header: "Awarded to",
      hideOnNarrow: true,
      render: (r) => r.awarded_vendor_name ?? "—",
    },
    {
      key: "lock",
      header: "Lock / Pricing",
      render: (r) => {
        if (r.status !== "PUBLISHED" && !r.is_price_frozen) {
          return <span className="text-xs text-muted">—</span>;
        }
        if (r.is_price_frozen) {
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setUnfreezeTarget({ id: r.id, no: r.rfq_no });
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-amber-700 bg-amber-500/10 hover:bg-amber-500/20 transition border border-amber-500/20"
              title="Prices are locked. Click to unlock/reopen bidding."
            >
              <Lock className="h-3.5 w-3.5" /> Locked
            </button>
          );
        }
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              freezeMutation.mutate(r.id);
            }}
            disabled={freezeMutation.isPending}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-emerald-700 bg-emerald-500/10 hover:bg-emerald-500/20 transition border border-emerald-500/20"
            title="Click to lock RFQ prices and freeze bidding."
          >
            <Unlock className="h-3.5 w-3.5" /> Lock RFQ
          </button>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title="Requests for Quotation"
        actions={
          <Can do="rfq.create">
            <Button onClick={() => nav("/procurement/rfqs/new")}>New RFQ</Button>
          </Can>
        }
      />

      <div className="mb-4">
        <RFQKpis />
      </div>

      <FilterBar
        search={search}
        onSearch={(value) => set({ search: value })}
        searchPlaceholder="Search RFQ no. or title…"
        active={activeCount(FILTER_KEYS)}
        onClear={() => clear(FILTER_KEYS)}
      >
        <FilterMenu label="Status" value={status}
                    onChange={(value) => set({ status: value })}
                    options={STATUSES.filter((o) => o.value)} />
        <FilterMenu label="Closes" value={closing}
                    onChange={(value) => set({ closing: value })} options={CLOSING} />
      </FilterBar>

      <ErrorBanner error={error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(`/procurement/rfqs/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={
            pendingForMe
              ? "Nothing is waiting for your signature."
              : readyToAward
                ? "No tender has replies waiting to be awarded."
                : status ? "No RFQs in this status." : "No RFQs yet."
          }
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink flex items-center gap-1.5">
                  {r.is_price_frozen && <Lock className="h-3.5 w-3.5 text-amber-600" />}
                  {r.rfq_no}
                </span>
                <div className="flex items-center gap-2">
                  {r.is_price_frozen ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setUnfreezeTarget({ id: r.id, no: r.rfq_no });
                      }}
                      className="px-2 py-0.5 rounded text-[11px] font-medium text-amber-700 bg-amber-500/10 border border-amber-500/20"
                    >
                      Locked
                    </button>
                  ) : r.status === "PUBLISHED" ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        freezeMutation.mutate(r.id);
                      }}
                      className="px-2 py-0.5 rounded text-[11px] font-medium text-emerald-700 bg-emerald-500/10 border border-emerald-500/20"
                    >
                      Lock RFQ
                    </button>
                  ) : null}
                  <StatusPill status={r.status} />
                </div>
              </div>
              <div className="text-sm text-body">{r.title && r.title.trim() !== "" && r.title !== "Untitled" ? r.title : null}</div>
              <div className="text-xs text-muted">
                {r.response_count} of {r.vendor_count} replied
                {r.due_date ? ` · closes ${fmtDate(r.due_date)}` : ""}
              </div>
            </div>
          )}
        />
      </Card>

      <ConfirmModal
        isOpen={!!unfreezeTarget}
        title={`Reopen bidding on ${unfreezeTarget?.no ?? "this RFQ"}?`}
        message="Suppliers will be able to quote and change prices again. Say why — it is recorded on the tender."
        confirmLabel="Reopen bidding"
        tone="warning"
        busy={unfreezeMutation.isPending}
        confirmDisabled={unfreezeReason.trim().length < 3}
        onConfirm={() => {
          if (unfreezeTarget) {
            unfreezeMutation.mutate({ id: unfreezeTarget.id, reason: unfreezeReason.trim() });
          }
        }}
        onClose={() => {
          setUnfreezeTarget(null);
          setUnfreezeReason("");
        }}
      >
        <Textarea
          value={unfreezeReason}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUnfreezeReason(e.target.value)}
          minRows={2}
          placeholder="e.g. Winning vendor's delivery date slipped — re-opening the tender"
          aria-label="Reason for reopening bidding"
        />
      </ConfirmModal>
    </div>
  );
}
