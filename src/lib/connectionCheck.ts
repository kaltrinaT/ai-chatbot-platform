/**
 * The parts of a connection check the onboarding wizard needs in the browser.
 *
 * Kept apart from verifyConnection.ts, which dispatches and reads GitHub runs
 * and so imports the GitHub client: a Client Component that imported anything
 * from there pulled the server's GitHub code, and its Node-only dependencies,
 * into the browser bundle. Nothing here may import server code.
 */

/**
 * Exactly the wizard fields a check needs, and the only ones that may be sent
 * to start one.
 *
 * The wizard holds all its answers in one object, the LLM and Pinecone keys
 * among them. Handing that object to the check wholesale would put customer
 * API keys into a request that has no use for them — through request logs,
 * and through an action whose entire purpose is to prove that credentials do
 * not need to travel. The caller filters to this list; the server reads
 * nothing outside it either, so neither side alone is load-bearing.
 */
export const CONNECTION_CHECK_FIELDS = [
  "cloudProvider",
  "tenantId",
  "slug",
  "awsRegion",
  "deploymentRoleArn",
  "azureClientId",
  "azureTenantId",
  "azureSubscriptionId",
] as const;

/**
 * Status of a check in flight or finished. `pending` covers both "dispatched
 * but GitHub has not created the run yet" and "the run is going" — from the
 * caller's side they are the same state, and distinguishing them would only
 * invite a poller to treat one as an error.
 */
export type ConnectionCheck =
  | { status: "pending"; runUrl: string | null }
  | { status: "connected"; runUrl: string }
  | { status: "failed"; runUrl: string | null; reason: string }
  | { status: "unknown"; runUrl: string | null; reason: string };
