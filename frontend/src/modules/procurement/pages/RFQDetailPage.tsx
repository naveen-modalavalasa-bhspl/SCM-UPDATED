import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, PageHeader, ResponsiveList, Select, StatusPill,
  useToast, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { rfqApi } from "../api";
import { money } from "./RequisitionListPage";
import type { QuoteListRow, RFQItem, RFQVendor } from "../types";

/**
 * One RFQ: its lines, who was asked, and — once quotes are in — the comparison.
 *
 * The comparison is behind `rfq.compare` and the award behind `rfq.award`, separately,
 * because the sheet carries every vendor's price. That is exactly what must never
 * reach a vendor, so seeing it is a narrower right than raising the RFQ was.
 */
export function RFQDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rfqId = Number(id);
  const [copied, setCopied] = useState<number | null>(null);

  const { data: rfq, isLoading, error } = useQuery({
    queryKey: ["rfq", id],
    queryFn: () => rfqApi.get(rfqId),
  });

  const published = ["PUBLISHED", "CLOSED", "AWARDED"].includes(rfq?.status ?? "");

  // Previewing a different ranking is a query parameter, not a save: looking at the
  // quotes another way is not choosing one, so the RFQ's own method is untouched
  // until somebody edits it on the form.
  const [method, setMethod] = useState("");

  const { data: comparison } = useQuery({
    queryKey: ["rfq-comparison", id, method],
    queryFn: () => rfqApi.comparison(rfqId, method || undefined),
    // Only once vendors can actually have answered — asking earlier returns an empty
    // sheet that reads as "nobody quoted" rather than "nobody was asked yet".
    enabled: published,
  });

  const { data: methods } = useQuery({
    queryKey: ["rfq-evaluation-methods"],
    queryFn: rfqApi.evaluationMethods,
    enabled: published,
  });

  const { data: invites = [] } = useQuery({
    queryKey: ["rfq-invites", id],
    queryFn: () => rfqApi.invites(rfqId),
    enabled: published,
  });

  const refresh = (message: string) => () => {
    queryClient.invalidateQueries({ queryKey: ["rfq", id] });
    queryClient.invalidateQueries({ queryKey: ["rfqs"] });
    queryClient.invalidateQueries({ queryKey: ["rfq-comparison", id] });
    toast.success(message);
  };

  const submit = useMutation({ mutationFn: () => rfqApi.submit(rfqId), onSuccess: refresh("Sent for approval") });
  const approve = useMutation({ mutationFn: () => rfqApi.approve(rfqId), onSuccess: refresh("Approved — vendors can now see it") });
  const reject = useMutation({ mutationFn: () => rfqApi.reject(rfqId), onSuccess: refresh("Rejected") });
  const close = useMutation({ mutationFn: () => rfqApi.close(rfqId), onSuccess: refresh("Closed to further quotes") });
  const award = useMutation({
    mutationFn: (quotationId: number) => rfqApi.award(rfqId, quotationId),
    onSuccess: refresh("Awarded"),
  });

  const busy = submit.isPending || approve.isPending || reject.isPending
    || close.isPending || award.isPending;

  const copyInvite = async (vendorId: number, path: string) => {
    await navigator.clipboard.writeText(`${location.origin}${path}`);
    setCopied(vendorId);
    toast.success("Link copied — send it to the vendor");
    setTimeout(() => setCopied(null), 2000);
  };

  const lineColumns: Column<RFQItem>[] = [
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">{r.item_name ?? `Item ${r.item_id}`}</div>
          <div className="font-mono text-[11px] text-muted">{r.item_code ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Quantity",
      className: "text-right",
      render: (r) => `${r.quantity} ${r.uom_code ?? ""}`.trim(),
    },
    {
      key: "needed",
      header: "Needed by",
      hideOnNarrow: true,
      render: (r) => (r.required_date ? fmtDate(r.required_date) : "—"),
    },
  ];

  const vendorColumns: Column<RFQVendor>[] = [
    { key: "vendor", header: "Vendor", render: (r) => r.vendor_name ?? `Vendor ${r.vendor_id}` },
    { key: "email", header: "Email", hideOnNarrow: true, render: (r) => r.vendor_email ?? "—" },
    {
      key: "status",
      header: "Replied",
      render: (r) => (r.responded_at ? <StatusPill status={r.status ?? "SUBMITTED"} /> : <span className="text-sm text-muted">Not yet</span>),
    },
    {
      key: "link",
      header: "Invite",
      render: (r) => {
        const invite = invites.find((i) => i.vendor_id === r.vendor_id);
        if (!invite) return <span className="text-sm text-muted">—</span>;
        return (
          <button
            type="button"
            onClick={() => copyInvite(r.vendor_id, invite.invite_path)}
            className="flex h-11 items-center gap-1.5 text-sm text-brand hover:underline"
          >
            {copied === r.vendor_id
              ? <><Check className="h-3.5 w-3.5" /> Copied</>
              : <><Copy className="h-3.5 w-3.5" /> Copy link</>}
          </button>
        );
      },
    },
  ];

  const quoteColumns: Column<QuoteListRow>[] = [
    {
      key: "rank",
      header: "#",
      render: (r) => (
        <span className="font-mono text-xs font-semibold text-ink">{r.rank_position ?? "—"}</span>
      ),
    },
    { key: "vendor", header: "Vendor", render: (r) => r.vendor_name ?? `Vendor ${r.vendor_id}` },
    {
      key: "total",
      header: "Grand total",
      className: "text-right",
      render: (r) => <span className="font-semibold text-ink">{money(r.grand_total)}</span>,
    },
    {
      key: "revisions",
      header: "Revisions",
      className: "text-right",
      hideOnNarrow: true,
      render: (r) => r.revision_count,
    },
    {
      key: "submitted",
      header: "Submitted",
      hideOnNarrow: true,
      render: (r) => (r.submitted_at ? fmtDate(r.submitted_at) : "—"),
    },
    {
      key: "award",
      header: "",
      render: (r) =>
        rfq?.status === "AWARDED" ? (
          <StatusPill status={r.status} />
        ) : (
          <Can do="rfq.award">
            <Button variant="subtle" disabled={busy} onClick={() => award.mutate(r.id)}>
              Award
            </Button>
          </Can>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title={rfq?.rfq_no ?? "RFQ"}
        actions={
          <>
            <Button variant="subtle" onClick={() => nav("/procurement/rfqs")}>Back</Button>
            {rfq?.status === "DRAFT" && (
              <Can do="rfq.create">
                <Button variant="subtle" onClick={() => nav(`/procurement/rfqs/${rfqId}/edit`)}>
                  Edit
                </Button>
                <Button disabled={busy} onClick={() => submit.mutate()}>
                  Send for approval
                </Button>
              </Can>
            )}
            {rfq?.status === "PENDING_APPROVAL" && (
              <Can do="rfq.approve">
                <Button variant="subtle" disabled={busy} onClick={() => reject.mutate()}>
                  Reject
                </Button>
                <Button disabled={busy} onClick={() => approve.mutate()}>
                  Approve &amp; publish
                </Button>
              </Can>
            )}
            {rfq?.status === "PUBLISHED" && (
              <Can do="rfq.create">
                <Button variant="subtle" disabled={busy} onClick={() => close.mutate()}>
                  Close early
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={error ?? submit.error ?? approve.error ?? reject.error ?? close.error ?? award.error} />

      {rfq && (
        <Card className="mb-4 p-5">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Status</dt>
              <dd className="mt-1"><StatusPill status={rfq.status} /></dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Closes</dt>
              <dd className="mt-1 text-body">{rfq.due_date ? fmtDate(rfq.due_date) : "No deadline"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Replies</dt>
              <dd className="mt-1 text-body">{rfq.response_count} of {rfq.vendor_count}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {rfq.status === "PENDING_APPROVAL" ? "With" : "Awarded to"}
              </dt>
              <dd className="mt-1 text-body">
                {rfq.current_approver_name ?? rfq.awarded_vendor_name ?? "—"}
              </dd>
            </div>
          </dl>
          {rfq.terms && (
            <p className="mt-4 border-t border-line pt-4 text-sm text-body">{rfq.terms}</p>
          )}
        </Card>
      )}

      <h2 className="mb-2 text-sm font-semibold text-ink">Lines</h2>
      <Card className="mb-5 p-2">
        <ResponsiveList
          data={rfq?.items ?? []}
          columns={lineColumns}
          keyOf={(r) => r.id}
          loading={isLoading}
          empty="No lines on this RFQ."
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="text-sm font-medium text-ink">{r.item_name ?? `Item ${r.item_id}`}</div>
              <div className="text-xs text-muted">{r.quantity} {r.uom_code ?? ""}</div>
            </div>
          )}
        />
      </Card>

      <h2 className="mb-2 text-sm font-semibold text-ink">Vendors asked</h2>
      <Card className="mb-5 p-2">
        <ResponsiveList
          data={rfq?.vendors ?? []}
          columns={vendorColumns}
          keyOf={(r) => r.id}
          empty="Nobody has been asked yet."
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="text-sm font-medium text-ink">{r.vendor_name ?? `Vendor ${r.vendor_id}`}</div>
              <div className="text-xs text-muted">
                {r.responded_at ? `Replied ${fmtDate(r.responded_at)}` : "Not replied"}
              </div>
            </div>
          )}
        />
      </Card>

      {published && (
        <>
          <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">Comparison</h2>
              <p className="text-xs text-muted">
                {comparison
                  ? `${comparison.responded} quote${comparison.responded === 1 ? "" : "s"} in, ranked by ${
                      methods?.find((m) => m.value === comparison.evaluation_method)?.label
                      ?? comparison.evaluation_method.replace(/_/g, " ").toLowerCase()}`
                  : "Waiting on quotes"}
              </p>
            </div>
            <div className="w-56">
              <Select
                value={method || comparison?.evaluation_method || ""}
                placeholder="Rank by…"
                options={(methods ?? []).map((m) => ({ value: m.value, label: m.label }))}
                onChange={setMethod}
              />
            </div>
          </div>

          {comparison && comparison.responded > 0 && !comparison.meets_three_quote_norm && (
            <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              Only {comparison.responded} quote{comparison.responded === 1 ? "" : "s"} on
              file. The standard is three — award anyway if this is a single-source item.
            </p>
          )}

          <Card className="p-2">
            <ResponsiveList
              data={comparison?.quotations ?? []}
              columns={quoteColumns}
              keyOf={(r) => r.id}
              empty="No quotations submitted yet."
              renderCard={(r) => (
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-ink">
                      {r.rank_position ? `#${r.rank_position} · ` : ""}{r.vendor_name}
                    </span>
                    <span className="font-semibold text-ink">{money(r.grand_total)}</span>
                  </div>
                  <div className="text-xs text-muted">
                    {r.revision_count} revision{r.revision_count === 1 ? "" : "s"}
                  </div>
                </div>
              )}
            />
          </Card>
        </>
      )}
    </div>
  );
}
