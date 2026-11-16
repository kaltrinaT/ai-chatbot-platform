import { describe, it, expect, beforeEach, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));

import { albDnsNameProblem, chatbotUrlProblem, publicAddressProblem, type AddressTenant } from "./chatbotAddress";

// The shapes of two live tenants on 20 October 2026, with their slugs.
const aws: AddressTenant = { cloudProvider: "aws", slug: "company-assistant", awsRegion: "us-east-1", azureRegion: null, domain: null };
const azure: AddressTenant = { cloudProvider: "azure", slug: "customer-bot", awsRegion: null, azureRegion: "francecentral", domain: null };
const ALB = "chatbot-company-assistant-1031910159.us-east-1.elb.amazonaws.com";
const FQDN = "chatbot-customer-bot.delightfuldune-ba97a9fe.francecentral.azurecontainerapps.io";

describe("chatbotUrlProblem", () => {
  it.each([
    ["an AWS load balancer", aws, `http://${ALB}`],
    ["a CloudFront distribution", aws, "https://d111111abcdef8.cloudfront.net"],
    ["an Azure container app", azure, `https://${FQDN}`],
    ["the AWS tenant's custom domain", { ...aws, domain: "chat.acme.com" }, "https://chat.acme.com"],
    ["the Azure tenant's custom domain", { ...azure, domain: "Chat.Acme.com" }, "https://chat.acme.com"],
  ])("accepts %s, as Terraform outputs it", (_, tenant, url) => {
    expect(chatbotUrlProblem(tenant, url)).toBeNull();
  });

  it.each([
    ["cloud metadata", aws, "http://169.254.169.254"],
    ["loopback", aws, "http://127.0.0.1"],
    ["localhost", aws, "http://localhost"],
    ["an internal name", aws, "http://metadata.google.internal"],
    ["another tenant's load balancer", aws, "http://chatbot-procurement-bot-348674312.us-east-1.elb.amazonaws.com"],
    ["a load balancer in another region", aws, "http://chatbot-company-assistant-1031910159.eu-west-1.elb.amazonaws.com"],
    ["a lookalike suffix", aws, `http://${ALB}.attacker.example`],
    ["another tenant's container app", azure, "https://chatbot-sales-product-bot.delightfuldune-ba97a9fe.francecentral.azurecontainerapps.io"],
    ["an Azure app over http", azure, `http://${FQDN}`],
    ["CloudFront over http", aws, "http://d111111abcdef8.cloudfront.net"],
    ["a custom domain the tenant was not given", aws, "https://chat.acme.com"],
    ["credentials", aws, `http://user:pass@${ALB}`],
    ["a port", aws, `http://${ALB}:8080`],
    ["a path", aws, `http://${ALB}/internal`],
    ["a query", aws, `http://${ALB}/?x=1`],
    ["another scheme", aws, `file:///etc/passwd`],
    ["no URL at all", aws, "not a url"],
  ])("refuses %s", (_, tenant, url) => {
    expect(chatbotUrlProblem(tenant, url)).toEqual(expect.any(String));
  });

  it("refuses everything when the tenant has no region to check against", () => {
    expect(chatbotUrlProblem({ ...aws, awsRegion: null }, `http://${ALB}`)).toMatch(/no region/);
  });
});

describe("albDnsNameProblem", () => {
  it("accepts the tenant's own load balancer and container app", () => {
    expect(albDnsNameProblem(aws, ALB)).toBeNull();
    expect(albDnsNameProblem(azure, FQDN)).toBeNull();
  });

  it.each([
    ["an IP address", "10.0.0.5"],
    ["an internal name", "internal-chatbot-company-assistant.local"],
    ["a load balancer without the tenant's name", "alb-123.us-east-1.elb.amazonaws.com"],
  ])("refuses %s", (_, host) => {
    expect(albDnsNameProblem(aws, host)).toMatch(/expected chatbot-company-assistant-<n>\.us-east-1/);
  });
});

describe("publicAddressProblem", () => {
  beforeEach(() => {
    lookup.mockReset();
  });

  it("allows a host whose every address is public", async () => {
    lookup.mockResolvedValue([{ address: "52.20.1.2", family: 4 }, { address: "2600:1f18::1", family: 6 }]);
    expect(await publicAddressProblem("chat.acme.com")).toBeNull();
  });

  it.each([
    ["loopback", "127.0.0.1", 4],
    ["a private network", "10.1.2.3", 4],
    ["the 172.16/12 range", "172.20.0.1", 4],
    ["the 192.168/16 range", "192.168.1.10", 4],
    ["cloud metadata", "169.254.169.254", 4],
    ["shared address space", "100.64.0.1", 4],
    ["the unspecified address", "0.0.0.0", 4],
    ["IPv6 loopback", "::1", 6],
    ["IPv6 unique local", "fd00::1", 6],
    ["IPv6 link-local", "fe80::1", 6],
    ["IPv4 mapped into IPv6", "::ffff:127.0.0.1", 6],
    ["NAT64 into a private address", "64:ff9b::a00:1", 6],
  ])("refuses a host that resolves to %s", async (_, address, family) => {
    lookup.mockResolvedValue([{ address: "52.20.1.2", family: 4 }, { address, family }]);
    expect(await publicAddressProblem("chat.acme.com")).toMatch(/private, loopback or link-local/);
  });

  it("refuses a host that does not resolve, naming the reason", async () => {
    lookup.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    expect(await publicAddressProblem("chat.acme.com")).toBe("could not resolve chat.acme.com (ENOTFOUND)");
  });
});
