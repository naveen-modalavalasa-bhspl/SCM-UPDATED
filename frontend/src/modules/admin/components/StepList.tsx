/** The chain, as a draggable ordered list.
 *
 *  Native HTML5 drag events rather than a drag-and-drop library — the list is a handful
 *  of rows, and a dependency would be the largest thing on the page. Arrow buttons stay
 *  alongside: dragging is not reachable from a keyboard, and this screen decides who is
 *  allowed to approve.
 */
import { useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, X } from "lucide-react";

import type { CustomLadderStep, FlowRung, StepKind } from "../types";

const KIND_LABEL: Record<StepKind, string> = {
  local: "Post",
  hcm: "HCM post",
  rank: "Reporting line",
  shared_rank: "Shared chair",
};

export function stepKind(step: CustomLadderStep): StepKind {
  if (step.kind) return step.kind;
  if (step.post_id != null) return "local";
  if (step.position_role_id != null) return "rank";
  return "hcm";
}

export function stepKey(step: CustomLadderStep): string {
  return `${stepKind(step)}:${step.post_id ?? step.position_role_id ?? step.position_id}`;
}

/** Move `from` to `to`, resequencing. Exported for its test — an off-by-one here
 *  silently reorders who signs first. */
export function reorder(steps: CustomLadderStep[], from: number,
                        to: number): CustomLadderStep[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) {
    return steps;
  }
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.map((step, index) => ({ ...step, sequence: index + 1 }));
}

export function StepList({ steps, onChange, ranks }: {
  steps: CustomLadderStep[];
  onChange: (steps: CustomLadderStep[]) => void;
  /** The palette's ranks, to name a step whose rank belongs to another project. */
  ranks?: FlowRung[];
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  if (steps.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line py-8 text-center text-sm text-muted">
        No steps yet
      </p>
    );
  }

  return (
    <ol className="space-y-1.5">
      {steps.map((step, index) => {
        const kind = stepKind(step);
        const seats = step.holders ?? [];
        const foreign = kind === "rank"
          ? ranks?.find((r) => r.id === step.position_role_id && r.other_project)
          : undefined;
        return (
          <li
            key={stepKey(step)}
            draggable
            onDragStart={() => setDragging(index)}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onDragOver={(event) => { event.preventDefault(); setOver(index); }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging != null) onChange(reorder(steps, dragging, index));
              setDragging(null);
              setOver(null);
            }}
            className={`flex items-center gap-2.5 rounded-lg border bg-content1 px-3 py-2.5 transition-colors ${
              over === index && dragging !== index
                ? "border-primary"
                : "border-line/70"
            } ${dragging === index ? "opacity-40" : ""}`}
          >
            <GripVertical size={15} className="shrink-0 cursor-grab text-muted" />
            <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{step.name}</p>
              <p className="truncate text-xs text-muted">
                {KIND_LABEL[kind]}
                {seats.length > 0 && ` · ${seats.map((h) => h.name).join(", ")}`}
                {foreign && (
                  <span className="text-warn">
                    {" "}· {foreign.project_name ?? "another project"}'s rank, not on this
                    project's line, will be skipped
                  </span>
                )}
                {seats.length === 0 && kind !== "rank" && (
                  <span className="text-warn"> · nobody seated, will be skipped</span>
                )}
              </p>
            </div>
            <IconButton label="Move up" disabled={index === 0}
                        onClick={() => onChange(reorder(steps, index, index - 1))}>
              <ArrowUp size={14} />
            </IconButton>
            <IconButton label="Move down" disabled={index === steps.length - 1}
                        onClick={() => onChange(reorder(steps, index, index + 1))}>
              <ArrowDown size={14} />
            </IconButton>
            <IconButton
              label={`Remove ${step.name}`}
              onClick={() => onChange(
                steps.filter((_, i) => i !== index)
                     .map((s, i) => ({ ...s, sequence: i + 1 })),
              )}
            >
              <X size={14} />
            </IconButton>
          </li>
        );
      })}
    </ol>
  );
}

function IconButton({ label, disabled, onClick, children }: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-11 w-8 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-content2 hover:text-body disabled:pointer-events-none disabled:opacity-25"
    >
      {children}
    </button>
  );
}
