import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FilePen, Save } from "lucide-react";
import { ErrorBanner, Field, Input, Select, useToast } from "@/shared/components";
import { Button } from "./ActionButton";
import { api } from "@/shared/api/client";
import { todayIst } from "@/shared/datetime";
import { poApi } from "../api";
import type { PurchaseOrder } from "../types";
import { LinePicker, type DraftLine } from "./LinePicker";
import {
  POHeaderFields, poHeaderFrom, poHeaderPayload, poMissingAddresses, type POHeaderValue,
} from "./POHeaderFields";

interface MasterVendor {
  id: number;
  code?: string | null;
  name: string;
}

const money = (value: number) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

/**
 * The raiser's full edit of a PO that was sent back to them: every field the create
 * form asks for — vendor, expected date, the lines (item, quantity, rate, tax; add and
 * remove) and the header block. Saved in one press; Resubmit is on the banner above.
 *
 * The vendor is locked on an order written off a quotation: the vendor IS the quote,
 * and the server refuses a change there too.
 *
 * `mode="draft"` is the same edit on a DRAFT order (2026-10-19) — same fields, same
 * rules, saved through `PUT /api/pos/{id}/draft` instead of the correction route.
 */
export function POCorrectionForm({ po, onSaved, mode = "correction" }: {
  po: PurchaseOrder; onSaved: () => void; mode?: "correction" | "draft";
}) {
  const toast = useToast();
  const vendorLocked = Boolean(po.quotation_no);
  const [vendorId, setVendorId] = useState(String(po.vendor_id ?? ""));
  const [expectedDate, setExpectedDate] = useState(po.expected_date ?? "");
  const [header, setHeader] = useState<POHeaderValue>(poHeaderFrom(po));
  const [problem, setProblem] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>(() =>
    (po.items ?? []).map((i: any) => ({
      id: i.id,
      item_id: i.item_id,
      item_code: i.item_code,
      item_name: i.item_name,
      uom_code: i.uom_code,
      quantity: String(i.quantity),
      rate: String(i.rate),
      tax_percent: String(i.tax_percent ?? 0),
    })),
  );

  const { data: vendors = [] } = useQuery({
    queryKey: ["po-vendors"],
    queryFn: () =>
      api.get<{ items: MasterVendor[] }>("/api/vendors", {
        params: { size: 200, is_active: true, kind: "MATERIAL" },
      }).then((r) => r.data.items),
  });
  // The current vendor may sit outside the first page of the master; keep it listed.
  const vendorOptions = useMemo(() => {
    const options = vendors.map((v) => ({
      value: String(v.id), label: v.code ? `${v.code} — ${v.name}` : v.name,
    }));
    if (po.vendor_id && !options.some((o) => o.value === String(po.vendor_id))) {
      options.unshift({ value: String(po.vendor_id), label: po.vendor_name ?? `Vendor ${po.vendor_id}` });
    }
    return options;
  }, [vendors, po.vendor_id, po.vendor_name]);

  const totals = useMemo(() => {
    let sub = 0;
    let tax = 0;
    for (const line of lines) {
      const amount = Number(line.quantity || 0) * Number(line.rate || 0);
      sub += amount;
      tax += (amount * Number(line.tax_percent || 0)) / 100;
    }
    const discount = Number(header.discount || 0);
    const freight = Number(header.freight || 0);
    return { sub, tax, discount, freight, grand: sub - discount + tax + freight };
  }, [lines, header.discount, header.freight]);

  const save = useMutation({
    mutationFn: () =>
      (mode === "draft" ? poApi.editDraft : poApi.correct)(po.id, {
        vendor_id: vendorLocked ? null : Number(vendorId),
        expected_date: expectedDate || null,
        ...poHeaderPayload(header),
        lines: lines
          .filter((line) => line.item_id !== "" && Number(line.quantity) > 0)
          .map((line) => ({
            id: line.id ?? null,
            item_id: Number(line.item_id),
            quantity: Number(line.quantity),
            rate: Number(line.rate || 0),
            tax_percent: Number(line.tax_percent || 0),
          })),
      }),
    onSuccess: () => {
      toast.success(mode === "draft"
        ? "Draft saved — send it for approval when it is ready"
        : "PO corrected — resubmit it when ready");
      onSaved();
    },
  });

  const submit = () => {
    if (!vendorId) return setProblem("Choose the vendor this order goes to.");
    if (!lines.some((line) => line.item_id !== "" && Number(line.quantity) > 0))
      return setProblem("Add at least one line with an item and a quantity.");
    if (totals.discount > totals.sub) return setProblem("The discount is more than the order sub-total.");
    const missingAddress = poMissingAddresses(header);
    if (missingAddress) return setProblem(missingAddress);
    setProblem(null);
    save.mutate();
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white shadow-sm">
      <div className="h-1 w-full bg-gradient-to-r from-indigo-500 to-violet-500" />
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2 text-indigo-700">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-600 text-white"><FilePen className="h-4 w-4" /></div>
          <h2 className="text-sm font-extrabold uppercase tracking-widest">
            {mode === "draft" ? "Edit draft" : "Edit purchase order"}
          </h2>
        </div>
        <ErrorBanner error={save.error} />
        {problem && <ErrorBanner error={problem} />}

        <div className="grid grid-cols-1 gap-4 rounded-xl bg-white p-3 ring-1 ring-indigo-100 sm:grid-cols-2">
          <Field label="Vendor" required>
            <Select
              value={vendorId}
              placeholder="Search vendors…"
              options={vendorOptions}
              isDisabled={vendorLocked}
              onChange={(value) => setVendorId(String(value))}
            />
            {vendorLocked && (
              <p className="mt-1 text-xs text-muted">Locked — this order was written off quotation {po.quotation_no}.</p>
            )}
          </Field>
          <Field label="Expected delivery">
            <Input type="date" min={todayIst()} value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
          </Field>
        </div>

        <div className="rounded-xl bg-white p-3 ring-1 ring-indigo-100">
          <h3 className="mb-3 text-sm font-semibold text-ink">What is being ordered</h3>
          <LinePicker lines={lines} onChange={setLines} showRate showTax showDate={false} />
        </div>

        <div className="rounded-xl bg-white p-3 ring-1 ring-indigo-100">
          <POHeaderFields value={header} onChange={(patch) => setHeader({ ...header, ...patch })} />
        </div>

        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-white p-3 text-sm ring-1 ring-indigo-100 sm:grid-cols-5">
          {[
            ["Subtotal", totals.sub], ["Discount", totals.discount], ["Tax", totals.tax],
            ["Freight", totals.freight], ["Order total", totals.grand],
          ].map(([label, value]) => (
            <div key={label as string}>
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="mt-1 font-semibold text-ink">{money(value as number)}</dd>
            </div>
          ))}
        </dl>

        <div className="flex justify-end">
          <Button disabled={save.isPending} onClick={submit}>
            <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
