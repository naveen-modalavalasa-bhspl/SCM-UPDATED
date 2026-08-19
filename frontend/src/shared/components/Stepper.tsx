import { Check } from "lucide-react";

export interface Step {
  id: string;
  label: string;
  status: "complete" | "current" | "upcoming" | "error";
  description?: string;
}

export function Stepper({ steps, className = "" }: { steps: Step[]; className?: string }) {
  return (
    <div className={`py-6 px-4 sm:px-6 w-full ${className}`}>
      <nav aria-label="Progress">
        <ol role="list" className="flex items-center">
          {steps.map((step, stepIdx) => (
            <li
              key={step.id}
              className={`relative ${stepIdx !== steps.length - 1 ? "pr-8 sm:pr-20" : ""}`}
            >
              {step.status === "complete" ? (
                <>
                  <div
                    className="absolute inset-0 flex items-center"
                    aria-hidden="true"
                  >
                    <div className="h-0.5 w-full bg-brand" />
                  </div>
                  <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-brand hover:bg-brand-hover transition-colors shadow-md shadow-brand/30">
                    <Check className="h-4 w-4 text-white" aria-hidden="true" />
                    <span className="sr-only">{step.label}</span>
                  </div>
                  <div className="absolute top-10 left-1/2 -translate-x-1/2 text-center whitespace-nowrap">
                    <p className="text-xs font-semibold text-ink">{step.label}</p>
                    {step.description && (
                      <p className="text-[10px] text-muted mt-0.5">{step.description}</p>
                    )}
                  </div>
                </>
              ) : step.status === "current" ? (
                <>
                  <div
                    className="absolute inset-0 flex items-center"
                    aria-hidden="true"
                  >
                    <div className="h-0.5 w-full bg-line" />
                  </div>
                  <div
                    className="relative flex h-8 w-8 items-center justify-center rounded-full border-2 border-brand bg-content1 shadow-md shadow-brand/10 shadow-[0_0_0_4px_rgba(23,190,187,0.1)]"
                    aria-current="step"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full bg-brand"
                      aria-hidden="true"
                    />
                    <span className="sr-only">{step.label}</span>
                  </div>
                  <div className="absolute top-10 left-1/2 -translate-x-1/2 text-center whitespace-nowrap">
                    <p className="text-xs font-semibold text-brand">{step.label}</p>
                    {step.description && (
                      <p className="text-[10px] text-brand/70 mt-0.5">{step.description}</p>
                    )}
                  </div>
                </>
              ) : step.status === "error" ? (
                <>
                  <div
                    className="absolute inset-0 flex items-center"
                    aria-hidden="true"
                  >
                    <div className="h-0.5 w-full bg-line" />
                  </div>
                  <div className="relative flex h-8 w-8 items-center justify-center rounded-full border-2 border-bad bg-content1 shadow-[0_0_0_4px_rgba(240,62,62,0.1)]">
                    <span
                      className="h-2.5 w-2.5 rounded-full bg-bad"
                      aria-hidden="true"
                    />
                    <span className="sr-only">{step.label}</span>
                  </div>
                  <div className="absolute top-10 left-1/2 -translate-x-1/2 text-center whitespace-nowrap">
                    <p className="text-xs font-semibold text-bad">{step.label}</p>
                    {step.description && (
                      <p className="text-[10px] text-bad/70 mt-0.5">{step.description}</p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div
                    className="absolute inset-0 flex items-center"
                    aria-hidden="true"
                  >
                    <div className="h-0.5 w-full bg-line" />
                  </div>
                  <div className="relative flex h-8 w-8 items-center justify-center rounded-full border-2 border-line bg-content1 hover:border-line-hover transition-colors">
                    <span
                      className="h-2.5 w-2.5 rounded-full bg-transparent"
                      aria-hidden="true"
                    />
                    <span className="sr-only">{step.label}</span>
                  </div>
                  <div className="absolute top-10 left-1/2 -translate-x-1/2 text-center whitespace-nowrap">
                    <p className="text-xs font-medium text-muted">{step.label}</p>
                    {step.description && (
                      <p className="text-[10px] text-muted/70 mt-0.5">{step.description}</p>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}
