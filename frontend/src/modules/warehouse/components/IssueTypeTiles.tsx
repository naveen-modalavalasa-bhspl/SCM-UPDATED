import { ArrowLeftRight, ClipboardList, PackageOpen, Truck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * What a material issue SERVES, chosen as one of four tiles (2026-10-29).
 *
 * The backend still knows two issue types — INDENT_BASED and DIRECT — and that is
 * right: an STR is an indent underneath, and an STO's issue carries no indent. The four
 * are how the floor tells them apart, and each one changes what the form asks for:
 *
 *   INDENT  a project / department indent   → the indent picker, regular indents only
 *   STR     a Stock Transfer Request        → the indent picker, STRs only
 *   STO     a direct Stock Transfer Order   → the STO number; destination frozen on it
 *   DIRECT  nothing behind it               → destination and issued-to are required
 */
export type IssueMode = "INDENT" | "STR" | "STO" | "DIRECT";

const MODES: { mode: IssueMode; title: string; caption: string; icon: LucideIcon; tone: string }[] = [
  { mode: "STR", title: "Stock Transfer Request", caption: "Serve an approved STR",
    icon: ArrowLeftRight, tone: "text-info bg-info-bg" },
  { mode: "STO", title: "Stock Transfer Order", caption: "Execute a direct STO",
    icon: Truck, tone: "text-brand bg-brand/10" },
  { mode: "INDENT", title: "Indent", caption: "Project or department indent",
    icon: ClipboardList, tone: "text-ok bg-ok-bg" },
  { mode: "DIRECT", title: "Direct issue", caption: "Ad-hoc, nothing behind it",
    icon: PackageOpen, tone: "text-warn bg-warn-bg" },
];

export const ISSUE_MODE_LABEL: Record<IssueMode, string> = {
  STR: "Stock Transfer Request (STR)",
  STO: "Stock Transfer Order (STO)",
  INDENT: "Indent",
  DIRECT: "Direct issue",
};

export function IssueTypeTiles({ value, onChange, disabled }: {
  value: IssueMode;
  onChange: (mode: IssueMode) => void;
  /** A saved document's type is what it IS — shown, never changed. */
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Issue type"
         className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {MODES.map(({ mode, title, caption, icon: Icon, tone }) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled && !active}
            onClick={() => !disabled && onChange(mode)}
            className={`group relative flex min-h-[64px] items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${
              active
                ? "border-brand bg-gradient-to-br from-brand/10 to-content1 shadow-sm ring-1 ring-brand/30"
                : "border-line bg-content1 hover:border-brand/50 hover:shadow-sm"
            } ${disabled && !active ? "cursor-not-allowed opacity-40" : ""} ${disabled && active ? "cursor-default" : ""}`}
          >
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tone}`}>
              <Icon className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className={`block truncate text-sm font-semibold ${active ? "text-brand" : "text-ink"}`}>
                {title}
              </span>
              <span className="block truncate text-xs text-muted">{caption}</span>
            </span>
            {active && (
              <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-brand" aria-hidden />
            )}
          </button>
        );
      })}
    </div>
  );
}
