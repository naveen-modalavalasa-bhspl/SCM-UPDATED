import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { Card, ErrorBanner, Field, FormActions, Input, PageHeader, Select, useToast } from "@/shared/components";
import { Button } from "../components/ActionButton";
import { api } from "@/shared/api/client";
import { fmtDate, todayIst } from "@/shared/datetime";
import { poApi } from "../api";
import { blankLine, LinePicker, type DraftLine } from "../components/LinePicker";
import {
  blankPOHeader, POHeaderFields, poHeaderPayload, poMissingAddresses, type POHeaderValue,
} from "../components/POHeaderFields";
import type { POCopyTemplate } from "../types";
import { money } from "./RequisitionListPage";
import { toPayload } from "@/shared/packing";
import { comboFrom, comboPayload } from "@/shared/combination";

/** A copy template in the shape this form edits. */
function headerFromCopy(t: POCopyTemplate): POHeaderValue {
  return {
    projectId: t.project_id ?? "",
    remarks: t.remarks ?? "",
    paymentTermId: t.payment_term_id ?? "",
    payment_terms: t.payment_terms ?? "",
    delivery_terms: t.delivery_terms ?? "",
    material_terms: t.material_terms ?? "",
    logistics_terms: t.logistics_terms ?? "",
    billing_address: t.billing_address ?? "",
    shipping_address: t.shipping_address ?? "",
    discount: t.discount_amount ? String(t.discount_amount) : "",
    freight: t.freight_amount ? String(t.freight_amount) : "",
  };
}

const linesFromCopy = (t: POCopyTemplate): DraftLine[] => t.lines.length
  ? t.lines.map((line) => ({
    item_id: line.item_id, item_code: line.item_code, item_name: line.item_name,
    uom_code: line.uom_code, quantity: String(line.quantity), rate: String(line.rate),
    tax_percent: String(line.tax_percent),
    combo: comboFrom(line),
  }))
  : [blankLine()];

interface MasterVendor {
  id: number;
  code?: string | null;
  name: string;
}

/**
 * Raise a purchase order by hand.
 *
 * The chain normally writes this document for you — an indent asks, a tender answers,
 * and the award becomes the order with the winning vendor's own rates on it. That path
 * is still the one to prefer, and the screen says so.
 *
 * But not every purchase begins as a demand note: a repeat order on an agreed rate, an
 * emergency buy, a service already being performed. Those were being entered as fake
 * indents, which put a request into the approval chain that nobody had actually made.
 * An order raised here carries no backward pointer, and that absence is what tells a
 * reader later that it was typed rather than derived.
 *
 * `?copyFrom=<id>` opens it pre-filled from an existing order ("Copy as new PO"). The
 * server cleans that content against today's masters first; the save is still the
 * ordinary create, so the number is only drawn when the buyer presses Raise.
 */
