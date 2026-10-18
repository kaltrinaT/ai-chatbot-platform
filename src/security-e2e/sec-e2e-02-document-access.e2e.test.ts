/**
 * SEC-E2E-02 — Document-access denial.
 *
 * Claim: neither the control plane nor the docs-signer can read or list a
 * tenant's documents; the signer can only write and delete them.
 *
 * Simulated, not live: every policy is taken from the files that create it —
 * the AWS bootstrap template rendered for a sample tenant, the tenant
 * Terraform for the signer, and the platform's own control-plane Terraform —
 * and evaluated with the IAM model shared with scripts/evaluate-security.cjs
 * (scripts/lib/security-model.cjs). A real cloud would also apply SCPs,
 * boundaries and resource policies; none is declared for these buckets, and
 * the model throws on any construct it does not understand rather than
 * skipping it.
 */
import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { readFileSync } from "node:fs";
import model from "../../scripts/lib/security-model.cjs";
import { tenants } from "@/db/schema";
import { awsOnboardingPermissions } from "@/lib/awsTrust";
import { evidence } from "@/test/evidence";

const record = evidence("SEC-E2E-02");

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const SLUG = "alpha";
const CUSTOMER = "111111111111";
const PLATFORM = "222222222222";
const sample = model.sampleTenant({ tenantId: TENANT, slug: SLUG, owner: "acme", repo: "platform", customerAccount: CUSTOMER, platformAccount: PLATFORM });
const template = model.renderAwsBootstrap(sample);
const bucket = `arn:aws:s3:::chatbot-${SLUG}-docs`;
const document = `${bucket}/handbook.pdf`;
const platformRole = `arn:aws:iam::${PLATFORM}:role/platform-control-plane`;
const controlPlane = model.controlPlaneSource().permissions;

type Decision = { decision: string; statements: string[] };
const allowed = (d: Decision) => d.decision === "Allow";

describe("SEC-E2E-02 · AWS: the control plane cannot read a document", () => {
  const roles = Object.entries(template as Record<string, { Type: string }>)
    .filter(([, r]) => r.Type === "AWS::IAM::Role")
    .map(([id]) => ({ id, ...model.roleStatements(template, id) }));

  it("finds the roles to check", () => {
    expect(roles.map((r) => r.id).sort()).toEqual(["DeploymentRole", "OnboardingRole"]);
  });

  it.each(["DeploymentRole", "OnboardingRole"])("no path to a document runs through %s", (id) => {
    const role = roles.find((r) => r.id === id)!;
    const arn = `arn:aws:iam::${CUSTOMER}:role/${role.name}`;
    const path = {
      mayAssume: model.evaluate(controlPlane, { action: "sts:AssumeRole", resource: arn }),
      trustsPlatform: model.evaluate(role.trust, {
        action: "sts:AssumeRole",
        caller: { AWS: platformRole },
        context: { "sts:ExternalId": TENANT },
      }),
      read: model.evaluate(role.policy, { action: "s3:GetObject", resource: document }),
      list: model.evaluate(role.policy, { action: "s3:ListBucket", resource: bucket }),
    };
    const complete = allowed(path.mayAssume) && allowed(path.trustsPlatform) && (allowed(path.read) || allowed(path.list));
    record.attack(`Platform role → ${role.name} → s3:GetObject / s3:ListBucket`, {
      expected: "at least one link of the path refused",
      actual: Object.fromEntries(Object.entries(path).map(([k, v]) => [k, v.decision])),
      refused: !complete,
    });
    expect(complete).toBe(false);
  });

  it("the platform role cannot read the bucket directly", () => {
    const read = model.evaluate(controlPlane, { action: "s3:GetObject", resource: document });
    const list = model.evaluate(controlPlane, { action: "s3:ListBucket", resource: bucket });
    record.attack("Platform role calls s3:GetObject and s3:ListBucket itself", {
      expected: "both refused",
      actual: { read: read.decision, list: list.decision, policy: model.controlPlaneFile },
      refused: !allowed(read) && !allowed(list),
    });
    expect(allowed(read) || allowed(list)).toBe(false);
  });

  it("the onboarding role the platform does assume can neither read a secret back nor reach another tenant's", () => {
    const role = roles.find((r) => r.id === "OnboardingRole")!;
    const own = `arn:aws:secretsmanager:eu-central-1:${CUSTOMER}:secret:${SLUG}/llm-api-key-AbCdEf`;
    const neighbour = `arn:aws:secretsmanager:eu-central-1:${CUSTOMER}:secret:${SLUG}-corp/llm-api-key-AbCdEf`;
    const attacks = {
      getSecretValue: model.evaluate(role.policy, { action: "secretsmanager:GetSecretValue", resource: own }),
      writeNeighbour: model.evaluate(role.policy, { action: "secretsmanager:CreateSecret", resource: neighbour }),
      readDocument: model.evaluate(role.policy, { action: "s3:GetObject", resource: document }),
    };
    record.attack("Onboarding role reads its secret back, writes alpha-corp's, reads a document", {
      expected: "all refused",
      actual: Object.fromEntries(Object.entries(attacks).map(([k, v]) => [k, v.decision])),
      refused: Object.values(attacks).every((d) => !allowed(d)),
    });
    for (const d of Object.values(attacks)) expect(allowed(d)).toBe(false);

    // Control: onboarding still works, so the refusals are not a broken role.
    const assume = model.evaluate(controlPlane, { action: "sts:AssumeRole", resource: `arn:aws:iam::${CUSTOMER}:role/${role.name}` });
    const create = model.evaluate(role.policy, { action: "secretsmanager:CreateSecret", resource: own });
    record.control("Platform assumes the onboarding role and stores this tenant's secret", {
      expected: "both allowed",
      actual: { assume: assume.decision, create: create.decision },
      allowed: allowed(assume) && allowed(create),
    });
    expect(allowed(assume) && allowed(create)).toBe(true);
  });

  // Control for the evaluator itself: the role that builds the infrastructure
  // can read the bucket, so a refusal above is a property of the policy and
  // not of a model that refuses every read.
  it("control: the evaluator does report a read where the policy grants one", () => {
    const deploy = roles.find((r) => r.id === "DeploymentRole")!;
    const read = model.evaluate(deploy.policy, { action: "s3:GetObject", resource: document });
    record.control("Deployment role (GitHub only) reads a document", {
      expected: "allowed — this role builds the bucket, and the platform cannot assume it",
      actual: { read: read.decision, statements: read.statements },
      allowed: allowed(read),
    });
    expect(allowed(read)).toBe(true);
  });

  it("the policy the wizard shows for hand-applied setups grants no read either", () => {
    const statements = JSON.parse(awsOnboardingPermissions({ customerAccountId: CUSTOMER, tenantSlug: SLUG })).Statement;
    const read = model.evaluate(statements, { action: "s3:GetObject", resource: document });
    const secret = model.evaluate(statements, {
      action: "secretsmanager:GetSecretValue",
      resource: `arn:aws:secretsmanager:eu-central-1:${CUSTOMER}:secret:${SLUG}/llm`,
    });
    record.attack("Hand-applied onboarding policy: s3:GetObject and GetSecretValue", {
      expected: "both refused",
      actual: { read: read.decision, getSecretValue: secret.decision },
      refused: !allowed(read) && !allowed(secret),
    });
    expect(allowed(read) || allowed(secret)).toBe(false);
  });
});

