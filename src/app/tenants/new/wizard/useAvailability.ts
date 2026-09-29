import { useEffect, useState } from "react";

export type Availability = { available: true } | { available: false; reason: string };

/**
 * Whether the platform has confirmed a value is free. "idle" covers an empty
 * value and one the format rules already reject.
 */
export type AvailabilityStatus = "idle" | "checking" | "available" | "taken";

/**
 * Asks the server whether `value` is free, shortly after it stops changing.
 *
 * Used for the values the wizard cannot judge on its own — whether a slug or a
 * deployment identity already belongs to another chatbot. Only answers are
 * stored; "checking" is derived, so an answer about an older value never shows
 * against a newer one. `ask` must be stable across renders, or every render
 * restarts the wait.
 *
 * `scope` is whatever else the answer depends on — the cloud, for a slug,
 * since the names built from it differ — so switching it asks again rather
 * than showing an answer given for the other one.
 */
export function useAvailability(
  value: string,
  skip: boolean,
  ask: (value: string) => Promise<Availability>,
  scope = "",
) {
  const [answer, setAnswer] = useState<{ value: string; scope: string; result: Availability } | null>(null);

  const current = answer?.value === value && answer.scope === scope ? answer : null;
  const status: AvailabilityStatus =
    !value || skip ? "idle" : !current ? "checking" : current.result.available ? "available" : "taken";
  const reason = status === "taken" && current && !current.result.available ? current.result.reason : undefined;

  useEffect(() => {
    if (!value || skip) return;
    const timer = setTimeout(async () => {
      // A failed request is left unanswered: settle() asks again, and the
      // server checks once more before it writes anything.
      const result = await ask(value).catch(() => null);
      if (result) setAnswer({ value, scope, result });
    }, 400);
    return () => clearTimeout(timer);
  }, [value, skip, ask, scope]);

  /**
   * Whether the wizard may move on, asking now if the answer is not in yet.
   * An unreachable server lets it through: the server repeats the check on
   * submission, so this is a convenience rather than the control.
   */
  async function settle(): Promise<boolean> {
    if (status === "available" || status === "idle") return true;
    if (status === "taken") return false;
    const result = await ask(value).catch(() => null);
    if (!result) return true;
    setAnswer({ value, scope, result });
    return result.available;
  }

  return { status, reason, settle };
}