export function POFormPage() {
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const copyFrom = Number(params.get("copyFrom")) || null;

  const [vendorId, setVendorId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [problem, setProblem] = useState<string | null>(null);
  // Project, remarks, the four terms, the two addresses and the document money. One
  // block, shared with the draft-order editor so both screens ask the same questions.
  const [header, setHeader] = useState<POHeaderValue>(blankPOHeader());

  // Never served from cache: a copy must reflect the masters as they are now.
  const copy = useQuery({
    queryKey: ["po-copy", copyFrom],
    queryFn: () => poApi.copyTemplate(copyFrom as number),
    enabled: copyFrom !== null,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  // Filled once per source. Applying on every refetch would overwrite what the buyer
  // has typed since.
  const [appliedFrom, setAppliedFrom] = useState<number | null>(null);
  useEffect(() => {
    const t = copy.data;
    if (!t || appliedFrom === t.source_po_id) return;
    setVendorId(t.vendor_id ? String(t.vendor_id) : "");
    setExpectedDate(t.expected_date ?? "");
    setLines(linesFromCopy(t));
    setHeader(headerFromCopy(t));
    setAppliedFrom(t.source_po_id);
  }, [copy.data, appliedFrom]);
  const copied = copy.data && appliedFrom === copy.data.source_po_id ? copy.data : null;

  // One page, filtered in the box: the Select is an autocomplete over the options it
  // holds, so a server round-trip per keystroke would only make it slower.
  const { data: vendors = [] } = useQuery({
    queryKey: ["po-vendors"],
    queryFn: () =>
      // Material suppliers only. The vendor master holds the logistics partners too —
      // a carrier IS a vendor — but a purchase order for goods is never placed on a
      // courier, and the transport leg has its own document.
      api.get<{ items: MasterVendor[] }>("/api/vendors", {
        params: { size: 200, is_active: true, kind: "MATERIAL" },
      }).then((r) => r.data.items),
  });
  // The copied vendor may sit outside the one page of the master the Select holds;
  // without its own option the box would render empty while a vendor is chosen.
  const vendorOptions = useMemo(() => {
    const options = vendors.map((v) => ({
      value: String(v.id), label: v.code ? `${v.code} — ${v.name}` : v.name,
    }));
    if (copied?.vendor_id && !vendors.some((v) => v.id === copied.vendor_id)) {
      options.unshift({ value: String(copied.vendor_id), label: copied.vendor_name ?? "" });
    }
    return options;
  }, [vendors, copied]);

  // Shown as it is typed, and computed exactly as the server computes it:
  // total = sub-total - discount + tax + freight. An order is a commitment to a
  // number, and a buyer should not have to save one to find out what it came to.
  const totals = useMemo(() => {
    let sub = 0;
    let tax = 0;
    for (const line of lines) {
      const amount = Number(line.quantity || 0) * Number(line.rate || 0);
      sub += amount;
      tax += (amount * Number(line.tax_percent || 0)) / 100;
    }
    const discountValue = Number(header.discount || 0);
    const freightValue = Number(header.freight || 0);
    return {
      sub, tax, discount: discountValue, freight: freightValue,
      grand: sub - discountValue + tax + freightValue,
    };
  }, [lines, header.discount, header.freight]);

  const save = useMutation({
    mutationFn: () =>
      poApi.create({
        vendor_id: Number(vendorId),
        expected_date: expectedDate || null,
        ...poHeaderPayload(header),
        lines: lines
          .filter((line) => line.item_id !== "" && Number(line.quantity) > 0)
          .map((line) => ({
            item_id: Number(line.item_id),
            quantity: Number(line.quantity),
            rate: Number(line.rate || 0),
            tax_percent: Number(line.tax_percent || 0),
            pack_hierarchy_id: line.pack_hierarchy_id ?? null,
            pack_breakdown: line.pack_breakdown?.length ? toPayload(line.pack_breakdown) : null,
            ...comboPayload(line.combo),
          })),
        copied_from_po_id: copied?.source_po_id ?? null,
      }),
    onSuccess: (po) => {
      queryClient.invalidateQueries({ queryKey: ["pos"] });
      toast.success(copied
        ? `${po.po_no} raised as a copy of ${copied.source_po_no} — send it for approval when it is ready`
        : `${po.po_no} raised — send it for approval when it is ready`);
      nav(`/pos/${po.id}`);
    },
  });

  // Said on click, in a banner: a button greyed out for a reason the screen does not
  // state is indistinguishable from a broken one.
  const submit = () => {
    if (!vendorId) {
      setProblem("Choose the vendor this order goes to.");
      return;
    }
    if (!lines.some((line) => line.item_id !== "" && Number(line.quantity) > 0)) {
      setProblem("Add at least one line with an item and a quantity.");
      return;
    }
    if (totals.discount > totals.sub) {
      setProblem("The discount is more than the order sub-total.");
      return;
    }
    // BUG_SCM_016 — the server refuses these too; said here first, by name.
    const missingAddress = poMissingAddresses(header);
    if (missingAddress) {
      setProblem(missingAddress);
      return;
    }
    setProblem(null);
    save.mutate();
  };

  return (
    <div>
      <PageHeader
        back={{ to: "/pos", label: "Back to Purchase orders" }} eyebrow="Procurement"
        title={copyFrom ? "New purchase order (copy)" : "New purchase order"} />

      <ErrorBanner error={save.error} />
      {problem && <ErrorBanner error={problem} />}
      {copy.error && (
        <div className="mb-4 space-y-2">
          <ErrorBanner error={copy.error} />
          <Button variant="subtle" onClick={() => nav("/pos/new", { replace: true })}>
            Start a blank purchase order instead
          </Button>
        </div>
      )}

      {copyFrom && copy.isLoading ? (
        <Card className="p-8 text-center text-sm text-muted">Copying the order…</Card>
      ) : copyFrom && copy.error ? null : (
      <Card className="space-y-5 p-5">
        {copied ? (
          <div className="space-y-2 rounded-lg border border-brand/30 bg-brand-050 px-3 py-2 text-sm text-body">
            <p className="flex items-center gap-2 font-semibold text-ink">
              <Copy className="h-4 w-4 text-brand" />
              Copied from {copied.source_po_no} — review everything, then raise it.
            </p>
            <p className="text-xs">
              A new PO number is given when you raise it; {copied.source_po_no} is not changed.
              Rates are from {fmtDate(copied.source_po_date)} — check they are still current.
              Indent and quotation links are not copied.
            </p>
            {copied.warnings.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs font-medium text-warn">
                {copied.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-body">
            Raised by hand, with no indent or quotation behind it. Where a tender exists,
            award it and create the order from the winning quote instead — the rates and
            tax then come from the offer rather than from typing.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Vendor" required>
            <Select
              value={vendorId}
              placeholder="Search vendors…"
              options={vendorOptions}
              onChange={(value) => setVendorId(String(value))}
            />
          </Field>
          <Field label="Expected delivery">
            <Input
              type="date"
              /* Matches the server guard on POCreate.expected_date. */
              min={todayIst()}
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
            />
          </Field>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-ink">What is being ordered</h2>
          <LinePicker lines={lines} onChange={setLines} showRate showTax showDate={false}
                      showPacking />
        </div>

        {/* Project, remarks, addresses, terms and the document money — the same block
          * the draft-order editor shows, so an order says the same things however it
          * was raised. */}
        <div className="border-t border-line pt-4">
          <POHeaderFields
            value={header}
            orderTotal={totals.grand}
            onChange={(patch) => setHeader({ ...header, ...patch })}
          />
        </div>

        {/* Valuation. Sub-total and tax are the sum of the lines; discount and freight
          * come from the block above. */}
        <div className="border-t border-line pt-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">Valuation</h2>
          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
            <div>
              <dt className="text-xs text-muted">Subtotal</dt>
              <dd className="mt-1 text-body">{money(totals.sub)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Discount</dt>
              <dd className="mt-1 text-body">{money(totals.discount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Tax</dt>
              <dd className="mt-1 text-body">{money(totals.tax)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Freight</dt>
              <dd className="mt-1 text-body">{money(totals.freight)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Order total</dt>
              <dd className="mt-1 font-semibold text-ink">{money(totals.grand)}</dd>
            </div>
          </dl>
        </div>

        <FormActions>
          <Button variant="subtle" onClick={() => nav("/pos")}>Cancel</Button>
          <Button disabled={save.isPending} onClick={submit}>
            {save.isPending ? "Raising…" : "Raise purchase order"}
          </Button>
        </FormActions>
      </Card>
      )}
    </div>
  );
}
