import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BellRing, PackageCheck, Signature } from "lucide-react";
import {
  Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader,
  ResponsiveList, Select, StatCard, useAction, type Column,
} from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { transportApi } from "../api";
import { load, modeLabel, modeTint } from "../components/modeCopy";
import type { TRListRow } from "../transportTypes";

const SIZE = 20;

const CONDITIONS = [
  { value: "GOOD", label: "Received in good condition" },
  { value: "SHORT", label: "Short — something is missing" },
  { value: "DAMAGED", label: "Damaged in transit" },
];

/**
 * Landed, and nobody has signed for it (doc A6-A7).
 *
 * The last mile of the whole chain and the one that goes missing: the carrier says
 * delivered, the indent stays open, and three weeks later nobody can say whether the
 * site ever got it. This screen is that chase list, and the signature is taken from
 * the row rather than four clicks into the shipment — an acknowledgement desk works
 * down a list, and making each one a navigation is how it stops happening.
 *
 * "Days waiting" is the column the desk sorts its morning by. Short or damaged raises
 * a claim against the provider on the same shipment timeline.
 */
export function AcknowledgementsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [signing, setSigning] = useState<TRListRow | null>(null);
  const [form, setForm] = useState({
    acknowledged_by_name: "", condition: "GOOD", remarks: "", pod_url: "",
    affected_item_name: "", affected_qty: "", claim_amount: "",
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport", "acknowledgements", search, page],
    queryFn: () => transportApi.acknowledgements({
      search: search.trim() || undefined, page, size: SIZE,
    }),
  });

  const acknowledge = useAction({
    run: () => transportApi.acknowledge(signing!.id, {
      acknowledged_by_name: form.acknowledged_by_name || null,
      condition: form.condition,
      remarks: form.remarks || null,
      pod_url: form.pod_url || null,
      affected_item_name: form.affected_item_name || null,
      affected_qty: form.affected_qty ? Number(form.affected_qty) : null,
      claim_amount: form.claim_amount ? Number(form.claim_amount) : null,
    }),
    success: "Acknowledged",
    invalidates: [["transport"], ["transport-exceptions"]],
    onDone: () => {
      setSigning(null);
      setForm({
        acknowledged_by_name: "", condition: "GOOD", remarks: "", pod_url: "",
        affected_item_name: "", affected_qty: "", claim_amount: "",
      });
    },
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));
  const isClaim = form.condition !== "GOOD";

  /** Whole days since it landed. The number the chase is prioritised by. */
  const waitingDays = (row: TRListRow) => {
    const landed = row.delivered_at ?? row.dispatched_at;
    if (!landed) return 0;
    const ms = Date.now() - new Date(landed).getTime();
    return Math.max(0, Math.floor(ms / 86_400_000));
  };
  const overdue = rows.filter((row) => waitingDays(row) >= 2).length;
  const untold = rows.filter((row) => !row.tracking_shared_at).length;

  const columns: Column<TRListRow>[] = [
    {
      key: "tr",
      header: "Consignment",
      render: (row) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{row.tr_no}</div>
          <div className="text-[11px] text-muted">
            {row.consignment_no ?? row.indent_no ?? fmtDate(row.tr_date)}
          </div>
        </div>
      ),
    },
    { key: "to", header: "Site", render: (row) => row.to_location_name ?? "—" },
    {
      key: "landed",
      header: "Landed",
      render: (row) => (
        <div className="text-sm">
          <div className="text-body">{fmtDateTime(row.delivered_at)}</div>
          <div className="text-[11px] text-muted">
            {row.carrier_name ?? modeLabel(row.mode)}
          </div>
        </div>
      ),
    },
    {
      key: "waiting",
      header: "Waiting",
      className: "text-right",
      render: (row) => {
        const days = waitingDays(row);
        return (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            days >= 2
              ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
              : "bg-content2 text-body"
          }`}>
            {days === 0 ? "today" : `${days}d`}
          </span>
        );
      },
    },
    {
      key: "told",
      header: "Field told",
      hideOnNarrow: true,
      render: (row) => (row.tracking_shared_at
        ? <span className="text-xs text-muted">{fmtDate(row.tracking_shared_at)}</span>
        : <span className="text-xs font-semibold text-amber-600">Not yet</span>),
    },
    {
      key: "load",
      header: "Load",
      hideOnNarrow: true,
      className: "text-right",
      render: (row) => (
        <span className="text-sm text-body">
          {load(row.total_packages, row.total_weight_kg)}
        </span>
      ),
    },
    {
      key: "act",
      header: "",
      className: "text-right",
      render: (row) => (
        <Can do="transport.acknowledge">
          <Button onClick={() => setSigning(row)}>Sign for it</Button>
        </Can>
      ),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Logistics" title="Acknowledgements" />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Waiting for a signature"
          value={data?.total ?? 0}
          icon={<Signature className="h-4 w-4" />}
        />
        <StatCard
          label="Two days or more"
          value={overdue}
          tone={overdue ? "text-bad" : "text-ink"}
          icon={<BellRing className="h-4 w-4" />}
        />
        <StatCard
          label="Field never told"
          value={untold}
          tone={untold ? "text-amber-600" : "text-ink"}
          icon={<PackageCheck className="h-4 w-4" />}
        />
      </div>

      <div className="mb-4 max-w-xs">
        <Input
          value={search}
          placeholder="TR no, consignment, site…"
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      <ErrorBanner error={error ?? acknowledge.error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(row) => row.id}
          loading={isLoading}
          onRowClick={(row) => nav(`/logistics/transport/${row.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty="Everything delivered has been signed for."
          renderCard={(row) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">
                  {row.tr_no}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${modeTint(row.mode)}`}>
                  {modeLabel(row.mode)}
                </span>
              </div>
              <div className="text-sm text-body">{row.to_location_name ?? "—"}</div>
              <div className="text-xs text-muted">
                Landed {fmtDateTime(row.delivered_at)} · waiting {waitingDays(row)}d
              </div>
            </div>
          )}
        />
      </Card>

      <ConfirmModal
        isOpen={Boolean(signing)}
        title={`Acknowledge ${signing?.tr_no ?? ""}`}
        message="What the site actually found. Short or damaged raises a claim against the provider."
        confirmLabel="Sign for it"
        busy={acknowledge.isPending}
        confirmDisabled={isClaim && !form.remarks.trim()}
        onConfirm={() => acknowledge.mutate()}
        onClose={() => setSigning(null)}
      >
        <div className="space-y-3">
          <Field label="Who received it">
            <Input value={form.acknowledged_by_name}
              onChange={(e) => setForm({ ...form, acknowledged_by_name: e.target.value })} />
          </Field>
          <Field label="Condition">
            <Select value={form.condition} options={CONDITIONS}
              onChange={(value) => setForm({ ...form, condition: value })} />
          </Field>
          <Field label={isClaim ? "What was wrong (required)" : "Note"}>
            <Input value={form.remarks}
              onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </Field>
          {isClaim && (
            <>
              <Field label="Item affected">
                <Input value={form.affected_item_name}
                  onChange={(e) => setForm({ ...form, affected_item_name: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Qty">
                  <Input type="number" value={form.affected_qty}
                    onChange={(e) => setForm({ ...form, affected_qty: e.target.value })} />
                </Field>
                <Field label="Claim value">
                  <Input type="number" value={form.claim_amount}
                    onChange={(e) => setForm({ ...form, claim_amount: e.target.value })} />
                </Field>
              </div>
            </>
          )}
          <Field label="Signed acknowledgement link" hint="Optional — a scan or a photo">
            <Input value={form.pod_url}
              onChange={(e) => setForm({ ...form, pod_url: e.target.value })} />
          </Field>
        </div>
      </ConfirmModal>
    </div>
  );
}
