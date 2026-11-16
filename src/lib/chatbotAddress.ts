import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import type { tenants } from "@/db/schema";

type Tenant = typeof tenants.$inferSelect;

export type AddressTenant = Pick<Tenant, "cloudProvider" | "slug" | "awsRegion" | "azureRegion" | "domain">;

/*
 * The chatbot address and the load balancer name arrive from the deploy
 * workflow (the status webhook, or the outputs artifact when that webhook is
 * lost), and the platform later sends requests to them: a reindex POSTs to
 * <address>/api/index and shows the operator part of the reply. Stored
 * unchecked, they let whoever holds the shared webhook secret, or an operator
 * choosing a custom domain, aim the control plane at any host it can reach,
 * including loopback and cloud metadata addresses.
 *
 * So each value must be one Terraform could have produced for this tenant
 * (infra/terraform/outputs.tf, infra/terraform/azure/outputs.tf):
 *
 * - AWS: the tenant's own load balancer, chatbot-<slug>-<n>.<region>.elb.amazonaws.com,
 *   a CloudFront distribution, or the custom domain the tenant was given.
 * - Azure: the tenant's container app, chatbot-<slug>.<environment>.<region>.azurecontainerapps.io,
 *   over https, or the custom domain.
 *
 * The shape is checked before a value is stored and again before every use,
 * as docsSignerUrlProblem does for the signer. A shape alone cannot stop a
 * custom domain that resolves to a private address, so publicAddressProblem
 * resolves the host before each request as well.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const region = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");

function loadBalancerHost(tenant: AddressTenant): { pattern: RegExp; shape: string } | null {
  const slug = escape(tenant.slug);
  if (tenant.cloudProvider === "azure") {
    const r = region(tenant.azureRegion);
    if (!r) return null;
    return {
      pattern: new RegExp(`^chatbot-${slug}\\.[a-z0-9-]+\\.${escape(r)}\\.azurecontainerapps\\.io$`),
      shape: `chatbot-${tenant.slug}.<environment>.${r}.azurecontainerapps.io`,
    };
  }
  const r = region(tenant.awsRegion);
  if (!r) return null;
  return {
    pattern: new RegExp(`^chatbot-${slug}-\\d+\\.${escape(r)}\\.elb\\.amazonaws\\.com$`),
    shape: `chatbot-${tenant.slug}-<n>.${r}.elb.amazonaws.com`,
  };
}

/** Why `host` cannot be this tenant's load balancer (Azure: its container app), or null if it can. */
export function albDnsNameProblem(tenant: AddressTenant, host: string): string | null {
  const expected = loadBalancerHost(tenant);
  if (!expected) return "the tenant has no region to check it against";
  return expected.pattern.test(host.toLowerCase()) ? null : `expected ${expected.shape}`;
}

/** Why `url` cannot be this tenant's chatbot address, or null if it can. */
export function chatbotUrlProblem(tenant: AddressTenant, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "must use http or https";
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== "/") {
    return "must be a bare origin, with no credentials, port, path, query or fragment";
  }

  const host = parsed.hostname;
  if (tenant.domain && host === tenant.domain.toLowerCase()) return null;

  if (tenant.cloudProvider === "azure") {
    if (parsed.protocol !== "https:") return "an Azure chatbot is served over https";
    const problem = albDnsNameProblem(tenant, host);
    return problem && `expected the tenant's container app or its custom domain (${problem})`;
  }

  if (/^[a-z0-9]+\.cloudfront\.net$/.test(host)) {
    return parsed.protocol === "https:" ? null : "a CloudFront address is served over https";
  }
  const problem = albDnsNameProblem(tenant, host);
  return problem && `expected the tenant's load balancer, a CloudFront address or its custom domain (${problem})`;
}

// Addresses no chatbot is ever served from: private, loopback, link-local
// (which holds cloud metadata services), shared, reserved and multicast
// ranges. BlockList checks an IPv4-mapped IPv6 address (::ffff:127.0.0.1)
// against the IPv4 rules itself; listing ::ffff:0:0/96 here would match every
// IPv4 address. NAT64 (64:ff9b::/96) is refused whole, since its embedded
// IPv4 address is not unpacked.
const nonPublic = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) nonPublic.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) nonPublic.addSubnet(net, prefix, "ipv6");

/**
 * Why a request to `host` must not be sent, or null if every address it
 * resolves to is public. Checked just before the request, so it covers what
 * the shape check cannot: a custom domain whose DNS names a private address.
 * The request resolves the name again, so a domain whose owner switches its
 * DNS between the two lookups is not covered; the provider-owned names
 * (elb.amazonaws.com, cloudfront.net, azurecontainerapps.io) are not exposed
 * to that.
 */
export async function publicAddressProblem(host: string): Promise<string | null> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    return `could not resolve ${host}${code ? ` (${code})` : ""}`;
  }
  if (addresses.length === 0) return `could not resolve ${host}`;
  const blocked = addresses.some((a) => nonPublic.check(a.address, a.family === 6 ? "ipv6" : "ipv4"));
  return blocked ? `${host} resolves to a private, loopback or link-local address` : null;
}
