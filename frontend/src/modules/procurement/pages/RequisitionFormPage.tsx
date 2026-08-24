import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, ErrorBanner, Field, FormActions, Input, PageHeader, Select, useToast,
} from "@/shared/components";
import { requisitionApi } from "../api";
import { blankLine, LinePicker, type DraftLine } from "../components/LinePicker";
import { OrgFields, type OrgValue } from "../components/OrgFields";
import type { ReqCreate } from "../types";
import { todayIst } from "@/shared/datetime";

const PRIORITIES = [
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];

const EMPTY_ORG: OrgValue = {
  departmentId: "", warehouseId: "", projectId: "", companyName: "",
};

/** Raise or edit a requisition. Only a DRAFT is editable — the backend enforces it,
 *  and this screen redirects rather than showing a form that cannot save. */
export function RequisitionFormPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = Boolean(id);

  const [priority, setPriority] = useState("NORMAL");
  const [org, setOrg] = useState<OrgValue>(EMPTY_ORG);
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
    setOrg({
      departmentId: existing.department_id ?? "",
      warehouseId: existing.warehouse_id ?? "",
      warehouseName: existing.warehouse_name ?? "",
      projectId: existing.project_id ?? "",
      companyName: existing.company_name ?? "",
    });
    // The header date, or the first line's where the requisition predates it.
    setRequiredDate(existing.required_date
      ?? existing.items.find((item) => item.required_date)?.required_date ?? "");
    setRemarks(existing.remarks ?? "");
    setLines(existing.items.map((item) => ({
      item_id: item.item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      quantity: String(item.quantity),
      uom_code: item.uom_code,
      // The estimated rate is kept — the approval ladder routes on the requisition's
      // value — but it is no longer typed here. An editor that re-sends the line has
      // to carry it forward or every edit would zero it.
      rate: String(item.estimated_rate ?? 0),
    })));
  }, [existing]);

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
    setProblem(null);
    save.mutate({
      priority,
      warehouse_id: org.warehouseId === "" ? null : org.warehouseId,
      project_id: org.projectId === "" ? null : org.projectId,
      department_id: org.departmentId === "" ? null : org.departmentId,
      company_name: org.companyName || null,
      required_date: requiredDate || null,
      remarks: remarks || null,
      lines: usable.map((line) => ({
        item_id: Number(line.item_id),
        quantity: Number(line.quantity),
        uom_code: line.uom_code ?? null,
        estimated_rate: Number(line.rate || 0),
        // Left null: the header date applies to every line (service fills it in).
        required_date: null,
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

      <Card className="space-y-5 p-5">
        <OrgFields value={org} onChange={(patch) => setOrg({ ...org, ...patch })} />

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
