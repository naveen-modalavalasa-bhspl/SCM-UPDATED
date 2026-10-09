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
 *
 * `awardPending` is the one thing the status cannot say on its own. An award waiting on
 * its own sign-off is left on QUOTING deliberately — an overruled award unwinds to the
 * tender — so the status alone lit "Quotes from providers" while the tender was closed
 * and the only press left was this desk's. It stands on "Provider accepts" instead,
 * which is where the Approve award button is and where the provider answers next.
 */
export function FlowStepper({
  mode, status, awardPending = false, manualCourier = false,
}: {
  mode: string;
  status: string;
  awardPending?: boolean;
  manualCourier?: boolean;
}) {
  const { data: stages } = useQuery({
    queryKey: ["transport-flow", mode, manualCourier],
    queryFn: () => transportApi.flow(mode, manualCourier),
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

  // Which rung, and whether the desk's own half of it is still outstanding. The award
  // stage is the only one that can be reached without the status naming it, so it is
  // looked up by key rather than inferred from a position in the list — a hand-over
  // has no such stage at all, and must fall back to what its status says.
  const awardStage = stages.findIndex((stage) => stage.key === "CONFIRM");
  const pendingHere = awardPending && awardStage >= 0;
  const current = Math.max(
    0,
    pendingHere ? awardStage : stages.findIndex((stage) => stage.statuses.includes(status)),
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
                      rather than as eight disconnected circles. It wears the same
                      `--color-step-done-rail` the indent rail does (index.css) —
                      the one light value in that set, because a rail drawn at the
                      dots' own strength turns the row into a bar chart. */}
                  <span
                    className={`h-0.5 flex-1 ${index === 0 ? "bg-transparent"
                      : done || here ? "bg-step-done-rail" : "bg-line"}`}
                    aria-hidden
                  />
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition ${
                      done
                        ? "border-transparent bg-step-done text-white"
                        : here
                          ? "border-transparent bg-step-live text-white ring-4 ring-step-live/20"
                          : "border-line bg-content2 text-muted"
                    }`}
                  >
                    {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
                  </span>
                  <span
                    className={`h-0.5 flex-1 ${index === stages.length - 1
                      ? "bg-transparent" : done ? "bg-step-done-rail" : "bg-line"}`}
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
                    {(pendingHere && stage.pending_help) || stage.help}
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
