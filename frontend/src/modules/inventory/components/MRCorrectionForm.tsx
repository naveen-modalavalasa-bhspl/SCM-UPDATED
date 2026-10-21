import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button, Card, Field, Input, Select, useToast } from "@/shared/components";
import { todayIst } from "@/shared/datetime";
import { correctMaterialRequest, getCatalogItems } from "../api";
import type { MaterialRequest } from "../types";

type Line = { id?: number | null; item_id: number | ""; quantity: string; label?: string };

const PRIORITIES = [
  { value: "LOW", label: "Low" },
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];

/**
 * The raiser's full edit of an MR sent back to them: the same fields the create form
 * asks — items and quantities (add, change, remove), priority, required-by, remarks.
 * Saved in one press; Resubmit is on the banner above.
 */
export function MRCorrectionForm({ mr, onSaved }: { mr: MaterialRequest; onSaved: () => void }) {
  const toast = useToast();
  const [lines, setLines] = useState<Line[]>(() =>
    (mr.items ?? []).map((i) => ({
      id: i.id,
      item_id: i.item_id,
      quantity: String(i.quantity),
      label: `${i.item_code ?? ""} — ${i.item_name ?? ""}`,
    })),
  );
  const [priority, setPriority] = useState(mr.priority ?? "NORMAL");
  const [requiredBy, setRequiredBy] = useState(mr.required_by ?? "");
  const [remarks, setRemarks] = useState(mr.remarks ?? "");

  const { data: catalog = [] } = useQuery({ queryKey: ["catalog-items"], queryFn: getCatalogItems });
  // Items already on the request stay pickable even if the catalog page lacks them.
  const options = useMemo(() => {
    const list = catalog.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }));
    for (const line of lines) {
      if (line.item_id !== "" && line.label && !list.some((o) => o.value === line.item_id)) {
        list.unshift({ value: line.item_id, label: line.label });
      }
    }
    return list;
  }, [catalog, lines]);

  const patch = (i: number, change: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...change } : l)));
  const ready = lines.filter((l) => l.item_id !== "" && Number(l.quantity) > 0);
  const duplicated = new Set(ready.map((l) => l.item_id).filter((id, i, all) => all.indexOf(id) !== i));

  const save = useMutation({
    mutationFn: () =>
      correctMaterialRequest(mr.id, {
        items: ready.map((l) => ({ id: l.id ?? null, item_id: Number(l.item_id), quantity: Number(l.quantity) })),
        priority,
        required_by: requiredBy || null,
        remarks: remarks || null,
      }),
    onSuccess: () => {
      toast.success("Request corrected — resubmit it when ready");
      onSaved();
    },
  });

  return (
    <Card className="mt-4 space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-ink">Edit material request</h2>
        <button
          type="button"
          onClick={() => setLines([...lines, { item_id: "", quantity: "" }])}
          className="text-sm font-medium text-brand hover:underline"
        >
          + Add line
        </button>
      </div>

      <div className="space-y-2">
        {lines.map((line, i) => (
          <div key={line.id ?? `new-${i}`} className="flex items-end gap-2">
            <div className="flex-1">
              <Select
                value={line.item_id}
                onChange={(v) => patch(i, { item_id: v === "" ? "" : Number(v) })}
                options={options}
                placeholder="Select item"
                ariaLabel={`Item on line ${i + 1}`}
              />
              {line.item_id !== "" && duplicated.has(line.item_id) && (
                <span className="mt-1 block text-xs text-danger">
                  Already on another line — put the whole quantity on one of them.
                </span>
              )}
            </div>
            <div className="w-32">
              <Input
                type="number"
                min={0}
                value={line.quantity}
                aria-label={`Quantity on line ${i + 1}`}
                placeholder="Qty"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch(i, { quantity: e.target.value })}
              />
            </div>
            <button
              type="button"
              aria-label={`Remove line ${i + 1}`}
              disabled={lines.length === 1}
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
              className="mb-1 p-2 text-muted hover:text-danger disabled:opacity-40"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Priority">
          <Select value={priority} onChange={(v) => setPriority(String(v))} options={PRIORITIES} ariaLabel="Priority" />
        </Field>
        <Field label="Required by">
          <Input
            type="date"
            min={todayIst()}
            value={requiredBy}
            aria-label="Required by"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRequiredBy(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Remarks">
        <Input
          value={remarks}
          aria-label="Remarks"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRemarks(e.target.value)}
        />
      </Field>

      {save.error && <p className="text-danger">{(save.error as Error).message}</p>}
      <div className="flex justify-end">
        <Button disabled={!ready.length || duplicated.size > 0 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Card>
  );
}
