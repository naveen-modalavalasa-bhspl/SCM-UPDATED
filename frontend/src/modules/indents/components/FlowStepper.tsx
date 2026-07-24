import { Check, X } from "lucide-react";

/** The document lifecycle, made visible. Order carries real meaning here — an indent
 * genuinely moves DRAFT -> PENDING -> APPROVED, so a stepper (not decoration) fits. */
const FLOW = ["DRAFT", "PENDING_APPROVAL", "APPROVED"] as const;
const LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "In approval",
  APPROVED: "Approved",
};

export function FlowStepper({ status }: { status: string }) {
  const rejected = status === "REJECTED";
  const currentIdx = rejected ? 1 : Math.max(0, FLOW.indexOf(status as (typeof FLOW)[number]));

  return (
    <div className="flex items-center">
      {FLOW.map((step, i) => {
        const done = i < currentIdx || status === "APPROVED";
        const active = i === currentIdx && !rejected;
        const isRejectSlot = rejected && i === 1;
        return (
          <div key={step} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={`grid h-8 w-8 place-items-center rounded-full border text-xs font-bold transition-colors ${
                  isRejectSlot
                    ? "border-bad bg-bad text-white"
                    : done
                      ? "border-ok bg-ok text-white"
                      : active
                        ? "border-brand bg-brand text-white"
                        : "border-line bg-white text-muted"
                }`}
              >
                {isRejectSlot ? <X className="h-4 w-4" /> : done ? <Check className="h-4 w-4" /> : i + 1}
              </span>
              <span
                className={`text-[11px] font-medium ${active || done || isRejectSlot ? "text-body" : "text-muted"}`}
              >
                {isRejectSlot ? "Rejected" : LABEL[step]}
              </span>
            </div>
            {i < FLOW.length - 1 && (
              <div
                className={`mx-2 h-0.5 flex-1 rounded ${i < currentIdx ? "bg-ok" : "bg-line"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
