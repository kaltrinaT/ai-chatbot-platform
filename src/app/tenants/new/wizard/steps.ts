/**
 * Wizard step metadata and the per-step field map.
 *
 * FIELDS_BY_STEP is the single source of truth for "which step owns which
 * field". The wizard uses it in both directions: to decide whether Continue
 * may advance, and — when the server rejects a submission — to jump back to
 * the earliest step that actually contains a rejected field, so an error is
 * never reported on a step where the user cannot see the offending input.
 */

export const STEPS = [
  { n: 1, title: "Cloud Prerequisites" },
  { n: 2, title: "Cloud Configuration" },
  { n: 3, title: "LLM & Vector Store" },
  { n: 4, title: "Review & Estimate" },
  { n: 5, title: "Deploy" },
] as const;

export const LAST_INPUT_STEP = 4;

export const FIELDS_BY_STEP: Record<number, readonly string[]> = {
  1: ["cloudProvider"],
  2: [
    "name",
    "slug",
    "chatbotVersion",
    "domain",
    // AWS
    "awsAccountId",
    "awsRegion",
    "deploymentRoleArn",
    "s3DocsPrefix",
    "acmCertificateArn",
    // Azure
    "azureSubscriptionId",
    "azureTenantId",
    "azureClientId",
    "azureClientSecret",
    "azureRegion",
  ],
  3: [
    "llmProvider",
    "llmApiKey",
    "llmModel",
    "vectorStore",
    "pineconeApiKey",
  ],
  // "_form" is not an input. It carries a failure that belongs to the
  // submission as a whole rather than to any one field — provisioning against
  // the customer's cloud, or dispatching the deploy. Owned by the review step
  // so earliestStepForFields leaves the user on Review, where they pressed the
  // button, instead of bouncing them to step 1 with nothing to correct.
  4: ["_form"],
};

/** Fields that must be non-empty before Continue will advance past a step. */
export const REQUIRED_BY_STEP: Record<number, readonly string[]> = {
  1: ["cloudProvider"],
  2: ["name", "slug"],
  3: ["llmProvider", "llmApiKey"],
  4: [],
};

/** Extra per-cloud requirements layered onto REQUIRED_BY_STEP for step 2. */
export const REQUIRED_BY_CLOUD: Record<"aws" | "azure", readonly string[]> = {
  aws: ["awsAccountId", "awsRegion", "deploymentRoleArn"],
  azure: [
    "azureSubscriptionId",
    "azureTenantId",
    "azureClientId",
    "azureClientSecret",
    "azureRegion",
  ],
};

/** The step that owns `field`, or null when no step does. */
export function stepForField(field: string): number | null {
  for (const step of Object.keys(FIELDS_BY_STEP).map(Number).sort((a, b) => a - b)) {
    if (FIELDS_BY_STEP[step].includes(field)) return step;
  }
  return null;
}

/**
 * Earliest step containing any of `fields`. Used to route server validation
 * errors back to a step where the user can actually fix them; falls back to
 * the first step rather than leaving the user on the review screen with an
 * error they cannot reach.
 */
export function earliestStepForFields(fields: string[]): number {
  const steps = fields
    .map(stepForField)
    .filter((s): s is number => s !== null);
  return steps.length > 0 ? Math.min(...steps) : 1;
}
