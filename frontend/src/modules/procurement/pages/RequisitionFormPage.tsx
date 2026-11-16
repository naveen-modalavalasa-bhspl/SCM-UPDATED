import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, DocumentNumberCard, ErrorBanner, Field, FormActions, Input, PageHeader, Select, useToast } from "@/shared/components";
import { Button } from "../components/ActionButton";
import { requisitionApi } from "../api";
import { blankLine, LinePicker, overCap, type DraftLine } from "../components/LinePicker";
import { emptyOrgValue, OrgFields, orgMissing, orgPayload, orgValueFrom, type OrgValue } from "../components/OrgFields";
import { isOlderDocument } from "../orgScope";
import type { ReqCreate } from "../types";
import { todayIst } from "@/shared/datetime";
import { comboFrom, comboPayload } from "@/shared/combination";

const PRIORITIES = [
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];

/** Raise or edit a requisition. Only a DRAFT is editable — the backend enforces it,
 *  and this screen redirects rather than showing a form that cannot save. */
export function RequisitionFormPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = Boolean(id);

  const [priority, setPriority] = useState("NORMAL");
  const [org, setOrg] = useState<OrgValue>(emptyOrgValue());
  const [triedOrg, setTriedOrg] = useState(false);
  const [requiredDate, setRequiredDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [problem, setProblem] = useState<string | null>(null);

  const { data: existing } = useQuery({
    queryKey: ["requisition", id],
    queryFn: () => requisitionApi.get(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!existing) return;
    setPriority(existing.priority ?? "NORMAL");
    setOrg(orgValueFrom(existing));
    // The header date, or the first line's where the requisition predates it.
    setRequiredDate(existing.required_date
      ?? existing.items.find((item) => item.required_date)?.required_date ?? "");
    setRemarks(existing.remarks ?? "");
    setLines(existing.items.map((item) => ({
      // A line with a ceiling (2026-11-03) — drawn from a material request — keeps its
      // item (the picker locks on an id) and may only be lowered (`original_quantity`).
      id: item.requested_quantity != null ? item.id : null,
      original_quantity: item.requested_quantity != null ? String(item.requested_quantity) : undefined,
      item_id: item.item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      quantity: String(item.quantity),
      uom_code: item.uom_code,
      // The estimated rate is kept — the approval ladder routes on the requisition's
      // value — but it is no longer typed here. An editor that re-sends the line has
      // to carry it forward or every edit would zero it.
      rate: String(item.estimated_rate ?? 0),
      combo: comboFrom(item),
    })));
  }, [existing]);

  // Raised before organisations: keeps its old fields, and is asked for nothing new.
  const legacy = isOlderDocument(existing, existing?.req_no);

  const save = useMutation({
    mutationFn: (payload: ReqCreate) =>
      editing ? requisitionApi.update(Number(id), payload) : requisitionApi.create(payload),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["requisitions"] });
      toast.success(editing ? "Requisition updated" : `Requisition ${saved.req_no} raised`);
      nav(`/procurement/requisitions/${saved.id}`);
    },
  });

  const submit = () => {
    const usable = lines.filter((line) => line.item_id !== "" && Number(line.quantity) > 0);
    // Said on click, in a banner. A button greyed out for a reason the screen does
    // not state is indistinguishable from a broken one.
    if (!usable.length) {
      setProblem("Add at least one line with an item and a quantity.");
      return;
    }
    const over = usable.filter((line) => overCap(line));
    if (over.length) {
      setProblem(`${over.map((line) => line.item_code ?? "A line").join(", ")}: more than the material `
        + "request asked for. A quantity here can be lowered or left as it is, never raised.");
      return;
    }
    const missing = legacy ? null : orgMissing(org);
    if (missing) {
      setTriedOrg(true);
      setProblem(missing);
      return;
    }
    setProblem(null);
    save.mutate({
      priority,
      ...orgPayload(org, legacy),
      required_date: requiredDate || null,
      remarks: remarks || null,
      lines: usable.map((line) => ({
        item_id: Number(line.item_id),
        quantity: Number(line.quantity),
        uom_code: line.uom_code ?? null,
        estimated_rate: Number(line.rate || 0),
        // Left null: the header date applies to every line (service fills it in).
        required_date: null,
        ...comboPayload(line.combo),
      })),
    });
  };

  return (
    <div>
      <PageHeader
        back={{ to: "/procurement/requisitions", label: "Back to Requisitions" }}
        eyebrow="Procurement"
        title={editing ? `Edit ${existing?.req_no ?? "requisition"}` : "New requisition"}
      />

      <ErrorBanner error={save.error} />
      {problem && <ErrorBanner error={problem} />}

      {!legacy && (
        <div className="mb-4">
          <DocumentNumberCard
            docType="REQUISITION" value={org} ready={!editing} showInvalid={triedOrg}
            savedNumber={existing?.req_no}
            onChange={(patch) => setOrg((current) => ({ ...current, ...patch }))}
          />
        </div>
      )}

      <Card className="space-y-5 p-5">
        <OrgFields value={org} legacy={legacy}
                   onChange={(patch) => setOrg((current) => ({ ...current, ...patch }))} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Priority">
            <Select
              value={priority}
              options={PRIORITIES}
              onChange={(value) => setPriority(String(value))}
            />
          </Field>
          {/* One date for the document, not one per item. It was being typed forty
            * times to say something true of the whole requisition. */}
          <Field label="Needed by" hint="Applies to every line on this requisition.">
            <Input
              type="date"
              // A requisition is a request for the future. Blocked in the picker as
              // well as in the service, so the calendar never offers a day that the
              // save is going to refuse.
              min={todayIst()}
              value={requiredDate}
              onChange={(e) => setRequiredDate(e.target.value)}
            />
          </Field>
          <Field label="Remarks">
            <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </div>

        <div>
          {/* No rate column. A requisition asks for goods; what they cost is what the
            * vendors answer on the RFQ, and a figure typed here was only ever a guess
            * that read like a price. The estimate the approval ladder routes on is
            * still filled in server-side from the last known rate. */}
          <h2 className="mb-3 text-sm font-semibold text-ink">What is needed</h2>
          <LinePicker lines={lines} onChange={setLines} showDate={false} />
        </div>

        <FormActions>
          <Button variant="subtle" onClick={() => nav("/procurement/requisitions")}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={submit}>
            {editing ? "Save changes" : "Raise requisition"}
          </Button>
        </FormActions>
      </Card>
    </div>
  );
}
