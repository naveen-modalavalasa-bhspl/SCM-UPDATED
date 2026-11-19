import { BadgeCheck, PencilLine, RotateCcw, Sparkles } from "lucide-react";
import { Input } from "@/shared/components";

/**
 * The gate pass number, SHOWN before the press (2026-11-19).
 *
 * It used to be an empty box saying "leave blank to issue the next dispatch
 * number" — so the desk wrote the pass out without knowing what it would say. Now
 * the box opens on the number the press will issue (`/dispatch-number/preview`,
 * the DSP series, read without drawing it), tagged **Auto**. "Use my own" turns it
 * into a box to type security's own number; "Back to auto" undoes that.
 *
 * Auto is a preview, and says so: if another desk dispatches first, this one is
 * given the next number, and the outcome panel shows the one it actually got. A
 * shipment that already carries a number shows it as **Issued**, fixed.
 */
export type GatePassMode = "auto" | "own";

export function GatePassNumberField({
  mode, value, preview, final, loading, disabled, onModeChange, onChange,
}: {
  mode: GatePassMode;
  value: string;
  /** The number the press will issue, or the one already issued (`final`). */
  preview?: string | null;
  final?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onModeChange: (mode: GatePassMode) => void;
  onChange: (value: string) => void;
}) {
  if (final && preview) {
    return (
      <div className="block">
        <span className="mb-1.5 block text-sm font-medium text-body">Gate pass no</span>
        <div className="flex min-h-11 items-center gap-2 rounded-xl border border-ok/30 bg-ok-bg/50 px-3">
          <BadgeCheck className="h-4 w-4 shrink-0 text-ok" aria-hidden />
          <span className="mono truncate text-sm font-bold text-ink">{preview}</span>
          <span className="ml-auto rounded-full bg-ok/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ok">
            Issued
          </span>
        </div>
        <span className="mt-1 block text-xs text-muted">This shipment's pass number. It does not change.</span>
      </div>
    );
  }

  return (
    <div className="block">
      <span className="mb-1.5 flex items-center justify-between gap-2 text-sm font-medium text-body">
        Gate pass no
        {!disabled && (
          <button type="button"
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-brand hover:bg-brand/5"
            onClick={() => {
              if (mode === "auto") {
                onModeChange("own");
              } else {
                onChange("");
                onModeChange("auto");
              }
            }}>
            {mode === "auto"
              ? <><PencilLine className="h-3.5 w-3.5" aria-hidden /> Use my own</>
              : <><RotateCcw className="h-3.5 w-3.5" aria-hidden /> Back to auto</>}
          </button>
        )}
      </span>
      {mode === "auto" ? (
        <div className="flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-brand/30 bg-brand/[0.03] px-3"
             aria-live="polite">
          <Sparkles className="h-4 w-4 shrink-0 text-brand" aria-hidden />
          {loading ? (
            <span className="h-4 w-40 animate-pulse rounded bg-content3" aria-label="Working out the next number" />
          ) : (
            <span className="mono truncate text-sm font-bold text-ink" title={preview ?? undefined}>
              {preview || "Next DSP number"}
            </span>
          )}
          <span className="ml-auto shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand">
            Auto
          </span>
        </div>
      ) : (
        <Input autoFocus value={value} disabled={disabled}
               placeholder="Type the number security wrote"
               aria-label="Gate pass no"
               onChange={(event) => onChange(event.target.value)} />
      )}
      <span className="mt-1 block text-xs text-muted">
        {mode === "auto"
          ? "Issued when you dispatch. If another desk dispatches first, you get the next one."
          : "Your number goes on the pass instead of the automatic one."}
      </span>
    </div>
  );
}
