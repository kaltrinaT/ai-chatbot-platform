import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { awsGlobalNames, azureGlobalNames, sharedAzureName } from "./resourceNames";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// The names are only worth checking if they are the names Terraform builds.
// Each expression below is copied from the configuration it has to match; a
// change there fails here instead of letting the two drift apart.
describe("the global names match what Terraform builds", () => {
  const azure = source("infra/terraform/azure/main.tf");

  it("derives each Azure name with Terraform's own expression", () => {
    expect(azure).toContain('storage_name = substr(replace("chatbot${var.tenant_slug}", "-", ""), 0, 24)');
    expect(azure).toContain('"${substr(replace("chatbot${var.tenant_slug}", "-", ""), 0, 22)}fn"');
    expect(azure).toContain('acr_name     = substr(replace("chatbot${var.tenant_slug}", "-", ""), 0, 50)');
    expect(azure).toContain('kv_name      = "cb-${var.tenant_slug}-kv"');
    expect(azure).toContain('pg_name = substr("${local.name}-pg", 0, 63)');
    expect(azure).toContain('name                       = "${local.name}-docs-signer"');
    expect(azure).toContain('name         = "chatbot-${var.tenant_slug}"');
  });

  it("produces those names for a real slug", () => {
    expect(Object.fromEntries(azureGlobalNames("product-chatbot99").map((n) => [n.resource, n.name]))).toEqual({
      "documents storage account": "chatbotproductchatbot99",
      "function storage account": "chatbotproductchatbot9fn",
      "Terraform state storage account": "cbtfproductchatbot99",
      "container registry": "chatbotproductchatbot99",
      "key vault": "cb-product-chatbot99-kv",
      "document-signing function": "chatbot-product-chatbot99-docs-signer",
      "vector database": "chatbot-product-chatbot99-pg",
    });
  });

  it("names the AWS documents bucket as Terraform does", () => {
    expect(source("infra/terraform/main.tf")).toContain('bucket = "chatbot-${var.tenant_slug}-docs"');
    expect(awsGlobalNames("acme")).toEqual([
      { resource: "documents bucket", name: "chatbot-acme-docs", host: "chatbot-acme-docs.s3.amazonaws.com" },
    ]);
  });
});

// Two different, valid, platform-unique slugs that Azure turns into the same
// name — so the second customer's deploy failed half way through.
describe("sharedAzureName", () => {
  it("finds the function storage account two numbered slugs share", () => {
    expect(sharedAzureName("product-chatbot98", "product-chatbot99")).toMatchObject({
      resource: "function storage account",
      name: "chatbotproductchatbot9fn",
    });
  });

  it("finds the names two slugs differing only by hyphens share", () => {
    expect(sharedAzureName("acme-bot", "acmebot")?.name).toBe("chatbotacmebot");
  });

  it("finds nothing for slugs that differ early", () => {
    expect(sharedAzureName("support-team-a", "support-team-b")).toBeNull();
    expect(sharedAzureName("hr-chatbot-2", "hr-chatbot-3")).toBeNull();
  });
});
