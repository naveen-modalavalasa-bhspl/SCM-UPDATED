import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowDown, Lock, RotateCcw, Trash2 } from "lucide-react";
import { Button, Card, Field, Input, Select, useToast } from "@/shared/components";
import { todayIst } from "@/shared/datetime";
import { correctMaterialRequest } from "../api";
import type { MaterialRequest, MaterialRequestItem } from "../types";

type Line = { row: MaterialRequestItem; quantity: string; removed: boolean };

const PRIORITIES = [
  { value: "LOW", label: "Low" },
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];

const n = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 3 });

/**
 * The raiser's edit of an MR sent back to them (2026-11-03): each line may be LOWERED
 * or taken off — never raised past what it asked for, and no new item added. More is
 * new demand, and new demand is a new material request with its own approval. The
 * server enforces the same rule (`shared.ceiling`); this screen says it before Save.
 * Priority, required-by and remarks stay free. Resubmit is on the banner above.
 */
export function MRCorrectionForm({ mr, onSaved }: { mr: MaterialRequest; onSaved: () => void }) {
  const toast = useToast();
  const [lines, setLines] = useState<Line[]>(() =>
    (mr.items ?? []).map((row) => ({ row, quantity: String(row.quantity), removed: false })),
  );
  const [priority, setPriority] = useState(mr.priority ?? "NORMAL");
  const [requiredBy, setRequiredBy] = useState(mr.required_by ?? "");
  const [remarks, setRemarks] = useState(mr.remarks ?? "");

  const askedFor = (row: MaterialRequestItem) => row.requested_quantity ?? row.quantity;
  const patch = (i: number, change: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...change } : l)));
  const problemOf = (l: Line): string | null => {
    if (l.removed) return null;
    const v = Number(l.quantity);
    if (l.quantity.trim() === "" || Number.isNaN(v) || v <= 0) return "Enter a quantity above zero, or remove the line";
    if (v > askedFor(l.row)) return `Only ${n(askedFor(l.row))} ${l.row.uom_code ?? ""} was asked for — lower it or leave it`;
    return null;
  };
  const kept = lines.filter((l) => !l.removed);
  const problems = lines.map(problemOf).filter(Boolean);

  const save = useMutation({
    mutationFn: () =>
      correctMaterialRequest(mr.id, {
        items: kept.map((l) => ({ id: l.row.id, item_id: l.row.item_id, quantity: Number(l.quantity) })),
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
    <Card className="mt-4 space-y-4 p-4 sm:p-5">
      <div>
        <h2 className="font-semibold text-ink">Correct material request</h2>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <Lock className="h-3.5 w-3.5" />
          Quantities can be lowered or a line removed — never raised. Need more, or another
          item? Raise a new material request.
        </p>
      </div>

      <ul className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line/70">
        {lines.map((l, i) => {
          const issue = problemOf(l);
          const v = Number(l.quantity);
          const cut = !l.removed && !issue ? Math.round((l.row.quantity - v) * 1000) / 1000 : 0;
          return (
            <li key={l.row.id}
                className={`grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-center ${
                  l.removed ? "bg-content2/50" : ""}`}>
              <div className={`min-w-0 ${l.removed ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs font-semibold text-ink">{l.row.item_code}</span>
                  <span className={`truncate text-sm text-body ${l.removed ? "line-through" : ""}`}>{l.row.item_name}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted">
                  Asked {n(askedFor(l.row))} {l.row.uom_code ?? ""}
                  {l.row.quantity !== askedFor(l.row) && <> · now {n(l.row.quantity)}</>}
                </div>
              </div>

              {l.removed ? (
                <span className="text-xs font-semibold text-bad">Will be removed</span>
              ) : (
                <div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={0}
                      max={askedFor(l.row)}
                      data-uom={l.row.uom_code ?? ""}
                      value={l.quantity}
                      aria-label={`Quantity for ${l.row.item_name ?? l.row.item_code ?? "line"}`}
                      isInvalid={!!issue}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch(i, { quantity: e.target.value })}
                    />
                    <span className="text-xs text-muted">{l.row.uom_code ?? ""}</span>
                  </div>
                  {issue ? (
                    <p className="mt-1 text-[11px] text-danger">{issue}</p>
                  ) : cut > 0 ? (
                    <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
                      <ArrowDown className="h-3 w-3" /> {n(cut)} less
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] text-muted">Up to {n(askedFor(l.row))}</p>
                  )}
                </div>
              )}

              <div className="flex justify-end">
                {l.removed ? (
                  <button type="button" onClick={() => patch(i, { removed: false })}
                          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-brand hover:bg-brand-050">
                    <RotateCcw className="h-3.5 w-3.5" /> Put back
                  </button>
                ) : (
                  <button type="button" aria-label={`Remove ${l.row.item_code ?? "line"}`}
                          disabled={kept.length === 1}
                          onClick={() => patch(i, { removed: true })}
                          className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-bad-bg hover:text-bad disabled:opacity-30">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

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
      <Field label="Remarks" hint="Saved with the change record — say why the quantity came down.">
        <Input
          value={remarks}
          aria-label="Remarks"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRemarks(e.target.value)}
        />
      </Field>

      {save.error && <p className="text-danger">{(save.error as Error).message}</p>}
      <div className="flex justify-end">
        <Button disabled={!kept.length || problems.length > 0 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Card>
  );
}
