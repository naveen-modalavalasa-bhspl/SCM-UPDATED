import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Card } from "@/shared/components";
import { transportApi } from "../api";

/**
 * Where this consignment has got to, drawn as the flow it is actually in.
 *
 * The stages come from `GET /api/transport/flow?mode=` — a third-party shipment has
 * two the others do not (the tender, and the carrier saying yes), and the screen must
 * not be the thing that decides that. A hand-over drawing a "Quotes" step nobody can
 * ever complete is exactly what a locally-held copy of this list produces.
 *
 * A rejected or cancelled request is not a stage of the flow, it is the flow stopping,
 * so it renders as a single line rather than as a stepper with a red dot somewhere in
 * the middle of it.
 */
export function FlowStepper({ mode, status }: { mode: string; status: string }) {
  const { data: stages } = useQuery({
    queryKey: ["transport-flow", mode],
    queryFn: () => transportApi.flow(mode),
  });

  const stopped = ["REJECTED", "CANCELLED"].includes(status);
  if (stopped) {
    return (
      <Card className="mb-4 border-rose-200 bg-rose-50/70 p-4 dark:border-rose-900 dark:bg-rose-900/20">
        <p className="text-sm font-semibold text-rose-800 dark:text-rose-200">
          {status === "REJECTED"
            ? "This request was rejected — it never went out."
            : "This request was cancelled."}
        </p>
      </Card>
    );
  }

  if (!stages?.length) return null;

  const current = Math.max(
    0,
    stages.findIndex((stage) => stage.statuses.includes(status)),
  );

  return (
    <Card className="mb-4 overflow-x-auto p-4">
      <ol className="flex min-w-[640px] items-start gap-1">
        {stages.map((stage, index) => {
          const done = index < current;
          const here = index === current;
          return (
            <li key={stage.key} className="flex min-w-0 flex-1 items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col items-center text-center">
                <div className="flex w-full items-center">
                  {/* The rail either side of the dot, so the line reads as one track
                      rather than as eight disconnected circles. */}
                  <span
                    className={`h-0.5 flex-1 ${index === 0 ? "bg-transparent"
                      : done || here ? "bg-brand" : "bg-line"}`}
                    aria-hidden
                  />
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition ${
                      done
                        ? "bg-brand text-white"
                        : here
                          ? "bg-brand text-white ring-4 ring-brand/20"
                          : "bg-content2 text-muted"
                    }`}
                  >
                    {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
                  </span>
                  <span
                    className={`h-0.5 flex-1 ${index === stages.length - 1
                      ? "bg-transparent" : done ? "bg-brand" : "bg-line"}`}
                    aria-hidden
                  />
                </div>
                <span
                  className={`mt-1.5 text-[11px] font-semibold leading-tight ${
                    here ? "text-ink" : done ? "text-body" : "text-muted"
                  }`}
                >
                  {stage.label}
                </span>
                {here && (
                  <span className="mt-0.5 text-[10px] leading-tight text-muted">
                    {stage.help}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
