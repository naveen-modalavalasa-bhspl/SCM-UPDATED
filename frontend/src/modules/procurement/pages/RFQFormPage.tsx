import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, ErrorBanner, Field, FormActions, Input, PageHeader, useToast,
} from "@/shared/components";
import { api } from "@/shared/api/client";
import { requisitionApi, rfqApi } from "../api";
import { blankLine, LinePicker, type DraftLine } from "../components/LinePicker";

interface MasterVendor {
  id: number;
  code?: string | null;
  name: string;
  email?: string | null;
}

/**
 * Raise or edit an RFQ.
 *
 * Two ways in: cold, or from an approved requisition (`?requisition=<id>`), which
 * pre-fills the lines. No rate column — an RFQ ASKS for a price; stating one would
 * anchor every vendor to the same number.
 */
export function RFQFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = Boolean(id);
  const fromRequisition = params.get("requisition");

  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [terms, setTerms] = useState("");
  const [vendorIds, setVendorIds] = useState<number[]>([]);
  const [vendorSearch, setVendorSearch] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [problem, setProblem] = useState<string | null>(null);

  const { data: existing } = useQuery({
    queryKey: ["rfq", id],
    queryFn: () => rfqApi.get(Number(id)),
    enabled: editing,
  });

  const { data: source } = useQuery({
    queryKey: ["requisition", fromRequisition],
    queryFn: () => requisitionApi.get(Number(fromRequisition)),
    enabled: Boolean(fromRequisition) && !editing,
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ["rfq-vendors", vendorSearch],
    queryFn: () =>
      api.get<{ items: MasterVendor[] }>("/api/vendors", {
        params: { search: vendorSearch || undefined, size: 50, is_active: true },
      }).then((r) => r.data.items),
  });

  useEffect(() => {
    if (!existing) return;
    setTitle(existing.title ?? "");
    setDueDate(existing.due_date ?? "");
    setTerms(existing.terms ?? "");
    setVendorIds(existing.vendors.map((v) => v.vendor_id));
    setLines(existing.items.map((item) => ({
      item_id: item.item_id,
      quantity: String(item.quantity),
      uom_code: item.uom_code,
      required_date: item.required_date ?? "",
    })));
  }, [existing]);

  useEffect(() => {
    if (!source) return;
    setTitle(`Quotation for ${source.req_no}`);
    setLines(source.items.map((item) => ({
      item_id: item.item_id,
      quantity: String(item.quantity),
      uom_code: item.uom_code,
      required_date: item.required_date ?? "",
    })));
  }, [source]);

  const save = useMutation({
    mutationFn: () => {
      const usable = lines.filter((l) => l.item_id !== "" && Number(l.quantity) > 0);
      const payload = {
        title: title || null,
        due_date: dueDate || null,
        terms: terms || null,
        vendor_ids: vendorIds,
        lines: usable.map((line) => ({
          item_id: Number(line.item_id),
          quantity: Number(line.quantity),
          uom_code: line.uom_code ?? null,
          required_date: line.required_date || null,
        })),
      };
      return editing
        ? rfqApi.update(Number(id), payload)
        : rfqApi.create({ ...payload, requisition_id: fromRequisition ? Number(fromRequisition) : null });
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["rfqs"] });
      toast.success(editing ? "RFQ updated" : `RFQ ${saved.rfq_no} created`);
      nav(`/procurement/rfqs/${saved.id}`);
    },
  });

  const submit = () => {
    const usable = lines.filter((l) => l.item_id !== "" && Number(l.quantity) > 0);
    if (!usable.length) {
      setProblem("Add at least one line with an item and a quantity.");
      return;
    }
    if (!vendorIds.length) {
      setProblem("Pick at least one vendor to ask.");
      return;
    }
    setProblem(null);
    save.mutate();
  };

  const toggleVendor = (vendorId: number) =>
    setVendorIds((current) =>
      current.includes(vendorId)
        ? current.filter((v) => v !== vendorId)
        : [...current, vendorId]);

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title={editing ? `Edit ${existing?.rfq_no ?? "RFQ"}` : "New RFQ"}
      />

      <ErrorBanner error={save.error} />
      {problem && <ErrorBanner error={problem} />}

      <Card className="space-y-5 p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)}
                   placeholder="What is being bought" />
          </Field>
          <Field label="Closes on" hint="After this date vendors can read but not quote.">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Terms">
            <Input value={terms} onChange={(e) => setTerms(e.target.value)}
                   placeholder="Payment, delivery, warranty" />
          </Field>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-ink">What is being asked for</h2>
          <LinePicker lines={lines} onChange={setLines} />
        </div>

        <div>
          <h2 className="mb-1 text-sm font-semibold text-ink">
            Who to ask
            <span className="ml-2 text-xs font-normal text-muted">
              {vendorIds.length} selected
            </span>
          </h2>
          <p className="mb-3 text-xs text-muted">
            Each vendor gets their own link. Removing one who has already quoted is
            refused — their offer is part of the record.
          </p>
          <Input
            value={vendorSearch}
            onChange={(e) => setVendorSearch(e.target.value)}
            placeholder="Search vendors…"
          />
          <div className="mt-3 max-h-64 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
            {vendors.map((vendor) => (
              <label
                key={vendor.id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={vendorIds.includes(vendor.id)}
                  onChange={() => toggleVendor(vendor.id)}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink">{vendor.name}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {vendor.code ?? "—"}{vendor.email ? ` · ${vendor.email}` : ""}
                  </span>
                </span>
              </label>
            ))}
            {!vendors.length && (
              <p className="px-3 py-4 text-sm text-muted">No vendors match that search.</p>
            )}
          </div>
        </div>

        <FormActions>
          <Button variant="subtle" onClick={() => nav("/procurement/rfqs")}>Cancel</Button>
          <Button disabled={save.isPending} onClick={submit}>
            {editing ? "Save changes" : "Create RFQ"}
          </Button>
        </FormActions>
      </Card>
    </div>
  );
}
