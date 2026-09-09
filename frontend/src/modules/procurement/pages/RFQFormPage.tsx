import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, ErrorBanner, Field, FormActions, Input, Textarea, PageHeader, Select, useToast } from "@/shared/components";
import { Button } from "../components/ActionButton";
import { api } from "@/shared/api/client";
import { consolidationApi, requisitionApi, rfqApi } from "../api";
import { blankLine, LinePicker, type DraftLine } from "../components/LinePicker";
import { OrgFields, type OrgValue } from "../components/OrgFields";
import { todayIst } from "@/shared/datetime";

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
  const fromConsolidation = params.get("consolidation");

  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [terms, setTerms] = useState("");
  // Empty means "use the default" — the backend decides what that is, so the form
  // never has to carry a copy of it.
  const [evaluationMethod, setEvaluationMethod] = useState("");
  // Carried from the source document where there is one, and typed where there is not:
  // an RFQ raised cold still has to say who is buying, for where, on whose budget and
  // on whose paper. Same four fields the requisition form asks for.
  const [org, setOrg] = useState<OrgValue>({
    departmentId: "", warehouseId: "", projectId: "", companyName: "",
  });
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

  const { data: sourceConsolidation } = useQuery({
    queryKey: ["consolidation", fromConsolidation],
    queryFn: () => consolidationApi.get(Number(fromConsolidation)),
    enabled: Boolean(fromConsolidation) && !editing,
  });

  // The items this tender is for. Vendors are offered against THESE, so the list
  // has to move when a line is added, changed or removed.
  const chosenItemIds = useMemo(
    () => [...new Set(lines.map((l) => l.item_id).filter((id): id is number => id !== ""))],
    [lines],
  );

  const { data: vendors = [] } = useQuery({
    // Item ids are part of the key, so changing a line refetches rather than leaving
    // the previous item's suppliers on screen looking selectable.
    queryKey: ["rfq-vendors", vendorSearch, chosenItemIds],
    queryFn: () =>
      // Material suppliers only: the logistics partners share this master, and an
      // RFQ sent to a truck operator for gauze is a tender nobody can answer.
      //
      // `item_ids` narrows further, to the vendors actually mapped to supply what is
      // being asked for. The union across the lines, not the intersection — a tender
      // for gauze and syringes goes to whoever can supply either. The same rule is
      // checked again on save; this only decides what is offered.
      api.get<{ items: MasterVendor[] }>("/api/vendors", {
        params: {
          search: vendorSearch || undefined, size: 50, is_active: true,
          kind: "MATERIAL", item_ids: chosenItemIds.join(",") || undefined,
        },
      }).then((r) => r.data.items),
    // No items chosen yet means no question to ask: an unfiltered list here would be
    // every supplier in the master, which is the thing this restriction removes.
    enabled: chosenItemIds.length > 0,
  });

  const { data: methods } = useQuery({
    queryKey: ["rfq-evaluation-methods"],
    queryFn: rfqApi.evaluationMethods,
  });

  useEffect(() => {
    if (!existing) return;
    setTitle(existing.title ?? "");
    setDueDate(existing.due_date ?? "");
    setTerms(existing.terms ?? "");
    setEvaluationMethod(existing.evaluation_method ?? "");
    setOrg({
      departmentId: existing.department_id ?? "",
      warehouseId: existing.warehouse_id ?? "",
      warehouseName: existing.warehouse_name ?? "",
      projectId: existing.project_id ?? "",
      companyName: existing.company_name ?? "",
    });
    setVendorIds(existing.vendors.map((v) => v.vendor_id));
    setLines(existing.items.map((item) => ({
      item_id: item.item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      quantity: String(item.quantity),
      uom_code: item.uom_code,
      required_date: item.required_date ?? "",
    })));
  }, [existing]);

  // Everything the requisition already says, carried across — warehouse, project and
  // its remarks as the opening terms, not just the lines. Retyping them was the one
  // place the two documents could quietly disagree about what was being bought.
  useEffect(() => {
    if (!source) return;
    setTitle(`Quotation for ${source.req_no}`);
    setOrg({
      departmentId: source.department_id ?? "",
      warehouseId: source.warehouse_id ?? "",
      warehouseName: source.warehouse_name ?? "",
      projectId: source.project_id ?? "",
      companyName: source.company_name ?? "",
    });
    setTerms((current) => current || source.remarks || "");
    setLines(source.items.map((item) => ({
      item_id: item.item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      quantity: String(item.quantity),
      uom_code: item.uom_code,
      required_date: item.required_date ?? "",
    })));
  }, [source]);

  useEffect(() => {
    if (!sourceConsolidation) return;
    setTitle(`Quotation for ${sourceConsolidation.cons_no}`);
    setOrg({
      departmentId: "",
      warehouseId: sourceConsolidation.warehouse_id ?? "",
      warehouseName: sourceConsolidation.warehouse_name ?? "",
      projectId: sourceConsolidation.project_id ?? "",
      companyName: "",
    });
    setTerms((current) => current || sourceConsolidation.remarks || "");
    setLines(sourceConsolidation.items.map((item) => ({
      item_id: item.item_id,
      item_code: item.item_code ?? "",
      item_name: item.item_name ?? "",
      quantity: String(item.approved_qty),
      uom_code: item.uom_code,
      required_date: item.required_date ?? "",
    })));
  }, [sourceConsolidation]);

  const save = useMutation({
    mutationFn: () => {
      const usable = lines.filter((l) => l.item_id !== "" && Number(l.quantity) > 0);
      const payload = {
        title: title || null,
        due_date: dueDate || null,
        terms: terms || null,
        evaluation_method: evaluationMethod || null,
        warehouse_id: org.warehouseId === "" ? null : org.warehouseId,
        project_id: org.projectId === "" ? null : org.projectId,
        department_id: org.departmentId === "" ? null : org.departmentId,
        company_name: org.companyName || null,
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
        : rfqApi.create({ 
            ...payload, 
            requisition_id: fromRequisition ? Number(fromRequisition) : null,
            consolidation_id: fromConsolidation ? Number(fromConsolidation) : null
          });
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
        back={{ to: "/procurement/rfqs", label: "Back to RFQs" }}
        eyebrow="Procurement"
        title={editing ? `Edit ${existing?.rfq_no ?? "RFQ"}` : "New RFQ"}
      />

      <ErrorBanner error={save.error} />
      {problem && <ErrorBanner error={problem} />}

      {source && (
        <Card className="mb-4 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            Carried from {source.req_no}
          </p>
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
            {[
              ["Department", source.department_name],
              ["Shipment Address", source.warehouse_name],
              ["Project", source.project_name],
              ["Company", source.company_name],
              ["Priority", source.priority ?? "Normal"],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-1 text-body">{value || "—"}</dd>
              </div>
            ))}
          </dl>
          {(source.source_indent_nos ?? []).length > 0 && (
            <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
              Indents behind it:{" "}
              <span className="font-mono text-body">
                {source.source_indent_nos!.join(", ")}
              </span>
            </p>
          )}
        </Card>
      )}

      {sourceConsolidation && (
        <Card className="mb-4 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            Carried from {sourceConsolidation.cons_no}
          </p>
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
            {[
              ["Project", sourceConsolidation.project_name],
              ["Status", sourceConsolidation.status],
              ["Approved By", sourceConsolidation.approved_by_name],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-1 text-body">{value || "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
            Requisitions rolled up:{" "}
            <span className="font-mono text-body">
              {sourceConsolidation.source_count}
            </span>
          </p>
        </Card>
      )}

      <Card className="space-y-5 p-5">
        {/* Editable either way: a requisition pre-fills them, and an RFQ raised cold
          * has nowhere else to get them from. */}
        <OrgFields value={org} onChange={(patch) => setOrg({ ...org, ...patch })} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)}
                   placeholder="What is being bought" />
          </Field>
          <Field label="Closes on" hint="After this date vendors can read but not quote.">
            {/* A closing date behind us shuts the RFQ the moment it is raised. */}
            <Input type="date" min={todayIst()} value={dueDate}
                   onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Terms">
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)}
                      placeholder="Payment, delivery, warranty" />
          </Field>
          <Field
            label="Award on"
            hint={methods?.find((m) => m.value === evaluationMethod)?.help
              ?? methods?.find((m) => m.is_default)?.help}
          >
            <Select
              value={evaluationMethod}
              placeholder="Lowest landed cost (default)"
              options={(methods ?? []).map((m) => ({ value: m.value, label: m.label }))}
              onChange={setEvaluationMethod}
            />
          </Field>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-ink">
            What is being asked for
            <span aria-hidden="true" className="ml-0.5 text-danger">*</span>
            <span className="sr-only"> (required)</span>
          </h2>
          <LinePicker lines={lines} onChange={setLines} />
        </div>

        <div>
          <h2 className="mb-1 text-sm font-semibold text-ink">
            Who to ask
            <span aria-hidden="true" className="ml-0.5 text-danger">*</span>
            <span className="sr-only"> (required)</span>
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
            {/* Three different silences, and saying the wrong one sends somebody
                looking in the wrong place. "No vendors" on an item nobody has mapped
                reads as a broken screen; it is missing master data, and the fix is one
                link away. */}
            {!vendors.length && (
              chosenItemIds.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted">
                  Add an item first — vendors are offered against what you are asking for.
                </p>
              ) : vendorSearch ? (
                <p className="px-3 py-4 text-sm text-muted">
                  No vendor matching “{vendorSearch}” is mapped to supply these items.
                </p>
              ) : (
                <div className="px-3 py-4 text-sm">
                  <p className="text-ink">
                    No vendor is mapped to supply {chosenItemIds.length === 1
                      ? "this item" : "any of these items"}.
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    A tender can only be sent to a vendor mapped to what it asks for.
                    Add the mapping on{" "}
                    <Link to="/masters?tab=vendor-items"
                          className="font-semibold text-brand underline">
                      Masters → Vendor Rates
                    </Link>
                    , then come back.
                  </p>
                </div>
              )
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
