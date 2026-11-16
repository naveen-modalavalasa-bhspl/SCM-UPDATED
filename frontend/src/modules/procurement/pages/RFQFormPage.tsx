import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@heroui/react";
import { Truck } from "lucide-react";
import { Card, DocumentNumberCard, ErrorBanner, Field, FormActions, Input, Textarea, PageHeader, Select, useToast } from "@/shared/components";
import { Button } from "../components/ActionButton";
import { api } from "@/shared/api/client";
import { consolidationApi, requisitionApi, rfqApi } from "../api";
import { blankLine, LinePicker, type DraftLine } from "../components/LinePicker";
import { emptyOrgValue, OrgFields, orgMissing, orgPayload, orgValueCarried, orgValueFrom, type OrgValue } from "../components/OrgFields";
import { departmentOf, isOlderDocument } from "../orgScope";
import { fmtDate, todayIst } from "@/shared/datetime";
import { comboFrom, comboPayload } from "@/shared/combination";

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
  // Off: the suppliers are not asked for freight, and the portal shows no field for it.
  const [freightRequired, setFreightRequired] = useState(false);
  // Carried from the source document where there is one, and typed where there is not:
  // an RFQ raised cold still has to say who is buying, for where, on whose budget and
  // on whose paper. Same four fields the requisition form asks for.
  const [org, setOrg] = useState<OrgValue>(emptyOrgValue());
  const [triedOrg, setTriedOrg] = useState(false);
  // Set in the same update that copies the source, so the card's defaults only ever see
  // what the source left empty.
  const [seeded, setSeeded] = useState(!editing && !fromRequisition && !fromConsolidation);
  const [chosenVendors, setChosenVendors] = useState<number[]>([]);
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
    setFreightRequired(Boolean(existing.freight_required));
    setOrg(orgValueFrom(existing));
    // Who was invited, which is now the whole of what this form holds about vendors.
    // An RFQ saved before allocation moved to the comparison may still carry old
    // per-supplier invitation quantities. Re-saving a draft intentionally normalizes
    // those invitations to the current rule: every selected supplier quotes each full
    // mapped line, and the actual shares are decided only after prices arrive.
    setChosenVendors([...new Set(existing.vendors.map((vendor) => vendor.vendor_id))]);
    setLines(existing.items.map((item) => ({
      item_id: item.item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      quantity: String(item.quantity),
      original_quantity: String(item.quantity),
      uom_code: item.uom_code,
      required_date: item.required_date ?? "",
      combo: comboFrom(item),
    })));
  }, [existing]);

  // Everything the requisition already says, carried across — warehouse, project and
  // its remarks as the opening terms, not just the lines. Retyping them was the one
  // place the two documents could quietly disagree about what was being bought.
  useEffect(() => {
    if (!source) return;
    setTitle(`Quotation for ${source.req_no}`);
    setOrg(orgValueCarried(source));
    setSeeded(true);
    setTerms((current) => current || source.remarks || "");
    setLines(source.items.map((item) => ({
      item_id: item.item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      quantity: String(item.quantity),
      original_quantity: String(item.quantity),
      uom_code: item.uom_code,
      required_date: item.required_date ?? "",
      combo: comboFrom(item),
    })));
  }, [source]);

  useEffect(() => {
    if (!sourceConsolidation) return;
    setTitle(`Quotation for ${sourceConsolidation.cons_no}`);
    setOrg(orgValueCarried(sourceConsolidation));
    setSeeded(true);
    setTerms((current) => current || sourceConsolidation.remarks || "");
    setLines(sourceConsolidation.items.map((item) => ({
      item_id: item.item_id,
      item_code: item.item_code ?? "",
      item_name: item.item_name ?? "",
      quantity: String(item.approved_qty),
      original_quantity: String(item.approved_qty),
      uom_code: item.uom_code,
      required_date: item.required_date ?? "",
      combo: comboFrom(item),
    })));
  }, [sourceConsolidation]);

  /**
   * Everyone mapped to at least one item on this RFQ, each named once.
   *
   * `vendorsByItem` is keyed per item because that is how the mapping is stored, and
   * the same supplier legitimately appears under several items. Inviting is a
   * per-DOCUMENT decision, so they are folded to one row here and the count of items
   * they cover is carried along — it is the one thing that made the per-item grid
   * worth reading, and it costs nothing to keep.
   */
  const invitableVendors = useMemo(() => {
    const byId = new Map<number, MasterVendor & { itemCount: number }>();
    for (const vendors of Object.values(vendorsByItem)) {
      for (const vendor of vendors) {
        const seen = byId.get(vendor.id);
        if (seen) seen.itemCount += 1;
        else byId.set(vendor.id, { ...vendor, itemCount: 1 });
      }
    }
    return [...byId.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [vendorsByItem]);

  // Raised before organisations: keeps its old fields, and is asked for nothing new.
  const legacy = isOlderDocument(existing, existing?.rfq_no);
  // Past a draft all of it is fixed; on a linked tender the organisation always is.
  const bookingLocked = Boolean(existing && !legacy && existing.status !== "DRAFT");
  const orgLocked = Boolean(
    source?.organization_id || sourceConsolidation?.organization_id
    || (existing?.organization_id && (existing.requisition_id || existing.consolidation_id)),
  );

  // SCM_0172: the date box greys out past days, but a TYPED date went straight
  // through it and the RFQ was raised already closed. Said under the field, and Save
  // stays off until it is fixed. A date this RFQ was already saved with is left alone
  // until somebody changes it — same rule the server applies on edit.
  const today = todayIst();
  const dueDateError = dueDate && dueDate < today && dueDate !== (existing?.due_date ?? "")
    ? `This date has passed. Pick today (${fmtDate(today)}) or later.`
    : null;
  const pastLine = lines.find((line) => !line.id && line.item_id !== ""
    && line.required_date && line.required_date < today);
  const dateProblem = dueDateError
    ? "The closing date has already passed."
    : pastLine
      ? `"Needed by" for ${pastLine.item_name || pastLine.item_code || "a line"} has already passed.`
      : null;

  const save = useMutation({
    mutationFn: () => {
      const usable = lines.filter((l) => l.item_id !== "" && Number(l.quantity) > 0);
      const payload = {
        title: title || null,
        due_date: dueDate || null,
        terms: terms || null,
        evaluation_method: evaluationMethod || null,
        freight_required: freightRequired,
        ...orgPayload(org, legacy),
        // Suppliers only. Splitting a line between them is a decision taken against
        // PRICES, and at this point nobody has any — see the note on the section
        // below. `vendor_allocations` is deliberately not sent: the service reads
        // its absence as "ask every invited supplier for the whole line", which is
        // what a tender is.
        vendor_ids: chosenVendors,
        lines: usable.map((line) => ({
          item_id: Number(line.item_id),
          quantity: Number(line.quantity),
          uom_code: line.uom_code ?? null,
          required_date: line.required_date || null,
          ...comboPayload(line.combo),
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
    if (dateProblem) {
      setProblem(`${dateProblem} Pick today or a later date.`);
      return;
    }
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
    }
    if (!chosenVendors.length) {
      setProblem("Pick at least one supplier to send this RFQ to.");
      return;
    }
    const missing = legacy ? null : orgMissing(org);
    if (missing) {
      setTriedOrg(true);
      setProblem(missing);
      return;
    }
    setProblem(null);
    save.mutate();
  };

  const toggleVendor = (vendorId: number) =>
    setChosenVendors((current) =>
      current.includes(vendorId)
        ? current.filter((id) => id !== vendorId)
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
              ["Organisation", source.organization_name ?? source.company_name],
              ["Department", departmentOf(source)],
              ["Shipment Address", source.warehouse_name],
              ["Project", source.project_name],
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
              ["Organisation", sourceConsolidation.organization_name],
              ["Department", sourceConsolidation.org_department_name],
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

      {!legacy && (
        <div className="mb-4">
          <DocumentNumberCard
            docType="RFQ" value={org} ready={seeded} showInvalid={triedOrg}
            locks={{ all: bookingLocked, organisation: orgLocked }}
            savedNumber={existing?.rfq_no}
            source={source ? { label: source.req_no, to: `/procurement/requisitions/${source.id}` }
              : sourceConsolidation ? { label: sourceConsolidation.cons_no, to: `/procurement/consolidations/${sourceConsolidation.id}` }
                : null}
            onChange={(patch) => setOrg((current) => ({ ...current, ...patch }))}
          />
        </div>
      )}

      <Card className="space-y-5 p-5">
        <OrgFields value={org} legacy={legacy} disabled={bookingLocked}
                   onChange={(patch) => setOrg((current) => ({ ...current, ...patch }))} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)}
                   placeholder="What is being bought" />
          </Field>
          <Field label="Closes on" hint="After this date vendors can read but not quote."
                 error={dueDateError}>
            {/* A closing date behind us shuts the RFQ the moment it is raised. */}
            <Input type="date" min={today} value={dueDate} isInvalid={!!dueDateError}
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

        {/* Whether the suppliers quote freight. Off, their portal shows no field for it
          * and any freight sent is saved as 0. */}
        <label className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
          freightRequired ? "border-brand/50 bg-brand-050/40" : "border-line bg-content1"}`}>
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
            freightRequired ? "bg-brand text-white" : "bg-content2 text-muted"}`}>
            <Truck className="h-4 w-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">Ask suppliers to quote freight</span>
            <span className="block text-xs text-muted">
              {freightRequired
                ? "Suppliers will see a Freight field on their quotation."
                : "Off — suppliers quote without freight; the Freight field is hidden on their portal."}
            </span>
          </span>
          <Switch isSelected={freightRequired} onValueChange={setFreightRequired}
                  aria-label="Ask suppliers to quote freight" />
        </label>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-ink">
            What is being asked for
            <span aria-hidden="true" className="ml-0.5 text-danger">*</span>
            <span className="sr-only"> (required)</span>
          </h2>
          <LinePicker lines={lines} onChange={setLines} vendorsByItem={vendorsByItem} />
        </div>

        <div>
          <h2 className="mb-1 text-sm font-semibold text-ink">
            Suppliers to invite
            <span aria-hidden="true" className="ml-0.5 text-danger">*</span>
          </h2>
          {/* SUPPLIERS, AND NOTHING ELSE.
            *
            * This section used to split every line between its vendors, quantity by
            * quantity, before the tender had gone out. That is a decision taken
            * against PRICES, and at the moment an RFQ is raised nobody has any —
            * so the buyer was being asked to guess the answer to the question the
            * RFQ exists to ask. Each invited supplier is now asked to quote the
            * WHOLE line, which is what a tender is, and the split is decided
            * against the quotations that come back.
            *
            * Only suppliers mapped to at least one item on the RFQ are offered: the
            * service refuses an invitation to a vendor who supplies none of them,
            * and a picker that offers what the save rejects is a picker nobody
            * trusts twice. */}
          <p className="mb-3 text-xs text-muted">
            Every supplier invited is asked to quote the full quantity of each item
            they are mapped to. Who supplies how much is decided later, against their
            quotations.
          </p>
          <Input value={vendorSearch} onChange={(e) => setVendorSearch(e.target.value)}
                 placeholder="Search suppliers…" />
          <div className="mt-3 space-y-1">
            {invitableVendors.map((vendor) => {
              const selected = chosenVendors.includes(vendor.id);
              return (
                <label key={vendor.id}
                       className="grid min-h-12 cursor-pointer grid-cols-[auto_1fr] items-center gap-3 rounded-lg px-2 hover:bg-surface-2">
                  <input type="checkbox" className="h-4 w-4" checked={selected}
                         onChange={() => toggleVendor(vendor.id)} />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{vendor.name}</p>
                    <p className="truncate text-[11px] text-muted">
                      {vendor.code ?? "—"}{vendor.email ? ` · ${vendor.email}` : ""}
                      {vendor.itemCount ? ` · ${vendor.itemCount} of these items` : ""}
                    </p>
                  </div>
                </label>
              );
            })}
            {!chosenItemIds.length && (
              <p className="rounded-xl border border-line px-3 py-4 text-sm text-muted">
                Add an item first to see who can supply it.
              </p>
            )}
            {!!chosenItemIds.length && !invitableVendors.length && (
              <p className="rounded-xl border border-line px-3 py-4 text-sm text-muted">
                No mapped supplier found for these items. Add one under{" "}
                <Link to="/masters?tab=vendor-items" className="font-semibold text-brand underline">
                  Masters → Vendor Rates
                </Link>.
              </p>
            )}
          </div>
        </div>

        <FormActions>
          <Button variant="subtle" onClick={() => nav("/procurement/rfqs")}>Cancel</Button>
          <Button disabled={save.isPending || !!dateProblem} onClick={submit}
                  title={dateProblem ?? undefined}>
            {editing ? "Save changes" : "Create RFQ"}
          </Button>
        </FormActions>
      </Card>
    </div>
  );
}
