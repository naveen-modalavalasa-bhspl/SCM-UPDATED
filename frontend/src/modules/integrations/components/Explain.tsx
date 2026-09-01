import type { ComponentType, ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Card, TONES, type Tone } from "@/shared/components";

/**
 * The two teaching surfaces this console was missing.
 *
 * Everything on these screens — application, endpoint, key, scope, webhook — is a
 * word from the integration trade, and the screen used none of its space to say what
 * any of them mean. An admin who has never built an API against SCM landed on a table
 * of codes and key counts and had to guess both the vocabulary and the ORDER of the
 * work. What the console does is not complicated; it was simply never stated.
 *
 * Two shapes, deliberately small:
 *
 *   `DirectionNote` — one paragraph that says which way the data moves, drawn as
 *   `SCM → them` or `them → SCM`, because "integration" on its own does not say
 *   whether the outside system is reading or writing, and that is the single fact
 *   everything else on the screen hangs off.
 *
 *   `Steps` — the order of the work, numbered. Registering an application is step one
 *   of three, and until a key exists and an API is built the row is inert. Three
 *   numbers spend a line and a half saying so.
 *
 * Both are read-outs. Nothing here fetches, decides or gates — they can be deleted
 * without changing what the console does, which is the test a teaching surface
 * has to pass.
 */

export function DirectionNote({
  icon: Icon, title, from, to, children, tone = "brand",
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  /** Left of the arrow — where the data starts. */
  from: string;
  /** Right of the arrow — where it lands. */
  to: string;
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${TONES[tone]}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-display text-base font-bold text-ink">{title}</span>
            {/* The direction, drawn rather than described. Two words and an arrow
                answer "who calls whom" faster than the sentence under it can. */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-content2
                             px-2.5 py-1 text-[11px] font-semibold text-muted">
              {from}
              <ArrowRight className="h-3 w-3 text-brand" />
              {to}
            </span>
          </div>
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-body">{children}</p>
        </div>
      </div>
    </Card>
  );
}

export interface Step {
  title: string;
  note: string;
  /** Drawn as done when known. Omitted entirely on a screen that lists many rows,
   *  where there is no single thing to be part-way through. */
  done?: boolean;
}

/** The order of the work. On a detail screen the ticks are real — they read the
 *  application's own counts — so the strip doubles as "what is left to do here". */
export function Steps({ steps, className = "" }: { steps: Step[]; className?: string }) {
  return (
    <ol className={`grid gap-2 sm:grid-cols-3 ${className}`}>
      {steps.map((step, index) => (
        <li key={step.title}
            className={`flex items-start gap-2.5 rounded-xl border p-3 ${
              step.done
                ? "border-ok/30 bg-ok-bg/40"
                : "border-line/70 bg-content2/40"}`}>
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px]
                            font-bold ${step.done ? "bg-ok text-white" : "bg-content1 text-muted"}`}>
            {step.done ? "✓" : index + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">{step.title}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted">{step.note}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
