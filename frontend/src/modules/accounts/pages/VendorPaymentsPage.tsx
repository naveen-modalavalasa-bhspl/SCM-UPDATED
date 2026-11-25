import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, X } from "lucide-react";
import {
  Card, PageHeader, ResponsiveList, StatusPill, errorMessage, useToast, type Column,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import { accountsApi, downloadFile } from "../api";
import { DocumentFiles } from "../components/DocumentFiles";
import {
  MilestoneTable, PaymentList, PaymentTotals, money,
} from "../components/PaymentSchedule";
import { RecordPaymentModal } from "../components/RecordPaymentModal";
import { paidPercent } from "../paymentRules";
import {
  STATE_META, type CarrierInvoiceRow, type Milestone, type PayableRow, type PaymentInput,
  type VendorPayment,
} from "../types";

type Tab = "open" | "approvals" | "paid" | "payments" | "carrier";
const TABS: { key: Tab; label: string }[] = [
  { key: "open", label: "To pay" },
  { key: "approvals", label: "Awaiting approval" },
  { key: "paid", label: "Fully paid" },
  { key: "payments", label: "All payments" },
  { key: "carrier", label: "Carrier invoices" },
];
const SIZE = 20;

/**
 * Accounts › Vendor Payments. Every approved PO that carries a payment term, with what
 * it is worth, what has gone out and what is next due. Open one to see its milestones,
 * the supplier's invoices and challans, and to record a payment against a milestone —
 * which then waits on its VENDOR_PAYMENT ladder before it counts as paid, here and on
 * the PO itself.
 */
export function VendorPaymentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "open";
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [openPo, setOpenPo] = useState<number | null>(null);
  const review = Number(params.get("review")) || null;

  useEffect(() => { setPage(1); }, [tab, search]);

  // A notification for a payment lands here with ?review=<payment id>: open its order.
  const reviewed = useQuery({
    queryKey: ["accounts", "payment", review],
    queryFn: () => accountsApi.payment(review!),
    enabled: !!review,
  });
  useEffect(() => { if (reviewed.data) setOpenPo(reviewed.data.po_id); }, [reviewed.data]);

  const payables = useQuery({
    queryKey: ["accounts", "payables", tab, page, search],
    queryFn: () => accountsApi.payables({ tab: tab === "paid" ? "paid" : "open", page,
      size: SIZE, search: search || undefined }),
    enabled: tab === "open" || tab === "paid",
  });
  const payments = useQuery({
    queryKey: ["accounts", "payments", tab, page, search],
    queryFn: () => accountsApi.payments({ page, size: SIZE, search: search || undefined,
      status: tab === "approvals" ? "PENDING_APPROVAL" : undefined }),
    enabled: tab === "approvals" || tab === "payments",
  });
  const carrier = useQuery({
    queryKey: ["accounts", "carrier", page, search],
    queryFn: () => accountsApi.carrierInvoices({ page, size: SIZE, search: search || undefined }),
    enabled: tab === "carrier",
  });

  const poColumns: Column<PayableRow>[] = [
    { key: "po", header: "PO", render: (r) => <span className="font-semibold text-ink">{r.po_no}</span> },
    { key: "vendor", header: "Vendor", render: (r) => r.vendor_name ?? "—" },
    { key: "terms", header: "Payment term", hideOnNarrow: true,
      render: (r) => <span className="line-clamp-2 text-xs text-body">{r.payment_terms ?? "—"}</span> },
    { key: "value", header: "Order value", render: (r) => <span className="tabular-nums">{money(r.total_amount)}</span> },
    { key: "paid", header: "Paid", render: (r) => (
      <div className="min-w-[7rem]">
        <span className="tabular-nums">{money(r.paid)}</span>
        <div className="mt-1 h-1.5 rounded-full bg-content2">
          <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${paidPercent(r)}%` }} />
        </div>
      </div>) },
    { key: "out", header: "Outstanding", render: (r) => <span className="font-semibold tabular-nums">{money(r.outstanding)}</span> },
    { key: "next", header: "Next", render: (r) => r.next_stage && r.next_state ? (
      <div className="space-y-1">
        <div className="text-xs text-body">{r.next_stage}{r.next_due_date ? ` · ${fmtDate(r.next_due_date)}` : ""}</div>
        <StatusPill status={STATE_META[r.next_state].pill} label={STATE_META[r.next_state].label} />
      </div>) : "—" },
    { key: "docs", header: "Invoices", hideOnNarrow: true, render: (r) => r.invoices || "—" },
  ];
  const paymentColumns: Column<VendorPayment>[] = [
    { key: "no", header: "Payment", render: (p) => <span className="font-semibold text-ink">{p.payment_no}</span> },
    { key: "po", header: "PO", render: (p) => p.po_no ?? "—" },
    { key: "vendor", header: "Vendor", render: (p) => p.vendor_name ?? "—" },
    { key: "stage", header: "Milestone", render: (p) => p.stage_label ?? p.stage },
    { key: "amount", header: "Amount", render: (p) => <span className="tabular-nums">{money(p.amount)}</span> },
    { key: "paid_on", header: "Paid on", hideOnNarrow: true, render: (p) => `${fmtDate(p.paid_on)} · ${p.mode}` },
    { key: "proof", header: "Proof", render: (p) => p.proofs.length ? (
      <div className="flex flex-col items-start">
        {p.proofs.map((d) => (
          <button key={d.id} type="button" title={d.file_name}
            className="inline-flex min-h-11 max-w-[12rem] items-center gap-1.5 text-sm font-semibold text-brand"
            onClick={(e) => { e.stopPropagation(); void downloadFile(
              `/api/accounts/payments/${p.id}/proofs/${d.id}/download`, d.file_name); }}>
            <Download className="h-4 w-4 shrink-0" /><span className="truncate">{d.file_name}</span>
          </button>
        ))}
      </div>) : <span className="text-xs text-muted">None</span> },
    { key: "status", header: "Status", render: (p) => (
      <div className="space-y-0.5">
        <StatusPill status={p.status === "PAID" ? "APPROVED" : p.status}
          label={p.status === "PAID" ? "Paid" : undefined} />
        {p.status === "PENDING_APPROVAL" && p.current_approver_name &&
          <div className="text-[11px] text-muted">with {p.current_approver_name}</div>}
      </div>) },
  ];
  const carrierColumns: Column<CarrierInvoiceRow>[] = [
    { key: "tr", header: "Shipment", render: (r) => <span className="font-semibold text-ink">{r.tr_no}</span> },
    { key: "carrier", header: "Carrier", render: (r) => r.carrier_name ?? "—" },
    { key: "freight", header: "Freight", render: (r) => r.freight_amount == null ? "—" : money(r.freight_amount) },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.tr_status} /> },
    { key: "file", header: "Invoice", render: (r) => (
      <button type="button" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-brand"
        onClick={(e) => { e.stopPropagation(); void downloadFile(
          `/api/accounts/carrier-invoices/${r.tr_id}/${r.attachment_id}/download`, r.file_name); }}>
        <Download className="h-4 w-4" />{r.file_name}
      </button>) },
    { key: "at", header: "Filed", hideOnNarrow: true, render: (r) => r.uploaded_at ? fmtDate(r.uploaded_at) : "—" },
  ];

  const active = tab === "carrier" ? carrier : (tab === "open" || tab === "paid") ? payables : payments;
  const total = active.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / SIZE));

  return (
    <div className="space-y-4">
      <PageHeader title="Vendor Payments" />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button key={t.key} type="button"
            onClick={() => { const next = new URLSearchParams(params); next.set("tab", t.key); next.delete("review"); setParams(next); }}
            className={`min-h-11 rounded-full px-4 text-sm font-semibold ${tab === t.key ? "bg-brand text-white" : "bg-content2 text-body hover:bg-brand-050"}`}>
            {t.label}
          </button>
        ))}
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={tab === "carrier" ? "Search shipment or carrier" : "Search PO, vendor or reference"}
          className="ml-auto h-11 w-full rounded-xl border border-line bg-content1 px-3 text-sm sm:w-72" />
      </div>

      {active.error && <p className="text-sm font-semibold text-red-600">{errorMessage(active.error)}</p>}

      {(tab === "open" || tab === "paid") && (
        <ResponsiveList<PayableRow>
          data={payables.data?.items ?? []} columns={poColumns} keyOf={(r) => r.po_id}
          loading={payables.isLoading} onRowClick={(r) => setOpenPo(r.po_id)}
          page={page} totalPages={totalPages} onPageChange={setPage}
          empty={tab === "open" ? "Nothing to pay. Approved orders with a payment term show here." : "No order is fully paid yet."}
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="flex justify-between gap-2"><span className="font-semibold text-ink">{r.po_no}</span><span className="tabular-nums">{money(r.outstanding)}</span></div>
              <div className="text-sm text-body">{r.vendor_name}</div>
              <div className="text-xs text-muted">{r.next_stage ?? "—"}{r.next_due_date ? ` · ${fmtDate(r.next_due_date)}` : ""}</div>
            </div>)} />
      )}
      {(tab === "approvals" || tab === "payments") && (
        <ResponsiveList<VendorPayment>
          data={payments.data?.items ?? []} columns={paymentColumns} keyOf={(p) => p.id}
          loading={payments.isLoading} onRowClick={(p) => setOpenPo(p.po_id)}
          page={page} totalPages={totalPages} onPageChange={setPage}
          empty={tab === "approvals" ? "No payment is waiting for approval." : "No payments recorded yet."}
          renderCard={(p) => (
            <div className="space-y-1">
              <div className="flex justify-between gap-2"><span className="font-semibold text-ink">{p.payment_no}</span><span className="tabular-nums">{money(p.amount)}</span></div>
              <div className="text-sm text-body">{p.vendor_name} · {p.po_no}</div>
              <div className="text-xs text-muted">{p.stage_label} · {p.status === "PAID" ? "Paid" : p.status.replace(/_/g, " ").toLowerCase()}</div>
              {p.proofs.map((d) => (
                <button key={d.id} type="button"
                  className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-brand"
                  onClick={(e) => { e.stopPropagation(); void downloadFile(
                    `/api/accounts/payments/${p.id}/proofs/${d.id}/download`, d.file_name); }}>
                  <Download className="h-4 w-4" />{d.file_name}
                </button>
              ))}
            </div>)} />
      )}
      {tab === "carrier" && (
        <ResponsiveList<CarrierInvoiceRow>
          data={carrier.data?.items ?? []} columns={carrierColumns}
          keyOf={(r) => r.attachment_id} loading={carrier.isLoading}
          page={page} totalPages={totalPages} onPageChange={setPage}
          empty="No carrier has filed an invoice yet."
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="flex justify-between gap-2"><span className="font-semibold text-ink">{r.tr_no}</span>{r.freight_amount != null && <span>{money(r.freight_amount)}</span>}</div>
              <div className="text-sm text-body">{r.carrier_name}</div>
              <button type="button" className="min-h-11 text-sm font-semibold text-brand"
                onClick={() => void downloadFile(`/api/accounts/carrier-invoices/${r.tr_id}/${r.attachment_id}/download`, r.file_name)}>
                {r.file_name}
              </button>
            </div>)} />
      )}

      {openPo != null && <PoPaymentsDrawer poId={openPo} onClose={() => {
        setOpenPo(null);
        if (review) { const next = new URLSearchParams(params); next.delete("review"); setParams(next); }
      }} />}
    </div>
  );
}

/** One order's money, opened from any tab. */
function PoPaymentsDrawer({ poId, onClose }: { poId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [paying, setPaying] = useState<Milestone | null>(null);
  const detail = useQuery({ queryKey: ["accounts", "po", poId], queryFn: () => accountsApi.po(poId) });
  const meta = useQuery({ queryKey: ["accounts", "meta"], queryFn: accountsApi.meta, staleTime: Infinity });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["po-payments", poId] });
  };
  const record = useMutation({
    mutationFn: async ({ body, proofs }: { body: PaymentInput; proofs: File[] }) => {
      const p = await accountsApi.record(body);
      // The payment is saved first; a proof that fails to upload is said out loud,
      // never allowed to undo a payment that has already been recorded.
      const failed: string[] = [];
      for (const file of proofs) {
        try { await accountsApi.addProof(p.id, file); }
        catch (e) { failed.push(`${file.name}: ${errorMessage(e)}`); }
      }
      return { p, failed };
    },
    onSuccess: ({ p, failed }) => {
      setPaying(null); refresh();
      toast.success(p.status === "PAID" ? `${p.payment_no} recorded and approved`
        : `${p.payment_no} recorded — waiting for approval`);
      if (failed.length) toast.error(`Proof not attached — ${failed.join("; ")}`);
    },
  });
  const act = useMutation({
    mutationFn: ({ p, action, remarks }: { p: VendorPayment; action: "APPROVE" | "REJECT"; remarks?: string }) =>
      accountsApi.act(p.id, action, remarks),
    onSuccess: (p) => { refresh(); toast.success(`${p.payment_no} ${p.status === "PAID" ? "approved — paid" : p.status.toLowerCase().replace(/_/g, " ")}`); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const data = detail.data;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-3xl overflow-y-auto bg-background p-4 shadow-xl sm:p-6"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-ink">{data?.po_no ?? "Loading…"}</h2>
            {data && <p className="text-sm text-muted">{data.vendor_name}{data.project_name ? ` · ${data.project_name}` : ""} · <StatusPill status={data.po_status} /></p>}
          </div>
          <button type="button" aria-label="Close" onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-content2"><X className="h-5 w-5" /></button>
        </div>
        {detail.error && <p className="text-sm font-semibold text-red-600">{errorMessage(detail.error)}</p>}
        {data && (
          <div className="space-y-5">
            <PaymentTotals data={data} />
            {data.payment_terms && <p className="text-sm text-body">{data.payment_terms}</p>}
            <Card className="space-y-3 p-4">
              <h3 className="text-sm font-semibold text-ink">Milestones</h3>
              <MilestoneTable milestones={data.milestones}
                onPay={can("accounts.pay") ? setPaying : undefined} />
            </Card>
            <Card className="space-y-3 p-4">
              <h3 className="text-sm font-semibold text-ink">Payments</h3>
              <PaymentList payments={data.payments} onAct={(p, action) => {
                const remarks = action === "REJECT"
                  ? window.prompt(`Why is ${p.payment_no} rejected?`) ?? "" : undefined;
                if (action === "REJECT" && !remarks?.trim()) return;
                act.mutate({ p, action, remarks });
              }} />
            </Card>
            <Card className="space-y-3 p-4">
              <h3 className="text-sm font-semibold text-ink">Supplier invoices & delivery challans</h3>
              <DocumentFiles queryKey={["accounts", "po-docs", poId]} initial={data.documents}
                emptyText="The supplier has not uploaded an invoice or DC on this order."
                endpoints={{ list: async () => data.documents,
                  downloadUrl: (id) => `/api/accounts/pos/${poId}/documents/${id}/download` }} />
            </Card>
          </div>
        )}
        {data && (
          <RecordPaymentModal poId={poId} poNo={data.po_no} po={data} milestone={paying}
            modes={meta.data?.modes ?? ["NEFT", "RTGS", "IMPS", "UPI", "CHEQUE", "DD", "CASH"]}
            invoices={data.documents.filter((d) => d.doc_category === "INVOICE")}
            saving={record.isPending} error={record.error}
            onClose={() => { setPaying(null); record.reset(); }}
            onSave={(body, proofs) => record.mutate({ body, proofs })} />
        )}
      </div>
    </div>
  );
}
