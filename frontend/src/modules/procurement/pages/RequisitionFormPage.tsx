import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, ErrorBanner, Field, FormActions, Input, PageHeader, Select, useToast,
} from "@/shared/components";
import { requisitionApi } from "../api";
import { blankLine, LinePicker, type DraftLine } from "../components/LinePicker";
import type { ReqCreate } from "../types";

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
    setRemarks(existing.remarks ?? "");
    setLines(existing.items.map((item) => ({
      item_id: item.item_id,
      quantity: String(item.quantity),
      uom_code: item.uom_code,
      rate: String(item.estimated_rate ?? 0),
      required_date: item.required_date ?? "",
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
      remarks: remarks || null,
      lines: usable.map((line) => ({
        item_id: Number(line.item_id),
        quantity: Number(line.quantity),
        uom_code: line.uom_code ?? null,
        estimated_rate: Number(line.rate || 0),
        required_date: line.required_date || null,
      })),
    });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title={editing ? `Edit ${existing?.req_no ?? "requisition"}` : "New requisition"}
      />

      <ErrorBanner error={save.error} />
      {problem && <ErrorBanner error={problem} />}

      <Card className="space-y-5 p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Priority">
            <Select
              value={priority}
              options={PRIORITIES}
              onChange={(value) => setPriority(String(value))}
            />
          </Field>
          <Field label="Remarks">
            <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-ink">What is needed</h2>
          <LinePicker lines={lines} onChange={setLines} showRate />
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
