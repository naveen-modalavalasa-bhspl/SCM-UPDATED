import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, ErrorBanner, Field, FormActions, Input, PageHeader, Select, useToast,
} from "@/shared/components";
import { api } from "@/shared/api/client";
import { poApi } from "../api";
import { blankLine, LinePicker, type DraftLine } from "../components/LinePicker";
import { money } from "./RequisitionListPage";

interface MasterVendor {
  id: number;
  code?: string | null;
  name: string;
}

interface MasterProject {
  id: number;
  code?: string | null;
  name: string;
}

/** Long text on the order: a term is what was agreed with THIS vendor, so it is typed
 *  rather than picked. Local to this module — `@/shared/components` has no textarea,
 *  and only the lead edits shared. */
function LongText({
  label, hint, value, onChange, rows = 3,
}: {
  label: string; hint?: string; value: string;
  onChange: (v: string) => void; rows?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line bg-content1 p-3 text-sm text-ink"
      />
    </Field>
  );
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
 */
export function POFormPage() {
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [vendorId, setVendorId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [problem, setProblem] = useState<string | null>(null);

  // The terms and the two addresses. One state object rather than ten `useState`s:
  // they are one block on the document and they are saved together.
  const [terms, setTerms] = useState({
    payment_terms: "", delivery_terms: "", material_terms: "", logistics_terms: "",
    billing_address: "", shipping_address: "",
  });
  const setTerm = (key: keyof typeof terms) => (value: string) =>
    setTerms((current) => ({ ...current, [key]: value }));

  // Document money — applied to the order, never spread across lines, because
  // spreading them would rewrite rates the vendor quoted.
  const [discount, setDiscount] = useState("");
  const [freight, setFreight] = useState("");

  // One page, filtered in the box: the Select is an autocomplete over the options it
  // holds, so a server round-trip per keystroke would only make it slower.
  const { data: vendors = [] } = useQuery({
    queryKey: ["po-vendors"],
    queryFn: () =>
      api.get<{ items: MasterVendor[] }>("/api/vendors", {
        params: { size: 200, is_active: true },
      }).then((r) => r.data.items),
  });

  const { data: projects = [] } = useQuery({
    queryKey: ["po-projects"],
    queryFn: () =>
      api.get<{ items: MasterProject[] }>("/api/projects", {
        params: { size: 200, is_active: true },
      }).then((r) => r.data.items),
  });

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
    const discountValue = Number(discount || 0);
    const freightValue = Number(freight || 0);
    return {
      sub, tax, discount: discountValue, freight: freightValue,
      grand: sub - discountValue + tax + freightValue,
    };
  }, [lines, discount, freight]);

  const save = useMutation({
    mutationFn: () =>
      poApi.create({
        vendor_id: Number(vendorId),
        project_id: projectId ? Number(projectId) : null,
        expected_date: expectedDate || null,
        remarks: remarks || null,
        ...terms,
        discount_amount: Number(discount || 0),
        freight_amount: Number(freight || 0),
        lines: lines
          .filter((line) => line.item_id !== "" && Number(line.quantity) > 0)
          .map((line) => ({
            item_id: Number(line.item_id),
            quantity: Number(line.quantity),
            rate: Number(line.rate || 0),
            tax_percent: Number(line.tax_percent || 0),
          })),
      }),
    onSuccess: (po) => {
      queryClient.invalidateQueries({ queryKey: ["pos"] });
      toast.success(`${po.po_no} raised — send it for approval when it is ready`);
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
    setProblem(null);
    save.mutate();
  };

  return (
    <div>
      <PageHeader eyebrow="Procurement" title="New purchase order" />

      <ErrorBanner error={save.error} />
      {problem && <ErrorBanner error={problem} />}

      <Card className="space-y-5 p-5">
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-body">
          Raised by hand, with no indent or quotation behind it. Where a tender exists,
          award it and create the order from the winning quote instead — the rates and
          tax then come from the offer rather than from typing.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Vendor">
            <Select
              value={vendorId}
              placeholder="Search vendors…"
              options={vendors.map((v) => ({
                value: String(v.id), label: v.code ? `${v.code} — ${v.name}` : v.name,
              }))}
              onChange={(value) => setVendorId(String(value))}
            />
          </Field>
          <Field label="Project" hint="What the spend is booked against.">
            <Select
              value={projectId}
              placeholder="Not stated"
              options={projects.map((p) => ({
                value: String(p.id), label: p.code ? `${p.code} — ${p.name}` : p.name,
              }))}
              onChange={(value) => setProjectId(String(value))}
            />
          </Field>
          <Field label="Expected delivery">
            <Input
              type="date"
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
            />
          </Field>
        </div>

        <LongText
          label="Remarks"
          hint="Anything the order should say that no other field covers."
          value={remarks}
          onChange={setRemarks}
          rows={2}
        />

        <div>
          <h2 className="mb-3 text-sm font-semibold text-ink">What is being ordered</h2>
          <LinePicker lines={lines} onChange={setLines} showRate showTax showDate={false} />
        </div>

        {/* Where the goods are invoiced and where they land. Two different places more
          * often than not, which is why they are two fields and not one. */}
        <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <LongText label="Billing address" value={terms.billing_address}
            onChange={setTerm("billing_address")} />
          <LongText label="Shipping address" value={terms.shipping_address}
            onChange={setTerm("shipping_address")} />
        </div>

        <div className="border-t border-line pt-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">Terms and conditions</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <LongText label="Payment terms" value={terms.payment_terms}
              onChange={setTerm("payment_terms")} />
            <LongText label="Delivery terms" value={terms.delivery_terms}
              onChange={setTerm("delivery_terms")} />
            <LongText label="Material terms" value={terms.material_terms}
              onChange={setTerm("material_terms")} />
            <LongText label="Logistics terms" value={terms.logistics_terms}
              onChange={setTerm("logistics_terms")} />
          </div>
        </div>

        {/* Valuation. The sub-total and the tax are the sum of the lines and are read
          * only; discount and freight belong to the ORDER, so they are typed here. */}
        <div className="border-t border-line pt-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">Valuation</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Discount" hint="Off the whole order, before tax is added.">
              <Input type="number" min="0" step="0.01" value={discount}
                placeholder="0.00"
                onChange={(e) => setDiscount(e.target.value)} />
            </Field>
            <Field label="Freight" hint="Carriage the company pays on this order.">
              <Input type="number" min="0" step="0.01" value={freight}
                placeholder="0.00"
                onChange={(e) => setFreight(e.target.value)} />
            </Field>
          </div>
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
    </div>
  );
}
