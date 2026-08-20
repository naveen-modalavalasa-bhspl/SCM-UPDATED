import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, Select } from "@/shared/components";
import { todayIst } from "@/shared/datetime";
import { createMaterialRequest, getCatalogItems } from "../api";
import { alerts } from "@/modules/alerts";

/** One row of the request being typed. Kept as strings — a half-typed quantity is a
 *  string, and coercing on every keystroke fights the person entering it. */
type Line = { item_id: number | ""; quantity: string };

const PRIORITIES = [
  { value: "LOW", label: "Low" },
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];

/**
 * Raise a material request by hand.
 *
 * Until now the only way one existed was the automatic shortfall on an allocation,
 * which fires on what is on the shelf ANYWHERE — LIP and MDP stock included. A line
 * the warehouse cannot serve but a distribution point can was therefore never short,
 * never reached procurement, and had no other door to knock on. This is that door.
 *
 * The document is identical to an automatic one: same numbering, same ladder, same
 * approval. Only the reason it exists is different, which is why the backend shares
 * one writer between the two rather than growing a second kind of MR.
 */
export function MaterialRequestFormPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [lines, setLines] = useState<Line[]>([{ item_id: "", quantity: "" }]);
  const [priority, setPriority] = useState("NORMAL");
  const [requiredBy, setRequiredBy] = useState("");
  const [remarks, setRemarks] = useState("");

  const { data: catalog = [] } = useQuery({
    queryKey: ["catalog-items"],
    queryFn: getCatalogItems,
  });

  const patch = (i: number, change: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...change } : l)));

  // A line is only ready when it names an item AND asks for something. Both halves
  // matter: an item with no quantity and a quantity with no item are equally unusable
  // to procurement, and the backend refuses each of them separately.
  const ready = lines.filter((l) => l.item_id !== "" && Number(l.quantity) > 0);
  // The same item twice is one line's worth of demand written down twice, and the
  // buyer cannot tell which figure is meant.
  const duplicated = new Set(
    ready.map((l) => l.item_id).filter((id, i, all) => all.indexOf(id) !== i),
  );

  const save = useMutation({
    mutationFn: () =>
      createMaterialRequest({
        items: ready.map((l) => ({
          item_id: Number(l.item_id),
          quantity: Number(l.quantity),
        })),
        priority,
        required_by: requiredBy || null,
        remarks: remarks || null,
      }),
    onSuccess: async (mr) => {
      void alerts.success("material_request.raised", { number: mr.mr_no });
      await qc.invalidateQueries({ queryKey: ["material-requests"] });
      nav(`/inventory/material-requests/${mr.id}`);
    },
  });

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="New Material Request"
        actions={
          <>
            <Button variant="subtle" onClick={() => nav("/inventory/material-requests")}>
              Back
            </Button>
            <Button
              disabled={!ready.length || duplicated.size > 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Raising…" : "Raise request"}
            </Button>
          </>
        }
      />

      <p className="mb-4 text-sm text-muted">
        For material the warehouse cannot serve. It goes straight into approval, the
        same as one raised automatically off a short indent.
      </p>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-ink">Items</h2>
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
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <Select
                  value={line.item_id}
                  onChange={(v) => patch(i, { item_id: v === "" ? "" : Number(v) })}
                  options={catalog.map((c) => ({
                    value: c.id,
                    label: `${c.code} — ${c.name}`,
                  }))}
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
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    patch(i, { quantity: e.target.value })
                  }
                />
              </div>
              <button
                type="button"
                aria-label={`Remove line ${i + 1}`}
                // Never below one row: an empty form with no way to start typing again
                // is a dead screen.
                disabled={lines.length === 1}
                onClick={() => setLines(lines.filter((_, j) => j !== i))}
                className="mb-1 p-2 text-muted hover:text-danger disabled:opacity-40"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-4 space-y-3 p-4">
        <Field label="Priority">
          <Select
            value={priority}
            onChange={(v) => setPriority(String(v))}
            options={PRIORITIES}
            ariaLabel="Priority"
          />
        </Field>
        <Field label="Required by">
          <Input
            type="date"
            /* The server refuses a past date outright; this stops the person typing
               one before they lose the rest of the form to a validation error. */
            min={todayIst()}
            value={requiredBy}
            aria-label="Required by"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRequiredBy(e.target.value)}
          />
        </Field>
        <Field label="Remarks" hint="Why the warehouse cannot serve this.">
          <Input
            value={remarks}
            aria-label="Remarks"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRemarks(e.target.value)}
          />
        </Field>
      </Card>

      {save.error && (
        <p className="mt-3 text-sm text-danger">{(save.error as Error).message}</p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="subtle" onClick={() => nav("/inventory/material-requests")}>
          Cancel
        </Button>
        <Button
          disabled={!ready.length || duplicated.size > 0 || save.isPending}
          onClick={() => save.mutate()}
        >
          <Plus size={16} /> Raise request
        </Button>
      </div>
    </div>
  );
}
