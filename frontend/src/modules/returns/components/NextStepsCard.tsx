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
 * ALMOST STATIC COPY: only the first step's sentence varies, and only with the ANSWER
 * given in step 1 (see `APPROVER_DETAIL`). It describes the ROUTE a return takes, not
 * the state of any document — there is no document yet on this screen. It deliberately draws no ticks, no colours
 * and no current-step marker: `ReturnStepper` and `ApprovalFlowPanel` are the two things
 * allowed to say where a return has actually reached, both off served state, and a third
 * thing in the browser guessing at it is exactly what CLAUDE.md warns against.
 *
 * The wording is the module's own — the labels in `constants.STATUS_LABEL` and the desks
 * named in `constants.QUEUE`, in the order `enums.PHASES` puts them.
 */
/**
 * Who signs the first stage — the one sentence on this card that is NOT the same for
 * every return.
 *
 * ADDED 2026-09-12. The card said "the same people who approved the indent" whatever
 * had been answered in step 1, which is only true of a return raised against one: a
 * return raised on its own travels the stock return's own chain, and the card was
 * telling that raiser their request was going to approvers of an indent they had
 * explicitly declined to name.
 *
 * It reads the ANSWER, never the resolved chain. Who those people actually are is the
 * workflow engine's to say, on the submitted document — this is a sentence about the
 * route, and a screen guessing at names would be the forecast panel that was removed
 * from this form in the first place.
 */
const APPROVER_DETAIL = {
  indent: "Approvers from that indent's own approval path sign it first.",
  own: "Your reporting line signs it, on the stock return's own approval chain.",
  unanswered: "Your reporting line signs it — answer “Against indent” to see which chain.",
} as const;

export type ApprovalRoute = keyof typeof APPROVER_DETAIL;

const STEPS: { title: string; detail: string }[] = [
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

export function NextStepsCard({
  route = "unanswered",
  className = "",
}: {
  /** Which approval chain step 1's answer puts the return on. */
  route?: ApprovalRoute;
  className?: string;
}) {
  // FIX 2026-09-08: the APPROVAL FLOW panel was removed from the form, so nothing here
  // points at it. The signed flow is shown on the return once it has been submitted.
  const steps = [
    { title: "Pending approval", detail: APPROVER_DETAIL[route] },
    ...STEPS,
  ];
  return (
    <Card className={className}>
      <CardBody className="gap-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          After you submit
        </h2>
        <ol className="space-y-3">
          {steps.map((step, index) => (
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
