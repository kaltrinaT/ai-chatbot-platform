/**
 * The deploy pipeline's security properties, checked against the real files.
 *
 * GitHub Actions workflows and Terraform can't be unit-tested by running them,
 * but the properties the security model rests on are all visible in their
 * source: which secrets a run can reach, which step signs in to a customer's
 * cloud and how, and what binds that sign-in to one tenant. SECURITY.md makes
 * claims about each of these; this file is what keeps the claims true when the
 * workflows change.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { PLATFORM_SECRETS_AUDIENCE } from "./githubOidc";
import { awsStateBucketName, azureStateStorageAccountName } from "./bootstrapLinks";

type Step = { name?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = {
  environment?: string;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  steps: Step[];
};
type Workflow = {
  on: { workflow_dispatch: { inputs: Record<string, { required?: boolean }> } };
  jobs: Record<string, Job>;
};

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function workflow(file: string): { raw: string; parsed: Workflow; job: Job } {
  const raw = source(`.github/workflows/${file}`);
  const parsed = parse(raw) as Workflow;
  const jobs = Object.values(parsed.jobs);
  expect(jobs).toHaveLength(1);
  return { raw, parsed, job: jobs[0] };
}

// Workflows that change a customer's infrastructure.
const WORKFLOWS = [
  "deploy-tenant.yml",
  "destroy-tenant.yml",
  "deploy-tenant-azure.yml",
  "destroy-tenant-azure.yml",
] as const;

// Read-only checks that only prove a sign-in works. They hold the same
// credentials a deploy does for a few seconds, so they are held to the same
// rules, but they post no callbacks and touch no state.
const VERIFY_WORKFLOWS = ["verify-tenant-aws.yml", "verify-tenant-azure.yml"] as const;

// Every workflow that signs in to a customer's cloud. The binding to one
// tenant is the same on both providers now: the job runs in a GitHub
// environment named after the tenant, GitHub writes that into the OIDC
// token's subject, and the customer's trust — an IAM trust policy on AWS, a
// federated identity credential on Azure — accepts only that subject.
//
// The verify workflows are in here for a reason that is easy to miss: a check
// that signed in any other way would prove nothing about whether deploys will
// work, and would report "Connected" for a tenant whose deploys all fail.
const TENANT_WORKFLOWS = [...WORKFLOWS, ...VERIFY_WORKFLOWS] as const;

// Workflows that assume the customer's AWS role directly.
const AWS_TENANT_WORKFLOWS = [
  "deploy-tenant.yml",
  "destroy-tenant.yml",
  "verify-tenant-aws.yml",
] as const;

// Workflows that sign in to a customer's Azure subscription.
const AZURE_TENANT_WORKFLOWS = [
  "deploy-tenant-azure.yml",
  "destroy-tenant-azure.yml",
  "verify-tenant-azure.yml",
] as const;

// Only the workflows that still need something from the platform's own AWS
// account: the golden images in its ECR, and (for Azure tenants, which have
// no customer AWS role to reach it as) the Terraform state bucket. Neither
// AWS teardown nor any check needs either.
const PLATFORM_ROLE_WORKFLOWS = [
  "deploy-tenant.yml",
  "deploy-tenant-azure.yml",
  "destroy-tenant-azure.yml",
] as const;

// Deploy status callbacks and the Terraform state location. None of them
// grants access to a customer's cloud.
const PERMITTED_SECRETS = [
  "PLATFORM_BASE_URL",
  "PLATFORM_WEBHOOK_SECRET",
  "TF_STATE_BUCKET",
  "TF_STATE_REGION",
];

describe.each(TENANT_WORKFLOWS)("%s — no stored cloud credential", (file) => {
  it("reads no repository secret beyond the callback and state settings", () => {
    const { raw } = workflow(file);
    const used = [...new Set([...raw.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();

    expect(used.filter((name) => !PERMITTED_SECRETS.includes(name))).toEqual([]);
  });

  it("never names an AWS access key or an Azure client secret", () => {
    const { raw } = workflow(file);

    expect(raw).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
    // Not @aws-sdk/client-secrets-manager, which is a package name.
    expect(raw).not.toMatch(/client[_-]?secret(?!s-manager)/i);
  });

  it("can request an OIDC token, and only reads repository contents", () => {
    const { job } = workflow(file);

    expect(job.permissions).toEqual({ "id-token": "write", contents: "read" });
  });

  it("hands no step a stored AWS key", () => {
    const { job } = workflow(file);

    for (const step of job.steps.filter((s) =>
      s.uses?.startsWith("aws-actions/configure-aws-credentials"),
    )) {
      expect(step.with).not.toHaveProperty("aws-access-key-id");
      expect(step.with).not.toHaveProperty("aws-secret-access-key");
    }
  });
});

describe.each(PLATFORM_ROLE_WORKFLOWS)("%s — platform role", (file) => {
  it("reaches the platform's AWS role through OIDC, not a key", () => {
    const { job } = workflow(file);
    const platformStep = job.steps.find(
      (s) => s.uses?.startsWith("aws-actions/configure-aws-credentials") &&
        s.with?.["role-to-assume"] === "${{ vars.AWS_PLATFORM_DEPLOY_ROLE_ARN }}",
    );

    expect(platformStep).toBeDefined();
    expect(platformStep!.with).not.toHaveProperty("role-chaining");
  });
});

// ECR login tokens are regional. Asking the tenant's region for a token to the
// platform's registry failed every tenant outside the region the platform's
// images live in.
describe.each(["deploy-tenant.yml", "deploy-tenant-azure.yml"])(
  "%s — logs in to the platform's registry in the registry's own region",
  (file) => {
    it("derives the region from the source image URI", () => {
      const raw = workflow(file).raw;
      expect(raw).toMatch(/SOURCE_REGION=\$\(echo "\$SOURCE_REGISTRY" \| cut -d\. -f4\)/);

      // Each login, from the token request through its `docker login` line.
      const logins = raw
        .split("get-login-password")
        .slice(1)
        .map((chunk) => chunk.slice(0, chunk.indexOf("\n", chunk.indexOf("docker login"))));
      const sourceLogin = logins.find((login) => /SOURCE_REGISTRY|source_registry/.test(login));
      expect(sourceLogin).toMatch(/^ --region "?(\$SOURCE_REGION|\$\{\{ steps\.names\.outputs\.source_region \}\})/);
    });
  },
);

// Teardown used to assume a platform role for the sole purpose of chaining
// into the customer's. With the customer's role trusting GitHub directly
// there is nothing left for the platform account to do, and this pins that:
// reintroducing the step would put the platform back in the middle of a
// teardown without anyone noticing.
describe("destroy-tenant.yml — no platform account involvement", () => {
  it("never assumes the platform's role", () => {
    expect(workflow("destroy-tenant.yml").raw).not.toContain("AWS_PLATFORM_DEPLOY_ROLE_ARN");
  });
});

// The confused-deputy guard, and the one property the whole model rests on.
//
// The subject a customer's trust accepts is built from the job's environment
// (see src/lib/githubOidc.ts, which builds the value the wizard and the
// bootstrap templates show). Anything else here — no environment, or one not
// named after the tenant — collapses the boundary: every tenant's runs would
// carry the same subject, so any customer's trust would accept any tenant's
// deploy, and an operator who typed the wrong role ARN or client ID into the
// wizard would provision into a stranger's cloud.
describe.each(TENANT_WORKFLOWS)("%s — bound to one tenant", (file) => {
  it("runs in the tenant's own GitHub environment", () => {
    const { parsed, job } = workflow(file);

    expect(job.environment).toBe("tenant-${{ inputs.tenant_id }}");
    expect(parsed.on.workflow_dispatch.inputs.tenant_id).toMatchObject({ required: true });
  });
});

// Two runs applying Terraform to one tenant's state at once can corrupt it.
// All four share one group name, so a deploy and a teardown of the same tenant
// queue behind each other on either cloud, and a running apply is never
// cancelled halfway.
describe.each(WORKFLOWS)("%s — one run per tenant at a time", (file) => {
  it("joins the tenant's shared concurrency group without cancelling a running apply", () => {
    expect(workflow(file).job.concurrency).toEqual({
      group: "tenant-${{ inputs.tenant_id }}",
      "cancel-in-progress": false,
    });
  });
});

// AWS tenants' Terraform state lives in the customer's own account, in the
// bucket their bootstrap stack creates. Both workflows reach it through one
// script, so there is exactly one place that decides where state is.
describe.each(["deploy-tenant.yml", "destroy-tenant.yml"])("%s — state in the customer's account", (file) => {
  const { raw, job } = workflow(file);
  const init = job.steps.find((s) => s.name === "Terraform init (state in the customer's account)") as
    | (Step & { run?: string })
    | undefined;

  it("initialises through the shared script, with the tenant's identifiers", () => {
    expect(init?.run).toContain(".github/scripts/terraform-init-aws.sh");
    expect(init?.env).toMatchObject({
      TENANT_SLUG: "${{ inputs.tenant_slug }}",
      AWS_ACCOUNT_ID: "${{ inputs.aws_account_id }}",
      TENANT_REGION: "${{ inputs.aws_region }}",
    });
  });

  // The platform's bucket is read only to move a tenant's old state out.
  it("never points Terraform at the platform's bucket directly", () => {
    expect(raw).not.toMatch(/-backend-config="bucket=\$\{\{ secrets\.TF_STATE_BUCKET \}\}"/);
  });

  // S3-native locking is stable from 1.11.
  it("runs a Terraform that supports S3 lock files", () => {
    const setup = job.steps.find((s) => s.uses?.startsWith("hashicorp/setup-terraform"));
    const [major, minor] = String(setup?.with?.terraform_version).split(".").map(Number);
    expect(major > 1 || (major === 1 && minor >= 11)).toBe(true);
  });
});

describe(".github/scripts/terraform-init-aws.sh — where AWS state lives", () => {
  const script = source(".github/scripts/terraform-init-aws.sh");

  it("derives the bucket name exactly as the platform does", () => {
    const derived = awsStateBucketName("${TENANT_SLUG}", "${AWS_ACCOUNT_ID}", "${TENANT_REGION}");
    expect(script).toContain(`bucket="${derived}"`);
  });

  it("locks state while a run holds it", () => {
    expect(script).toContain('-backend-config="use_lockfile=true"');
  });

  // Both an absent bucket and one owned by another account stop the run.
  it("checks the bucket's owner before using it", () => {
    expect(script).toMatch(/head-bucket[^\n]*--expected-bucket-owner "\$AWS_ACCOUNT_ID"/);
  });
});

// Azure tenants' Terraform state lives in the customer's own subscription, in
// the storage account their bootstrap creates, reached through Entra ID.
describe.each(["deploy-tenant-azure.yml", "destroy-tenant-azure.yml"])(
  "%s — state in the customer's subscription",
  (file) => {
    const { raw, job } = workflow(file);
    const init = job.steps.find((s) => s.name === "Terraform init (state in the customer's subscription)") as
      | (Step & { run?: string })
      | undefined;

    it("initialises through the shared script, with the tenant's identifiers", () => {
      expect(init?.run).toContain(".github/scripts/terraform-init-azure.sh");
      expect(init?.env).toMatchObject({
        TENANT_SLUG: "${{ inputs.tenant_slug }}",
        AZURE_SUBSCRIPTION_ID: "${{ steps.cfg.outputs.azure_subscription_id }}",
        AZURE_TENANT_ID: "${{ steps.cfg.outputs.azure_tenant_id }}",
        AZURE_CLIENT_ID: "${{ steps.cfg.outputs.azure_client_id }}",
      });
    });

    it("never points Terraform at the platform's bucket", () => {
      expect(raw).not.toMatch(/-backend-config="bucket=/);
    });

    it("runs the same pinned Terraform as the AWS workflows", () => {
      const setup = job.steps.find((s) => s.uses?.startsWith("hashicorp/setup-terraform"));
      const aws = workflow("deploy-tenant.yml").job.steps.find((s) =>
        s.uses?.startsWith("hashicorp/setup-terraform"),
      );
      expect(setup?.with?.terraform_version).toBe(aws?.with?.terraform_version);
    });
  },
);

describe(".github/scripts/terraform-init-azure.sh — where Azure state lives", () => {
  const script = source(".github/scripts/terraform-init-azure.sh");

  it("derives the storage account name exactly as the platform does", () => {
    // Bash's ${TENANT_SLUG//-/} drops every hyphen, as the TypeScript does.
    expect(script).toContain('account="cbtf${TENANT_SLUG//-/}"');
    expect(azureStateStorageAccountName("a-b-c")).toBe("cbtfabc");
  });

  // A storage account name is global. Only the account inside the tenant's
  // own resource group is ever used.
  it("finds the account in the tenant's own resource group before using it", () => {
    expect(script).toMatch(/az storage account show --resource-group "\$resource_group" --name "\$account"/);
  });

  it("reaches state with Entra ID, never an account key", () => {
    expect(script).toContain('-backend-config="use_azuread_auth=true"');
    expect(script).toContain('-backend-config="use_oidc=true"');
    expect(script).not.toMatch(/access_key|sas_token|--account-key/);
  });
});

describe("infra/terraform/azure — state backend", () => {
  it("keeps state in Azure Blob Storage, configured entirely at init", () => {
    expect(source("infra/terraform/azure/backend.tf")).toMatch(/backend "azurerm" \{\}/);
  });
});

describe("verify-tenant-azure.yml — finds the state storage", () => {
  const { job } = workflow("verify-tenant-azure.yml");
  const step = job.steps.find((s) => s.name?.startsWith("Find the chatbot's state storage")) as
    | (Step & { run?: string })
    | undefined;

  it("looks the account up in the chatbot's resource group, and reads the state as a deploy would", () => {
    expect(step?.run).toContain('az storage account show --resource-group "$RESOURCE_GROUP"');
    expect(step?.run).toContain("az storage blob exists --auth-mode login");
  });
});

describe("verify-tenant-aws.yml — finds the state bucket", () => {
  const { job } = workflow("verify-tenant-aws.yml");
  const step = job.steps.find((s) => s.name?.startsWith("Find the chatbot's state bucket")) as
    | (Step & { run?: string })
    | undefined;

  it("checks the bucket exists and belongs to the customer's account", () => {
    expect(step?.run).toContain("--expected-bucket-owner");
    expect(step?.env?.BUCKET).toBe(
      awsStateBucketName(
        "${{ inputs.tenant_slug }}",
        "${{ steps.identity.outputs.account }}",
        "${{ inputs.aws_region }}",
      ),
    );
  });
});

describe("drizzle/0015 — one active deployment per tenant", () => {
  it("adds the partial unique index and does nothing else", () => {
    const statements = source("drizzle/0015_one_active_deployment_per_tenant.sql")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements).toEqual([
      `CREATE UNIQUE INDEX "deployments_one_active_per_tenant" ON "deployments" USING btree ("tenant_id") WHERE "deployments"."status" IN ('pending', 'running');`,
    ]);
  });
});

// The AWS half of the same property. A chained assume would mean the customer
// role still trusted the platform account for deploys — the model this
// replaced — and would silently keep working without any per-tenant subject
// being checked by AWS at all.
describe.each(AWS_TENANT_WORKFLOWS)(
  "%s — customer role reached by federation",
  (file) => {
    const customerStep = workflow(file).job.steps.find(
      (s) =>
        s.uses?.startsWith("aws-actions/configure-aws-credentials") &&
        s.with?.["role-to-assume"] === "${{ inputs.deployment_role_arn }}",
    );

    it("assumes the tenant role with a web identity, not a chain", () => {
      expect(customerStep).toBeDefined();
      expect(customerStep!.with).not.toHaveProperty("role-chaining");
      // Meaningless on AssumeRoleWithWebIdentity, and its presence would mean
      // the step was still written against the cross-account trust.
      expect(customerStep!.with).not.toHaveProperty("role-external-id");
    });

    it("declares no ExternalId input — the deploy path no longer uses one", () => {
      expect(workflow(file).parsed.on.workflow_dispatch.inputs).not.toHaveProperty("external_id");
    });
  },
);

// Deploy chains nothing, but it does hold platform-role credentials when it
// reaches the customer step, and the action would quietly chain from them.
describe("deploy-tenant.yml — platform credentials dropped before the customer step", () => {
  it("presents a fresh OIDC token instead of the platform's session", () => {
    const customerStep = workflow("deploy-tenant.yml").job.steps.find(
      (s) => s.with?.["role-to-assume"] === "${{ inputs.deployment_role_arn }}",
    );

    expect(customerStep!.with).toMatchObject({ "unset-current-credentials": true });
  });
});

describe.each(AZURE_TENANT_WORKFLOWS)("%s — federated sign-in", (file) => {
  const { job } = workflow(file);

  it("signs in to Azure with identifiers only, no secret", () => {
    const login = job.steps.find((s) => s.uses?.startsWith("azure/login"));

    expect(login?.with).toBeDefined();
    expect(Object.keys(login!.with!).sort()).toEqual(["client-id", "subscription-id", "tenant-id"]);
  });

  it("hands Terraform no Azure credential", () => {
    for (const step of job.steps) {
      for (const name of Object.keys(step.env ?? {})) {
        expect(name).not.toMatch(/^(TF_VAR_azure_client_secret|ARM_CLIENT_SECRET)$/);
      }
    }
  });

  // `az` cannot refresh a federated login, and Entra's access token lasts
  // 60-90 minutes. A longer job would fail its late `az` steps.
  it("finishes inside the lifetime of the access token `az` holds", () => {
    expect(job["timeout-minutes"]).toBeLessThan(60);
  });
});

// A check that wrote anything would stop being free to repeat, and a customer
// told to "test the connection" would be agreeing to a change they were not
// shown. These stay read-only.
describe.each(VERIFY_WORKFLOWS)("%s — proves a sign-in and nothing more", (file) => {
  const { raw, job } = workflow(file);

  // The CLI, not the word: the Azure check reads the state blob,
  // terraform.tfstate, to prove the deployment identity can.
  it("never runs Terraform", () => {
    expect(raw).not.toMatch(/(^|[\s;&|])terraform\s+(init|plan|apply|destroy|import|state)\b/m);
    expect(job.steps.some((s) => s.uses?.startsWith("hashicorp/setup-terraform"))).toBe(false);
  });

  it("posts no status callback, having no deployment row to post to", () => {
    expect(raw).not.toContain("PLATFORM_WEBHOOK_SECRET");
  });

  // The platform finds the run by this marker — workflow_dispatch returns
  // nothing identifying the run it started — so a run name without it leaves
  // the check permanently pending.
  it("carries the platform's check ID in its run name", () => {
    expect(raw).toMatch(/^run-name:.*\$\{\{ inputs\.check_id \}\}/m);
    expect(workflow(file).parsed.on.workflow_dispatch.inputs.check_id).toMatchObject({
      required: true,
    });
  });
});

// The application secrets an Azure run needs used to be dispatch inputs, which
// GitHub records in the run's event payload for anyone who can read the
// repository. They are fetched by the run itself now, with an OIDC token the
// platform checks (src/lib/deploymentSecrets.ts).
describe.each(["deploy-tenant-azure.yml", "destroy-tenant-azure.yml"])(
  "%s — tenant secrets fetched, not dispatched",
  (file) => {
    const { raw, parsed, job } = workflow(file);
    const fetchStep = job.steps.find((s) => s.name === "Fetch tenant secrets from the platform") as
      | (Step & { run?: string })
      | undefined;

    it("declares no secret input", () => {
      const inputs = Object.keys(parsed.on.workflow_dispatch.inputs);
      expect(inputs.filter((name) => /api_key|secret|password|token/.test(name))).toEqual([]);
      expect(raw).not.toMatch(/inputs\.(llm_api_key|pinecone_api_key|docs_signer_secret)/);
    });

    it("asks the platform with a token minted for the platform's own audience", () => {
      expect(fetchStep?.env?.AUDIENCE).toBe(PLATFORM_SECRETS_AUDIENCE);
      expect(fetchStep?.run).toContain("/api/deployments/${{ inputs.deployment_id }}/secrets");
    });

    // $GITHUB_ENV would hand the values to every later step, third-party
    // actions included.
    it("never puts a secret into the job-wide environment", () => {
      expect(fetchStep?.run).not.toContain("GITHUB_ENV");
      expect(fetchStep?.run).toContain("::add-mask::");
    });

    // The run-started callback is what records the run ID the claim is tied
    // to, and it must come first.
    it("fetches only after reporting the run to the platform", () => {
      const names = job.steps.map((s) => s.name);
      expect(names.indexOf("Fetch tenant secrets from the platform")).toBeGreaterThan(
        names.indexOf("Notify platform — run started"),
      );
    });
  },
);

describe("drizzle/0013 — deployment secrets claimed once", () => {
  it("adds the claim column and does nothing else", () => {
    const statements = source("drizzle/0013_deployment_secrets_claimed.sql")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements).toEqual([
      'ALTER TABLE "deployments" ADD COLUMN "secrets_claimed_at" timestamp with time zone;',
    ]);
  });
});

// Erasing a deleted tenant's LLM key needs the column nullable, but only for
// deleted tenants: the check keeps "a live tenant always has a key" enforced by
// the database rather than by convention.
describe("drizzle/0014 — secrets erasable once a tenant is deleted", () => {
  it("relaxes NOT NULL only behind a live-tenant check", () => {
    const statements = source("drizzle/0014_erase_secrets_on_teardown.sql")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements).toEqual([
      'ALTER TABLE "tenants" ALTER COLUMN "llm_api_key_encrypted" DROP NOT NULL;',
      'ALTER TABLE "tenants" ADD CONSTRAINT "tenants_llm_key_while_live" CHECK ("tenants"."deleted_at" IS NOT NULL OR "tenants"."llm_api_key_encrypted" IS NOT NULL);',
    ]);
  });
});

describe("infra/terraform/azure — federated provider", () => {
  const main = source("infra/terraform/azure/main.tf");
  const variables = source("infra/terraform/azure/variables.tf");
  const provider = main.match(/provider "azurerm" \{[\s\S]*?\n\}/)?.[0] ?? "";

  it("authenticates with the workflow's OIDC token", () => {
    expect(provider).toMatch(/use_oidc\s*=\s*true/);
  });

  // Without this, a missing OIDC token would fall back silently to whatever
  // `az` session the runner holds.
  it("refuses to fall back to an Azure CLI session", () => {
    expect(provider).toMatch(/use_cli\s*=\s*false/);
  });

  it("declares no client secret at all", () => {
    expect(provider).not.toMatch(/client_secret/);
    expect(variables).not.toMatch(/variable "azure_client_secret"/);
  });
});

// Terraform state lives outside the customer's account and records every
// credential a resource exposes, used or not. These keep the ones that would
// reach tenant documents from authorizing anything.
describe("infra/terraform/azure — credentials in state cannot be used", () => {
  const main = source("infra/terraform/azure/main.tf");

  /** The body of one top-level resource block. */
  function resource(type: string, name: string): string {
    const start = main.indexOf(`resource "${type}" "${name}" {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return main.slice(start, main.indexOf("\n}\n", start));
  }

  // The account key reads, writes and lists every document.
  it("refuses Shared Key authorization on the documents account", () => {
    expect(resource("azurerm_storage_account", "docs")).toMatch(/shared_access_key_enabled\s*=\s*false/);
  });

  // Without this azurerm manages containers with the account key, and the
  // documents container could not be created or refreshed at all.
  it("manages storage through Entra ID", () => {
    const provider = main.match(/provider "azurerm" \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(provider).toMatch(/storage_use_azuread\s*=\s*true/);
  });

  // Publishing credentials deploy code that runs as the docs-signer's
  // identity, which can write and delete documents.
  it("disables username/password publishing on the docs-signer", () => {
    const app = resource("azurerm_linux_function_app", "docs_signer");
    expect(app).toMatch(/ftp_publish_basic_authentication_enabled\s*=\s*false/);
    expect(app).toMatch(/webdeploy_publish_basic_authentication_enabled\s*=\s*false/);
  });

  // The docs-signer's code is deployed with the run's identity, never a
  // publishing profile — which is what makes disabling them safe.
  it("deploys the docs-signer with the run's identity, not a publishing profile", () => {
    const deploy = workflow("deploy-tenant-azure.yml").job.steps.find((s) =>
      s.uses?.startsWith("Azure/functions-action"),
    );
    expect(deploy).toBeDefined();
    expect(deploy!.with).not.toHaveProperty("publish-profile");
  });
});

describe("drizzle/0012 — stored Azure secrets removed", () => {
  it("drops the column and does nothing else", () => {
    const statements = source("drizzle/0012_drop_azure_client_secret.sql")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements).toEqual([
      'ALTER TABLE "tenants" DROP COLUMN "azure_client_secret_encrypted";',
    ]);
  });
});
