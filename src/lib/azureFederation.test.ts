import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AZURE_FEDERATION_AUDIENCE,
  GITHUB_OIDC_ISSUER,
  azureDeployEnvironment,
  azureFederatedCredentialCommand,
  azureFederatedSubject,
  azureManagedIdentityCredentialCommand,
} from "./azureFederation";

const repo = { owner: "kaltrinaT", repo: "ai-chatbot-platform" };
const tenantA = "0b6f3c7e-9a1d-4a7e-8f53-2d1c6b9e4a10";
const tenantB = "5d2e8a41-7c3b-4f9e-a6d0-91b4c2e7f358";

describe("azureFederatedSubject", () => {
  it("names the tenant's GitHub environment, not the deploy branch", () => {
    expect(azureFederatedSubject(repo, tenantA)).toBe(
      `repo:kaltrinaT/ai-chatbot-platform:environment:tenant-${tenantA}`,
    );
  });

  // The property the whole design rests on: a credential one customer creates
  // must not match another tenant's deploy.
  it("differs for every tenant in the same repository", () => {
    expect(azureFederatedSubject(repo, tenantA)).not.toBe(azureFederatedSubject(repo, tenantB));
  });
});

describe("the workflow's environment", () => {
  // The subject only matches if the job really runs in this environment. The
  // two live in different languages, so this reads the workflow file itself.
  it("is the one deploy-tenant-azure.yml runs its job in", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/deploy-tenant-azure.yml"),
      "utf8",
    );
    const declared = workflow.match(/^\s+environment:\s*(.+?)\s*$/m)?.[1];

    expect(declared).toBe("tenant-${{ inputs.tenant_id }}");
    expect(azureDeployEnvironment(tenantA)).toBe(declared!.replace("${{ inputs.tenant_id }}", tenantA));
  });
});

describe("credential commands", () => {
  it("carries the issuer, audience and subject Entra checks", () => {
    for (const command of [
      azureFederatedCredentialCommand(repo, tenantA, "33333333-3333-3333-3333-333333333333"),
      azureManagedIdentityCredentialCommand(repo, tenantA),
    ]) {
      expect(command).toContain(GITHUB_OIDC_ISSUER);
      expect(command).toContain(AZURE_FEDERATION_AUDIENCE);
      expect(command).toContain(azureFederatedSubject(repo, tenantA));
    }
  });

  it("targets the app registration by its client ID, with a placeholder until one is entered", () => {
    expect(azureFederatedCredentialCommand(repo, tenantA, "abc")).toContain("--id abc ");
    expect(azureFederatedCredentialCommand(repo, tenantA, "")).toContain("--id <client-id> ");
  });
});
