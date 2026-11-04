import type { RunStatus } from "@/components/run/types";

export const STEPS = ["Inputs", "Checks", "Questions", "Review", "Done"] as const;
export type StepName = (typeof STEPS)[number];

/**
 * The step to show as current. The checks step is open only while the user is looking at check results,
 * and a checked run is ready for its questions.
 */
export function currentStep(status: RunStatus, checksOpen: boolean): StepName {
  if (checksOpen && (status === "inputs" || status === "checked")) return "Checks";
  switch (status) {
    case "inputs":
      return "Inputs";
    case "checked":
    case "questions":
      return "Questions";
    case "review":
    case "creating":
      return "Review";
    case "done":
      return "Done";
  }
}

/** The stepper: the steps before the current one are complete, and the current one is marked. */
export function Stepper({ current }: { current: StepName }) {
  const currentIndex = STEPS.indexOf(current);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Breakdown progress">
      {STEPS.map((step, index) => {
        const isCurrent = index === currentIndex;
        const complete = index < currentIndex;
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              aria-current={isCurrent ? "step" : undefined}
              className={`rounded-full px-3 py-1 font-medium ${
                isCurrent
                  ? "bg-neutral-900 text-white"
                  : complete
                    ? "bg-neutral-200 text-neutral-800"
                    : "bg-white text-neutral-500 ring-1 ring-neutral-300"
              }`}
            >
              {step}
            </span>
            {index < STEPS.length - 1 ? <span aria-hidden="true" className="text-neutral-400">→</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
