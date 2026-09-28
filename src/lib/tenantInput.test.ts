import { describe, it, expect } from "vitest";
import { validateTenantValues, rawTenantInput, type TenantValues } from "./tenantInput";

const awsValues: TenantValues = {
  tenantId: "7c1f9a52-3e84-4b16-9d27-0af5c6e81b34",
  cloudProvider: "aws",
  name: "Acme",
  slug: "acme",
  chatbotVersion: "latest",
  llmProvider: "openai",
  llmApiKey: "sk-1234567890",
  vectorStore: "pgvector",
  awsAccountId: "123456789012",
  awsRegion: "us-east-1",
  deploymentRoleArn: "arn:aws:iam::123456789012:role/chatbot-client-deploy-acme",
};

const azureValues: TenantValues = {
  cloudProvider: "azure",
  name: "Acme",
  slug: "acme",
  chatbotVersion: "latest",
  llmProvider: "openai",
  llmApiKey: "sk-1234567890",
  vectorStore: "pgvector",
  azureSubscriptionId: "11111111-1111-1111-1111-111111111111",
  azureTenantId: "22222222-2222-2222-2222-222222222222",
  azureClientId: "33333333-3333-3333-3333-333333333333",
  azureRegion: "eastus",
  tenantId: "0b6f3c7e-9a1d-4a7e-8f53-2d1c6b9e4a10",
};

describe("validateTenantValues", () => {
  it("passes a complete submission", () => {
    expect(validateTenantValues(awsValues)).toEqual({});
    expect(validateTenantValues(azureValues)).toEqual({});
  });

  // The failure this exists to prevent: AWS names the frontend's target group
  // chatbot-<slug>-ui and rejects it past 32 characters, which only surfaces
  // once the load balancer has already been created.
  it("rejects an AWS slug longer than the names AWS builds from it", () => {
    const errors = validateTenantValues({ ...awsValues, slug: "company-info-chatbot-1" });
    expect(errors.slug).toMatch(/21 characters/);
  });

  it("rejects an Azure slug past its Key Vault's limit, while AWS accepts the same one", () => {
    const slug = "nineteen-characters";
    expect(validateTenantValues({ ...azureValues, slug }).slug).toMatch(/18 characters/);
    expect(validateTenantValues({ ...awsValues, slug }).slug).toBeUndefined();
  });

  // The tenant's Terraform state bucket lives in the account-regional
  // namespace, which S3 does not offer in these two regions.
  it.each(["me-south-1", "me-central-1"])("refuses an AWS tenant in %s", (awsRegion) => {
    expect(validateTenantValues({ ...awsValues, awsRegion }).awsRegion).toMatch(/Choose another region/);
  });

  it("still accepts the regions S3 does offer the namespace in", () => {
    expect(validateTenantValues({ ...awsValues, awsRegion: "eu-central-1" }).awsRegion).toBeUndefined();
  });

  it("rejects a certificate with no domain, and one from another region", () => {
    const cert = "arn:aws:acm:eu-west-1:123456789012:certificate/abc";
    expect(validateTenantValues({ ...awsValues, acmCertificateArn: cert }).acmCertificateArn).toMatch(
      /custom domain/,
    );
    expect(
      validateTenantValues({ ...awsValues, acmCertificateArn: cert, domain: "chat.acme.com" })
        .acmCertificateArn,
    ).toMatch(/same region/);
  });

  // The customer's trust is bound to this ID before the tenant exists — as an
  // Azure federated credential's subject, and as an AWS role's sts:ExternalId —
  // so a tenant created under any other ID is one nothing trusts.
  it("requires a platform tenant ID on both clouds, and rejects one that is not a UUID", () => {
    for (const values of [awsValues, azureValues]) {
      expect(validateTenantValues({ ...values, tenantId: undefined }).tenantId).toBeDefined();
      expect(validateTenantValues({ ...values, tenantId: "tenant-1" }).tenantId).toBeDefined();
    }
  });

  it("asks for no Azure client secret", () => {
    const raw = rawTenantInput({ ...azureValues, azureClientSecret: "anything" });
    expect(raw).not.toHaveProperty("azureClientSecret");
  });

  it("requires the Pinecone key only when Pinecone is the vector store", () => {
    expect(validateTenantValues({ ...awsValues, vectorStore: "pinecone" }).pineconeApiKey).toBeDefined();
    expect(
      validateTenantValues({ ...awsValues, vectorStore: "pinecone", pineconeApiKey: "pc-1234567890" }),
    ).toEqual({});
  });

  // A half-filled form always fails on the steps ahead of the operator, and
  // reporting those would mean a wizard that complains about step 3 on step 2.
  it("reports only the fields asked about", () => {
    const halfFilled: TenantValues = { cloudProvider: "aws", name: "Acme", slug: "no" };

    const stepTwo = validateTenantValues(halfFilled, ["name", "slug", "awsRegion"]);
    expect(Object.keys(stepTwo).sort()).toEqual(["awsRegion", "slug"]);
    expect(stepTwo.slug).toMatch(/at least 3/);

    expect(validateTenantValues(halfFilled, ["llmApiKey"])).toEqual({ llmApiKey: expect.any(String) });
  });
});

describe("rawTenantInput", () => {
  it("treats a blank optional field as absent rather than empty", () => {
    const raw = rawTenantInput({ ...awsValues, domain: "", llmModel: "", acmCertificateArn: "" });
    expect(raw.domain).toBeUndefined();
    expect(raw.llmModel).toBeUndefined();
    expect(raw.acmCertificateArn).toBeUndefined();
  });

  it("applies the two defaults the form relies on", () => {
    const raw = rawTenantInput({ cloudProvider: "aws" });
    expect(raw.chatbotVersion).toBe("latest");
    expect(raw.vectorStore).toBe("pinecone");
  });
});
