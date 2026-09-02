import { Check } from "lucide-react";
import type { GettingStartedStep } from "../_data/selectors";

export default function GettingStarted({ steps }: { steps: GettingStartedStep[] }) {
  // The first not-yet-done step is highlighted as "current" (blue ring),
  // matching the design — completed steps are green checks, later ones gray.
  const currentIndex = steps.findIndex((s) => !s.done);

  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="mb-5">
        <h2 className="text-sm font-semibold">Getting Started</h2>
        <p className="text-xs text-gray-500">Follow these steps to deploy your first chatbot</p>
      </div>

      <ol className="flex items-start">
        {steps.map((step, i) => {
          const isCurrent = i === currentIndex;
          const circle = step.done
            ? "border-2 border-green-500 bg-green-500 text-white"
            : isCurrent
              ? "border-2 border-blue-500 bg-white text-blue-600"
              : "border-2 border-gray-200 bg-white text-gray-400";

          const body = (
            <div className="flex w-28 flex-col items-center text-center">
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${circle}`}
              >
                {step.done ? <Check className="h-5 w-5" /> : i + 1}
              </div>
              <div className="mt-2 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                Step {i + 1}
              </div>
              <div className="text-xs font-semibold text-gray-900">{step.label}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-gray-500">{step.description}</div>
            </div>
          );

          return (
            <li key={step.label} className="flex flex-1 items-start last:flex-none">
              {step.href ? (
                <a href={step.href} target="_blank" rel="noreferrer" className="hover:opacity-80">
                  {body}
                </a>
              ) : (
                body
              )}
              {i < steps.length - 1 && <div className="mt-[18px] h-px flex-1 bg-gray-200" />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
