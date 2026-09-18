import { CardBody } from "@heroui/react";
import { Card } from "@/shared/components";

/**
 * What happens to this return after the raiser presses Submit.
 *
 * ADDED 2026-09-07, for the right-hand rail of the raise form. A storekeeper raising a
 * return is handing material away and is told nothing about where it goes or who sees
 * it, so the commonest question at the branch is "what happens now" — asked of a person,
 * after the fact, because the screen never said. Four sentences answer it.
 *
 * STATIC COPY. It describes the ROUTE every return takes, not the state of any document
 * — there is no document yet on this screen. It deliberately draws no ticks, no colours
 * and no current-step marker: `ReturnStepper` and `ApprovalFlowPanel` are the two things
 * allowed to say where a return has actually reached, both off served state, and a third
 * thing in the browser guessing at it is exactly what CLAUDE.md warns against.
 *
 * The wording is the module's own — the labels in `constants.STATUS_LABEL` and the desks
 * named in `constants.QUEUE`, in the order `enums.PHASES` puts them.
 */
const STEPS: { title: string; detail: string }[] = [
  {
    title: "Pending approval",
    // FIX 2026-09-08: the APPROVAL FLOW panel was removed from the form, so this no
    // longer points at it. The signed flow is shown on the return after submission.
    detail: "Your reporting line signs it — the same people who approved the indent.",
  },
  {
    title: "Decision desk",
    detail: "SCM decides where the material goes — another stocking point, the vendor, or written off.",
  },
  {
    title: "Dispatched",
    detail: "Logistics books a vehicle and the stock leaves your shelf.",
  },
  {
    title: "Completed",
    detail: "The receiving point acknowledges it and the return closes.",
  },
];

export function NextStepsCard({ className = "" }: { className?: string }) {
  return (
    <Card className={className}>
      <CardBody className="gap-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          After you submit
        </h2>
        <ol className="space-y-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-content2 text-[10px] font-bold text-muted"
              >
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-body">{step.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                  {step.detail}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
