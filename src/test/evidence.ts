import { appendFileSync } from "node:fs";
import { expect } from "vitest";

/**
 * Evidence for scripts/evaluate-security-e2e.cjs.
 *
 * Each scenario test records what it actually observed — an HTTP status, the
 * rows left in the database, a policy decision — next to what the security
 * claim requires. Every attack is paired with a control, an operation that
 * must succeed, so a system that refuses everything cannot pass.
 *
 * Records go to SECURITY_EVIDENCE_FILE as JSON lines when the runner sets it,
 * and nowhere otherwise, so the scenarios also run as ordinary tests. Nothing
 * here redacts: the runner scans every record for the fixture secrets
 * registered below and for credential patterns, and fails the run if any
 * appears, rather than hiding a leak by masking it.
 */

type Observation = {
  /** What the claim requires, in words. */
  expected: string;
  /** What happened, as measured: status codes, rows, decisions. */
  actual: unknown;
};

type Kind = "attack" | "control";

function write(record: Record<string, unknown>) {
  const file = process.env.SECURITY_EVIDENCE_FILE;
  if (file) appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function evidence(scenario: string) {
  const save = (kind: Kind, held: boolean, step: string, observation: Observation) => {
    write({
      type: "observation",
      scenario,
      test: expect.getState().currentTestName,
      kind,
      step,
      held,
      ...observation,
    });
  };
  return {
    /** An unauthorized operation; `refused` is whether it was. */
    attack: (step: string, o: Observation & { refused: boolean }) => save("attack", o.refused, step, o),
    /** The legitimate operation beside it; `allowed` is whether it worked. */
    control: (step: string, o: Observation & { allowed: boolean }) => save("control", o.allowed, step, o),
  };
}

/**
 * A secret value a scenario uses as a fixture. The runner checks that none
 * of these appears in the evidence it publishes.
 */
export function fixtureSecret(value: string): string {
  write({ type: "fixture-secret", value });
  return value;
}

/** The outcome of a call that may throw, as data: what an observer would see. */
export async function outcome<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    // Drizzle wraps a database error in "Failed query: <the whole SQL>"; the
    // database's own reason is the part worth recording.
    if (err instanceof Error && err.message.startsWith("Failed query") && err.cause instanceof Error) {
      return { ok: false, error: `database refused: ${err.cause.message}` };
    }
    return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}