describe("SEC-E2E-02 · the docs-signer can write but never read", () => {
  it("AWS: the signer's S3 policy", () => {
    const policy = model.awsDocsSignerPolicy(bucket);
    const read = model.evaluate(policy, { action: "s3:GetObject", resource: document });
    const list = model.evaluate(policy, { action: "s3:ListBucket", resource: bucket });
    const otherBucket = model.evaluate(policy, { action: "s3:PutObject", resource: "arn:aws:s3:::chatbot-beta-docs/x.pdf" });
    record.attack("AWS signer reads, lists, and writes another tenant's bucket", {
      expected: "all refused",
      actual: { read: read.decision, list: list.decision, otherBucket: otherBucket.decision },
      refused: !allowed(read) && !allowed(list) && !allowed(otherBucket),
    });
    expect(allowed(read) || allowed(list) || allowed(otherBucket)).toBe(false);

    const put = model.evaluate(policy, { action: "s3:PutObject", resource: document });
    const del = model.evaluate(policy, { action: "s3:DeleteObject", resource: document });
    record.control("AWS signer writes and deletes in its own bucket", {
      expected: "both allowed",
      actual: { put: put.decision, delete: del.decision },
      allowed: allowed(put) && allowed(del),
    });
    expect(allowed(put) && allowed(del)).toBe(true);
  });

  it("Azure: the signer's custom role", () => {
    const role = model.azureDocsSignerRole();
    const blobs = "Microsoft.Storage/storageAccounts/blobServices/containers/blobs";
    const attacks = {
      readBlob: model.azureAllows(role.dataActions, `${blobs}/read`),
      listContainer: model.azureAllows(role.actions, "Microsoft.Storage/storageAccounts/blobServices/containers/read"),
      readKeyVaultSecret: model.azureAllows(role.dataActions, "Microsoft.KeyVault/vaults/secrets/getSecret/action"),
      listAccountKeys: model.azureAllows(role.actions, "Microsoft.Storage/storageAccounts/listKeys/action"),
    };
    record.attack("Azure signer reads a blob, lists a container, reads a vault secret, lists account keys", {
      expected: "none granted",
      actual: { ...attacks, dataActions: role.dataActions, actions: role.actions },
      refused: Object.values(attacks).every((granted) => !granted),
    });
    for (const granted of Object.values(attacks)) expect(granted).toBe(false);

    const write = model.azureAllows(role.dataActions, `${blobs}/write`);
    const del = model.azureAllows(role.dataActions, `${blobs}/delete`);
    record.control("Azure signer writes and deletes a blob", {
      expected: "both granted",
      actual: { write, delete: del },
      allowed: write && del,
    });
    expect(write && del).toBe(true);
  });
});

describe("SEC-E2E-02 · Azure: the control plane holds nothing that reaches storage", () => {
  it("has no Azure or storage SDK at runtime and no stored Azure credential", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    const reaching = Object.keys(pkg.dependencies).filter((d) => d.startsWith("@azure/") || d === "@aws-sdk/client-s3");
    const credentialColumns = Object.keys(getTableColumns(tenants)).filter((c) => /^azure\w*(Secret|Password|Credential|Key)(Encrypted)?$/.test(c));
    record.attack("Control plane carries a storage client or an Azure credential", {
      expected: "none",
      actual: { runtimeStorageClients: reaching, azureCredentialColumns: credentialColumns },
      refused: reaching.length === 0 && credentialColumns.length === 0,
    });
    expect(reaching).toEqual([]);
    expect(credentialColumns).toEqual([]);
  });
});
