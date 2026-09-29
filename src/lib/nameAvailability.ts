/**
 * Whether someone outside the platform already holds a name a chatbot needs.
 *
 * The platform has no credential for anyone's cloud, and needs none here:
 * these names are public hostnames. An Azure storage account, registry, key
 * vault, function app or Postgres server has a DNS record exactly while it
 * exists, and S3 answers 404 for a bucket that does not. Asked before the
 * customer runs any setup, this turns a failed `terraform apply` — after
 * other resources were created and paid for — into a message at the slug.
 *
 * Only a definite answer counts as taken. A timeout or an unusual error reads
 * as free: this is a convenience ahead of Terraform, which remains the
 * authority, and a flaky resolver must never block a slug that is fine.
 */

import { lookup } from "node:dns/promises";
import { awsGlobalNames, azureGlobalNames, type GlobalName } from "@/lib/resourceNames";

const TIMEOUT_MS = 3000;

export type Probes = {
  /** Resolves when the host exists; rejects with code ENOTFOUND when it does not. */
  resolve: (host: string) => Promise<unknown>;
  /** The HTTP status S3 gives an anonymous HEAD on the bucket's host. */
  s3Status: (host: string) => Promise<number>;
};

const realProbes: Probes = {
  resolve: (host) => lookup(host),
  s3Status: async (host) =>
    (await fetch(`https://${host}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) }))
      .status,
};

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
  ]);
}

async function dnsTaken(host: string, probes: Probes): Promise<boolean> {
  try {
    await withTimeout(probes.resolve(host));
    return true;
  } catch {
    // ENOTFOUND is free; anything else is not an answer, and reads as free.
    return false;
  }
}

async function bucketTaken(host: string, probes: Probes): Promise<boolean> {
  try {
    // 404 is S3 saying no such bucket. 403, 200 or a redirect all mean it
    // exists, in someone's account.
    return (await probes.s3Status(host)) !== 404;
  } catch {
    return false;
  }
}

/** The first name this chatbot needs that is already held by someone else. */
export async function firstTakenGlobalName(
  cloud: "aws" | "azure",
  slug: string,
  probes: Probes = realProbes,
): Promise<GlobalName | null> {
  // The setup's own resources exist by the time the chatbot is submitted, and
  // are this customer's, not someone else's.
  const names = (cloud === "azure" ? azureGlobalNames(slug) : awsGlobalNames(slug)).filter((n) => !n.createdBySetup);
  const taken = await Promise.all(
    names.map((n) => (cloud === "azure" ? dnsTaken(n.host, probes) : bucketTaken(n.host, probes))),
  );
  return names.find((_, i) => taken[i]) ?? null;
}
