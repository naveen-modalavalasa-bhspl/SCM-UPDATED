import { Select } from "@/shared/components";
import type { ReturnTarget } from "@/modules/approvals/types";

/** The step an indent goes back to, as a dropdown.
 *
 *  Nearest step first, with the requester last — the order the indent travelled in,
 *  reversed. The step just below is the default, so a person who only wants to send it
 *  back one step never has to open the list. With a single possible destination there is
 *  nothing to choose, so it is stated rather than offered. */
export function targetLabel(target: ReturnTarget): string {
  const who = target.owner_name ?? "—";
  return target.is_requester ? `Requester — ${who}` : `${target.stage_name ?? "Step"} — ${who}`;
}

export function ReturnTargetSelect({
  targets, value, onChange, label = "Send back to",
}: {
  targets: ReturnTarget[];
  /** The chosen step; null means "the default". */
  value: number | null;
  onChange: (sequence: number) => void;
  label?: string;
}) {
  if (targets.length === 0) return null;
  const ordered = [...targets].reverse();
  const chosen = value ?? targets.find((target) => target.is_default)?.sequence ?? ordered[0].sequence;

  if (targets.length === 1) {
    return (
      <div className="mb-4 text-sm">
        <p className="font-semibold text-ink">{label}</p>
        <p className="mt-1 rounded-xl border border-line bg-content2 px-3 py-2 text-ink">
          {targetLabel(targets[0])}
        </p>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <p className="mb-2 text-sm font-semibold text-ink">{label}</p>
      <Select
        ariaLabel={label}
        searchable={false}
        value={String(chosen)}
        onChange={(next) => { if (next !== "") onChange(Number(next)); }}
        options={ordered.map((target) => ({
          value: String(target.sequence),
          label: `${targetLabel(target)}${target.is_default ? "  (previous step)" : ""}`,
        }))}
      />
    </div>
  );
}
