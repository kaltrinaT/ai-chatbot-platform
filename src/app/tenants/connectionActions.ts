"use server";

/**
 * Starting and reading a connection check, from the wizard and from the
 * tenant page alike.
 *
 * Two actions rather than one that waits: the check takes as long as GitHub
 * takes to schedule a runner, which is usually seconds and occasionally
 * minutes. An action that blocked until the answer arrived would hold a
 * request open for that whole time and give the operator a spinner with no
 * way to see what it was waiting on. Starting and polling separately lets the
 * page show the run's link the moment there is one.
 *
 * Neither action touches the database. The check is about the customer's
 * cloud, not about anything the platform stores — which is also what lets the
 * wizard run it before the tenant row exists. See verifyConnection.ts.
 */

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  pollConnectionCheck,
  startConnectionCheck,
  type ConnectionCheck,
  type VerifyTarget,
} from "@/lib/verifyConnection";

export type StartedCheck =
  | { checkId: string; startedAt: string; cloudProvider: "aws" | "azure" }
  | { error: string };

/**
 * The fields a check needs, pulled from whatever form is asking. Missing ones
 * are named rather than sent as empty strings, because a check dispatched
 * without a role ARN fails inside the workflow with an error about AWS rather
 * than about the form.
 */
function readTarget(formData: FormData): VerifyTarget | { missing: string[] } {
  const value = (key: string) => {
    const raw = formData.get(key);
    return typeof raw === "string" ? raw.trim() : "";
  };

  const cloudProvider = value("cloudProvider") === "azure" ? "azure" : "aws";
  const tenantId = value("tenantId");
  const tenantSlug = value("slug");

  const required: Record<string, string> =
    cloudProvider === "azure"
      ? {
          tenantId,
          slug: tenantSlug,
          azureClientId: value("azureClientId"),
          azureTenantId: value("azureTenantId"),
          azureSubscriptionId: value("azureSubscriptionId"),
        }
      : {
          tenantId,
          slug: tenantSlug,
          awsRegion: value("awsRegion"),
          deploymentRoleArn: value("deploymentRoleArn"),
        };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) return { missing };

  return cloudProvider === "azure"
    ? {
        cloudProvider: "azure",
        tenantId,
        tenantSlug,
        azureClientId: required.azureClientId,
        azureTenantId: required.azureTenantId,
        azureSubscriptionId: required.azureSubscriptionId,
      }
    : {
        cloudProvider: "aws",
        tenantId,
        tenantSlug,
        awsRegion: required.awsRegion,
        deploymentRoleArn: required.deploymentRoleArn,
      };
}

const FIELD_LABELS: Record<string, string> = {
  tenantId: "chatbot ID",
  slug: "short name",
  awsRegion: "AWS region",
  deploymentRoleArn: "IAM deployment role ARN",
  azureClientId: "managed identity client ID",
  azureTenantId: "Azure directory (tenant) ID",
  azureSubscriptionId: "Azure subscription ID",
};

export async function startCheck(
  _prev: StartedCheck | null,
  formData: FormData,
): Promise<StartedCheck> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const target = readTarget(formData);
  if ("missing" in target) {
    const names = target.missing.map((f) => FIELD_LABELS[f] ?? f).join(", ");
    return { error: `Fill in the ${names} before testing the connection.` };
  }

  // Server-generated so it cannot be chosen by whoever submits the form: it
  // is the handle used to find the run, and a caller who picked it could read
  // back a run they did not start.
  const checkId = randomUUID();

  try {
    const { startedAt } = await startConnectionCheck(target, checkId);
    return {
      checkId,
      startedAt: startedAt.toISOString(),
      cloudProvider: target.cloudProvider,
    };
  } catch (err) {
    // The dispatch failing is a platform problem — a revoked token, a missing
    // workflow file, Actions disabled — and never the customer's cloud. Say
    // so, rather than letting it read as a failed connection.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[startCheck] could not dispatch the connection check", err);
    return { error: `The platform could not start the check: ${message}` };
  }
}

export async function pollCheck(
  checkId: string,
  startedAtIso: string,
  cloudProvider: string,
): Promise<ConnectionCheck> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const startedAt = new Date(startedAtIso);
  if (Number.isNaN(startedAt.getTime())) {
    return { status: "unknown", runUrl: null, reason: "Invalid check timestamp." };
  }

  return pollConnectionCheck(checkId, startedAt, cloudProvider);
}
