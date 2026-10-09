/** Urgent / Normal / All, as a segmented control.
 *
 *  A segmented control rather than a dropdown: there are three states, they are always
 *  worth seeing at once, and an approver rationing scarce stock switches between them
 *  constantly. Shared by the two consolidation screens that triage indents — serve
 *  from own stock, and one item's requesters — so both read the same.
 */
export const PRIORITIES = ["URGENT", "NORMAL"] as const;

export function PriorityFilter({ value, onChange }: {
  /** "" is All. Anything else is a `Priority` enum value. */
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter by priority"
      className="flex items-center gap-1 rounded-lg border border-line bg-content2 p-1"
    >
      {["", ...PRIORITIES].map((option) => (
        <button
          key={option || "all"}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`h-8 rounded-md px-3 text-xs font-semibold capitalize transition-colors ${
            value === option ? "bg-content1 text-ink shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          {option ? option.toLowerCase() : "All"}
        </button>
      ))}
    </div>
  );
}

/** The one-word flag on an urgent row. Normal priority shows nothing — a badge on
 *  every row is a badge on none. */
export function PriorityTag({ priority }: { priority?: string | null }) {
  if (priority !== "URGENT") return null;
  return (
    <span className="rounded-full bg-bad-bg px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-bad">
      Urgent
    </span>
  );
}
