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
  const [allocations, setAllocations] = useState<Record<number, Record<number, string>>>({});
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

  const { data: vendorsByItem = {} } = useQuery<Record<number, MasterVendor[]>>({
    // Item ids are part of the key, so changing a line refetches rather than leaving
    // the previous item's suppliers on screen looking selectable.
    queryKey: ["rfq-vendors", vendorSearch, chosenItemIds],
    queryFn: async () => Object.fromEntries(await Promise.all(chosenItemIds.map(async (itemId) => {
      // Material suppliers only: the logistics partners share this master, and an
      // RFQ sent to a truck operator for gauze is a tender nobody can answer.
      //
      // `item_ids` narrows further, to the vendors actually mapped to supply what is
      // being asked for. The union across the lines, not the intersection — a tender
      // for gauze and syringes goes to whoever can supply either. The same rule is
      // checked again on save; this only decides what is offered.
      const response = await api.get<{ items: MasterVendor[] }>("/api/vendors", {
        params: {
          search: vendorSearch || undefined, size: 50, is_active: true,
          kind: "MATERIAL", item_ids: String(itemId),
        },
      });
      return [itemId, response.data.items] as const;
    }))),
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
    const restored: Record<number, Record<number, string>> = {};
    existing.vendors.forEach((vendor) => {
      (vendor.mapped_item_ids ?? []).forEach((itemId) => {
        restored[itemId] ??= {};
        const fullQuantity = existing.items.find((item) => item.item_id === itemId)?.quantity ?? 0;
        restored[itemId][vendor.vendor_id] = String(
          vendor.item_quantities?.[String(itemId)] ?? fullQuantity);
      });
    });
    setAllocations(restored);
    setLines(existing.items.map((item) => ({
      item_id: item.item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      quantity: String(item.quantity),
      original_quantity: String(item.quantity),
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
      original_quantity: String(item.quantity),
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
      original_quantity: String(item.approved_qty),
      uom_code: item.uom_code,
      required_date: item.required_date ?? "",
    })));
  }, [sourceConsolidation]);

  const save = useMutation({
    mutationFn: () => {
      const usable = lines.filter((l) => l.item_id !== "" && Number(l.quantity) > 0);
      const vendorAllocations = usable.flatMap((line) =>
        Object.entries(allocations[Number(line.item_id)] ?? {})
          .filter(([, quantity]) => Number(quantity) > 0)
          .map(([vendorId, quantity]) => ({
            item_id: Number(line.item_id), vendor_id: Number(vendorId),
            quantity: Number(quantity),
          })));
      const payload = {
        title: title || null,
        due_date: dueDate || null,
        terms: terms || null,
        evaluation_method: evaluationMethod || null,
        warehouse_id: org.warehouseId === "" ? null : org.warehouseId,
        project_id: org.projectId === "" ? null : org.projectId,
        department_id: org.departmentId === "" ? null : org.departmentId,
        company_name: org.companyName || null,
        vendor_ids: [...new Set(vendorAllocations.map((row) => row.vendor_id))],
        vendor_allocations: vendorAllocations,
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
    for (const line of usable) {
      if (line.original_quantity && Number(line.quantity) > Number(line.original_quantity)) {
        setProblem(`Quantity cannot exceed ${line.original_quantity} for ${line.item_name || line.item_code}.`);
        return;
      }
      const itemAllocations = Object.values(allocations[Number(line.item_id)] ?? {})
        .map(Number).filter((quantity) => quantity > 0);
      if (!itemAllocations.length) {
        setProblem(`Pick at least one vendor for ${line.item_name || line.item_code || "each item"}.`);
        return;
      }
      const allocated = itemAllocations.reduce((sum, quantity) => sum + quantity, 0);
      if (allocated > Number(line.quantity)) {
        setProblem(`Allocated quantity cannot exceed ${line.quantity} for ${line.item_name || line.item_code}.`);
        return;
      }
    }
    setProblem(null);
    save.mutate();
  };

  const toggleVendor = (itemId: number, vendorId: number, maximum: number) =>
    setAllocations((current) => {
      const item = { ...(current[itemId] ?? {}) };
      if (vendorId in item) delete item[vendorId];
      else {
        const used = Object.values(item).reduce((sum, quantity) => sum + (Number(quantity) || 0), 0);
        const remaining = Math.max(0, maximum - used);
        item[vendorId] = remaining > 0 ? String(remaining) : "";
      }
      return { ...current, [itemId]: item };
    });

  const setVendorQuantity = (itemId: number, vendorId: number, quantity: string) =>
    setAllocations((current) => ({
      ...current,
      [itemId]: { ...(current[itemId] ?? {}), [vendorId]: quantity },
    }));

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
            Vendors and quantities per item
            <span aria-hidden="true" className="ml-0.5 text-danger">*</span>
          </h2>
          <p className="mb-3 text-xs text-muted">
            Split each item between its mapped vendors. The combined allocation cannot
            exceed the quantity carried from the previous document.
          </p>
          <Input value={vendorSearch} onChange={(e) => setVendorSearch(e.target.value)}
                 placeholder="Search vendors…" />
          <div className="mt-3 space-y-3">
            {lines.filter((line) => line.item_id !== "").map((line) => {
              const itemId = Number(line.item_id);
              const maximum = Number(line.quantity) || 0;
              const itemAllocations = allocations[itemId] ?? {};
              const allocated = Object.values(itemAllocations)
                .reduce((sum, quantity) => sum + (Number(quantity) || 0), 0);
              const itemVendors = vendorsByItem[itemId] ?? [];
              return (
                <div key={itemId} className="rounded-xl border border-line p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-ink">
                        {line.item_code ? `${line.item_code} — ` : ""}{line.item_name}
                      </p>
                      <p className="text-xs text-muted">Maximum {maximum} {line.uom_code ?? ""}</p>
                    </div>
                    <p className={`text-xs font-semibold ${allocated > maximum ? "text-danger" : "text-muted"}`}>
                      Allocated {allocated} / {maximum}
                    </p>
                  </div>
                  <div className="space-y-1">
                    {itemVendors.map((vendor) => {
                      const selected = vendor.id in itemAllocations;
                      return (
                        <div key={vendor.id}
                             className="grid min-h-12 grid-cols-[auto_1fr_9rem] items-center gap-3 rounded-lg px-2 hover:bg-surface-2">
                          <input type="checkbox" className="h-4 w-4" checked={selected}
                                 onChange={() => toggleVendor(itemId, vendor.id, maximum)} />
                          <div className="min-w-0">
                            <p className="truncate text-sm text-ink">{vendor.name}</p>
                            <p className="truncate text-[11px] text-muted">
                              {vendor.code ?? "—"}{vendor.email ? ` · ${vendor.email}` : ""}
                            </p>
                          </div>
                          <Input type="number" min="0.001" max={String(maximum)} step="0.001"
                                 disabled={!selected} value={selected ? itemAllocations[vendor.id] : ""}
                                 aria-label={`Quantity for ${vendor.name}`}
                                 onChange={(e) => setVendorQuantity(itemId, vendor.id, e.target.value)} />
                        </div>
                      );
                    })}
                    {!itemVendors.length && (
                      <p className="px-2 py-3 text-sm text-muted">
                        No mapped vendor found. Add one under{" "}
                        <Link to="/masters?tab=vendor-items" className="font-semibold text-brand underline">
                          Masters → Vendor Rates
                        </Link>.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            {!chosenItemIds.length && (
              <p className="rounded-xl border border-line px-3 py-4 text-sm text-muted">
                Add an item first to choose its vendors.
              </p>
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
