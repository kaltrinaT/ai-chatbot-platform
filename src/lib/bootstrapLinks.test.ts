/**
 * The bootstrap links, and the templates they point at.
 *
 * The templates are the one part of the security model the platform hands to
 * a customer to apply on its behalf, and nothing at runtime re-checks what
 * they created — a template whose trust condition drifted from the subject the
 * workflows actually present would either refuse every deploy, or, far worse,
 * accept ones it should not. These tests tie both templates back to the same
 * functions that build the workflow's subject, so the two cannot move apart.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AWS_TEMPLATE_OBJECT,
  AZURE_TEMPLATE_OBJECT,
  awsQuickCreateUrl,
  awsStateBucketCommands,
  awsStateBucketName,
  awsUpdateStackCommand,
  azureBootstrapCommand,
  azureBootstrapParameters,
  azureDeployUrl,
  azureStateStorageAccountName,
  azureStateStorageCommands,
} from "./bootstrapLinks";
import { awsFederatedSubject } from "./awsTrust";
import { azureFederatedSubject } from "./azureFederation";
import { validateTenantValues } from "./tenantInput";

/** A complete, valid AWS submission, varied one field at a time. */
const validAws = {
  tenantId: "0b6f3c7e-9a1d-4a7e-8f53-2d1c6b9e4a10",
  cloudProvider: "aws",
  name: "Acme",
  slug: "acme",
  llmProvider: "openai",
  llmApiKey: "sk-1234567890",
  vectorStore: "pgvector",
  awsAccountId: "123456789012",
  awsRegion: "us-east-1",
  deploymentRoleArn: "arn:aws:iam::123456789012:role/chatbot-client-deploy-acme",
};

const tenantId = "0b6f3c7e-9a1d-4a7e-8f53-2d1c6b9e4a10";
const githubRepo = { owner: "kaltrinaT", repo: "ai-chatbot-platform" };
const templateBaseUrl = "https://bootstrap.example.com";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const awsTemplate = source(`infra/bootstrap/aws/tenant-bootstrap.yaml`);
const azureTemplate = JSON.parse(source(`infra/bootstrap/azure/tenant-bootstrap.json`));

const awsLink = (overrides = {}) =>
  awsQuickCreateUrl({
    templateBaseUrl,
    tenantId,
    tenantSlug: "acme-corp",
    githubRepo,
    platformAccountId: "123456789012",
    region: "eu-central-1",
    ...overrides,
  });

/** The fragment's query string, which is where the console reads parameters. */
function fragmentParams(url: string): URLSearchParams {
  return new URLSearchParams(url.split("#")[1].split("?")[1]);
}

describe("awsQuickCreateUrl", () => {
  it("opens the console in the tenant's own region", () => {
    expect(awsLink({ region: "us-west-2" })).toContain(
      "https://us-west-2.console.aws.amazon.com/cloudformation/home?region=us-west-2#",
    );
  });

  it("points at the published template", () => {
    expect(fragmentParams(awsLink()).get("templateURL")).toBe(
      `${templateBaseUrl}/${AWS_TEMPLATE_OBJECT}`,
    );
  });

  // A parameter the template does not declare makes CloudFormation reject the
  // whole stack, and one it declares but the link omits leaves the customer
  // typing a value they were never shown.
  it("sends exactly the parameters the template declares", () => {
    const declared = [
      ...awsTemplate
        .slice(awsTemplate.indexOf("\nParameters:"), awsTemplate.indexOf("\nConditions:"))
        .matchAll(/^ {2}([A-Za-z]+):$/gm),
    ]
      .map((m) => m[1])
      .sort();
    const sent = [...fragmentParams(awsLink()).keys()]
      .filter((k) => k.startsWith("param_"))
      .map((k) => k.slice("param_".length))
      .sort();

    expect(sent).toEqual(declared);
  });

  it("lets an account that already trusts GitHub reuse its provider", () => {
    expect(fragmentParams(awsLink()).get("param_CreateGitHubOidcProvider")).toBe("Yes");
    expect(
      fragmentParams(awsLink({ createOidcProvider: false })).get("param_CreateGitHubOidcProvider"),
    ).toBe("No");
  });

  // The template URL contains ':' and '/', which the console's own router
  // would otherwise read as the end of the parameter.
  it("encodes values that would otherwise break the fragment", () => {
    expect(awsLink()).toContain(`templateURL=${encodeURIComponent(`${templateBaseUrl}/${AWS_TEMPLATE_OBJECT}`)}`);
  });

  it("joins the base URL without doubling the slash", () => {
    expect(
      fragmentParams(awsLink({ templateBaseUrl: "https://bootstrap.example.com/" })).get("templateURL"),
    ).toBe(`${templateBaseUrl}/${AWS_TEMPLATE_OBJECT}`);
  });
});

describe("azureDeployUrl", () => {
  it("hands the portal an encoded template location", () => {
    expect(azureDeployUrl(templateBaseUrl)).toBe(
      "https://portal.azure.com/#create/Microsoft.Template/uri/" +
        encodeURIComponent(`${templateBaseUrl}/${AZURE_TEMPLATE_OBJECT}`),
    );
  });
});

describe("azureBootstrapParameters", () => {
  // The portal takes no parameter values from the URL, so these are typed by
  // hand. A name that does not match the template is a value entered into the
  // wrong field, or into no field at all.
  it("names parameters the template actually declares", () => {
    const shown = azureBootstrapParameters({
      tenantId,
      tenantSlug: "acme-corp",
      githubRepo,
      region: "westeurope",
    });

    for (const { name } of shown) {
      expect(Object.keys(azureTemplate.parameters)).toContain(name);
    }
  });

  it("covers every parameter that has no default", () => {
    const required = Object.entries(azureTemplate.parameters)
      .filter(([, spec]) => !("defaultValue" in (spec as object)))
      .map(([name]) => name)
      .sort();
    const shown = azureBootstrapParameters({
      tenantId,
      tenantSlug: "acme-corp",
      githubRepo,
      region: "westeurope",
    })
      .map((p) => p.name)
      .sort();

    expect(shown.filter((name) => required.includes(name))).toEqual(required);
  });

  // The portal labels a parameter by splitting its name at capitals, next to
  // the customer's own Azure tenant. Named tenantId, the chatbot's ID read as
  // that tenant's, the wrong ID went in, and the credential trusted a subject
  // no run carries.
  it("calls the chatbot's ID a chatbot ID, not a tenant ID, where the portal shows it", () => {
    expect(Object.keys(azureTemplate.parameters)).not.toContain("tenantId");
    const first = azureBootstrapParameters({ tenantId, tenantSlug: "acme-corp", githubRepo, region: "westeurope" })[0];
    expect(first).toEqual({ name: "chatbotId", label: "Chatbot Id", value: tenantId });
    expect(azureTemplate.variables.federatedSubject).toContain("parameters('chatbotId')");
  });
});

describe("the templates match the subject the workflows present", () => {
  // Built by substituting each template's own parameter references into the
  // shared subject builder. If githubOidc.ts ever changes the shape of a
  // subject, these stop matching and both templates have to be updated with
  // it — which is exactly the coupling that is easy to forget by hand.
  it("AWS conditions on the subject awsFederatedSubject builds", () => {
    const expected = awsFederatedSubject(
      { owner: "${GitHubOwner}", repo: "${GitHubRepo}" },
      "${TenantId}",
    );

    expect(awsTemplate).toContain(`token.actions.githubusercontent.com:sub: !Sub "${expected}"`);
  });

  it("Azure trusts the subject azureFederatedSubject builds", () => {
    const expected = azureFederatedSubject({ owner: "{0}", repo: "{1}" }, "{2}");

    expect(azureTemplate.variables.federatedSubject).toBe(
      `[format('${expected}', parameters('gitHubOwner'), parameters('gitHubRepo'), parameters('chatbotId'))]`,
    );
  });

  // StringLike with a wildcard would let any environment in the repository —
  // so any other tenant's deploy — assume the role.
  it("AWS matches the subject exactly, never by pattern", () => {
    const trust = awsTemplate
      .slice(awsTemplate.indexOf("AssumeRolePolicyDocument"), awsTemplate.indexOf("Policies:"))
      // Comments in this block discuss StringLike in order to warn against it.
      .replace(/^\s*#.*$/gm, "");

    expect(trust).toContain("StringEquals");
    expect(trust).not.toContain("StringLike");
  });
});

describe("the AWS template's role", () => {
  // The platform's own IAM policy permits assuming only roles matching this
  // prefix, so a template that named the role anything else would produce a
  // role the platform is denied before any trust policy is evaluated.
  it("names the role with the prefix the platform is allowed to assume", () => {
    expect(awsTemplate).toContain('RoleName: !Sub "chatbot-client-deploy-${TenantSlug}"');
  });

  it("caps sessions at the hour the workflows request", () => {
    expect(awsTemplate).toContain("MaxSessionDuration: 3600");
  });

  // The onboarding statement is the one place the platform account is
  // trusted, and it is only safe because of this condition.
  it("conditions the platform's own access on the tenant's ExternalId", () => {
    expect(awsTemplate).toContain("sts:ExternalId: !Ref TenantId");
  });

  // The form and the template used to disagree: the form accepted slugs of
  // up to 21 characters, the template stopped at 18, so onboarding passed and
  // the stack then failed to create.
  it("accepts exactly the slugs the onboarding form accepts", () => {
    // The parameter's own definition, not its label under Metadata.
    const pattern = awsTemplate.match(/\n {2}TenantSlug:\n {4}Type: String[\s\S]*?AllowedPattern: "([^"]+)"/)?.[1];
    expect(pattern).toBeDefined();
    const template = new RegExp(pattern!);

    for (const slug of ["abc", "acme-corp", "a".repeat(21), "a1-b2-c3"]) {
      expect(template.test(slug), slug).toBe(true);
      expect(validateTenantValues({ ...validAws, slug }).slug, slug).toBeUndefined();
    }
    for (const slug of ["ab", "a".repeat(22), "acme-", "-acme", "Acme"]) {
      expect(template.test(slug), slug).toBe(false);
      expect(validateTenantValues({ ...validAws, slug }).slug, slug).toBeDefined();
    }
  });
});

// Each AWS tenant's Terraform state lives in the customer's own account. The
// template creates the bucket, the workflows and the wizard derive its name,
// and all three have to agree.
describe("the AWS template's Terraform state bucket", () => {
  const bucket = awsTemplate.slice(
    awsTemplate.indexOf("  TerraformStateBucket:\n"),
    awsTemplate.indexOf("  TerraformStateBucketPolicy:"),
  );

  it("is named exactly as the platform derives it", () => {
    const derived = awsStateBucketName("${TenantSlug}", "${AWS::AccountId}", "${AWS::Region}");
    expect(bucket).toContain(`BucketName: !Sub "${derived}"`);
  });

  // A predictable name in the shared global namespace can be registered by
  // any account first — the "Bucket Monopoly" attack — and the deploy would
  // then write the tenant's state, secrets included, into that bucket.
  it("lives in the account-regional namespace, where no other account can take the name", () => {
    expect(bucket).toContain("BucketNamespace: account-regional");
    expect(awsStateBucketName("acme", "111122223333", "eu-central-1")).toMatch(
      /-111122223333-eu-central-1-an$/,
    );
  });

  // Deleting the stack is how a customer revokes access. A bucket the stack
  // tried to delete would fail that deletion whenever it held state.
  it("survives deletion of the stack", () => {
    expect(bucket).toMatch(/DeletionPolicy: Retain/);
    expect(bucket).toMatch(/UpdateReplacePolicy: Retain/);
  });

  it("keeps state recoverable, but not old secrets forever", () => {
    expect(bucket).toMatch(/VersioningConfiguration:\s+Status: Enabled/);
    expect(bucket).toMatch(/NoncurrentVersionExpiration:\s+NoncurrentDays: 30/);
  });

  it("is private and refuses unencrypted connections", () => {
    for (const setting of ["BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets"]) {
      expect(bucket).toContain(`${setting}: true`);
    }
    expect(awsTemplate).toMatch(/aws:SecureTransport: "false"/);
  });

  // Longest real region codes are 14 characters (ap-southeast-5); bucket
  // names are capped at 63.
  it("fits S3's name limit for the longest slug and region", () => {
    expect(awsStateBucketName("a".repeat(21), "111122223333", "ap-southeast-5").length).toBeLessThanOrEqual(63);
  });
});

describe("awsUpdateStackCommand", () => {
  const command = awsUpdateStackCommand({ templateBaseUrl, tenantSlug: "acme-corp", region: "eu-central-1" });

  it("updates the tenant's own stack to the published template", () => {
    expect(command).toContain("--stack-name chatbot-bootstrap-acme-corp");
    expect(command).toContain("--region eu-central-1");
    expect(command).toContain(`--template-url ${templateBaseUrl}/${AWS_TEMPLATE_OBJECT}`);
    expect(command).toContain("--capabilities CAPABILITY_NAMED_IAM");
  });

  // Every value the stack was created with is kept, and a parameter the
  // template declares but the command omits would fail the update.
  it("keeps every declared parameter's previous value", () => {
    const declared = [
      ...awsTemplate
        .slice(awsTemplate.indexOf("\nParameters:"), awsTemplate.indexOf("\nConditions:"))
        .matchAll(/^ {2}([A-Za-z]+):$/gm),
    ].map((m) => m[1]);
    const kept = [...command.matchAll(/ParameterKey=(\w+),UsePreviousValue=true/g)].map((m) => m[1]);

    expect(kept.sort()).toEqual(declared.sort());
  });
});

describe("awsStateBucketCommands", () => {
  it("creates the bucket in the account-regional namespace", () => {
    const commands = awsStateBucketCommands({ tenantSlug: "acme", awsAccountId: "111122223333", region: "eu-central-1" });
    expect(commands).toContain(
      "--bucket tfstate-acme-111122223333-eu-central-1-an --bucket-namespace account-regional",
    );
    expect(commands).toContain("LocationConstraint=eu-central-1");
    expect(commands).toContain("Status=Enabled");
  });

  // CreateBucket rejects a location constraint for us-east-1.
  it("omits the location constraint in us-east-1", () => {
    const commands = awsStateBucketCommands({ tenantSlug: "acme", awsAccountId: "111122223333", region: "us-east-1" });
    expect(commands).not.toContain("LocationConstraint");
  });
});

type ArmResource = {
  type: string;
  name: string;
  scope?: string;
  properties?: Record<string, unknown> & { roleDefinitionId?: string };
  [key: string]: unknown;
};

const azureNested = azureTemplate.resources.find(
  (r: ArmResource) => r.type === "Microsoft.Resources/deployments",
);
const azureNestedResources: ArmResource[] = azureNested.properties.template.resources;
const byType = (type: string) => azureNestedResources.filter((r) => r.type === type);

describe("the Azure template's identity", () => {
  it("confines the identity's management permissions to the chatbot's resource group", () => {
    const groupScoped = byType("Microsoft.Authorization/roleAssignments").filter((a) => !a.scope);

    expect(groupScoped).toHaveLength(2);
    // resourceGroup().id, not subscription().id: the scope of a role
    // assignment in a nested resource-group deployment is the group it runs
    // in, and the guid() seed is what shows which that is.
    for (const assignment of groupScoped) {
      expect(assignment.name).toContain("resourceGroup().id");
    }
  });

  // The default "outer" scope evaluates resourceGroup(), resourceId() and
  // reference() in the subscription-level parent, where they point at the
  // wrong place or are refused, and forbids reference() in the nested
  // template's outputs outright. The template as first written relied on all
  // three and could not have deployed.
  it("evaluates the nested deployment in its own scope, with every name passed in", () => {
    expect(azureNested.properties.expressionEvaluationOptions).toEqual({ scope: "inner" });

    const declared = Object.keys(azureNested.properties.template.parameters).sort();
    const passed = Object.keys(azureNested.properties.parameters).sort();
    expect(passed).toEqual(declared);
  });

  // The nested deployment lives in the resource group, so its ID includes
  // the group; a subscription-level ID names a deployment that does not exist.
  // In a subscription-level template resourceId() reads its first argument as
  // a subscription ID, so the group has to come second: given first, ARM
  // rejected the template with "'chatbot-<slug>' is not valid subscription
  // identifier" before creating anything.
  it("reads the nested deployment's outputs from where that deployment lives", () => {
    const clientId = azureTemplate.outputs.clientId.value as string;
    expect(clientId).toContain(
      "resourceId(subscription().subscriptionId, variables('resourceGroupName'), 'Microsoft.Resources/deployments'",
    );
    expect(clientId).not.toContain("subscriptionResourceId('Microsoft.Resources/deployments'");
  });

  // ARM reads a resource's `comments` as one string. A list of lines failed
  // the nested deployment's validation with "Unexpected token: StartArray".
  it("gives every nested resource's comments as a single string", () => {
    for (const resource of azureNested.properties.template.resources as { comments?: unknown }[]) {
      if (resource.comments !== undefined) expect(typeof resource.comments).toBe("string");
    }
  });

  it("trusts exactly the subject the parent builds", () => {
    const [credential] = byType("Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials");
    expect((credential.properties as { subject: string }).subject).toBe("[parameters('federatedSubject')]");
    expect(azureNested.properties.parameters.federatedSubject.value).toBe("[variables('federatedSubject')]");
  });

  it("creates the resource group Terraform expects to find", () => {
    expect(azureTemplate.variables.resourceGroupName).toBe(
      "[format('chatbot-{0}', parameters('chatbotSlug'))]",
    );
    // Terraform's local.name, which the data source looks up by.
    expect(source("infra/terraform/azure/main.tf")).toContain('name         = "chatbot-${var.tenant_slug}"');
  });

  // Creating one needs no Entra ID permission, so onboarding does not require
  // a directory administrator.
  it("uses a managed identity rather than an app registration", () => {
    expect(byType("Microsoft.ManagedIdentity/userAssignedIdentities")).toHaveLength(1);
  });
});

// Each Azure tenant's Terraform state lives in its own subscription. The
// template creates the storage, the workflows and the wizard derive its name,
// and all three have to agree.
describe("the Azure template's Terraform state storage", () => {
  const [account] = byType("Microsoft.Storage/storageAccounts");
  const [blobService] = byType("Microsoft.Storage/storageAccounts/blobServices");
  const [policy] = byType("Microsoft.Storage/storageAccounts/managementPolicies");
  const stateAssignment = byType("Microsoft.Authorization/roleAssignments").find((a) => a.scope);

  it("is named exactly as the platform derives it", () => {
    expect(azureTemplate.variables.stateAccountName).toBe(
      "[format('cbtf{0}', replace(parameters('chatbotSlug'), '-', ''))]",
    );
    expect(azureStateStorageAccountName("acme-corp")).toBe("cbtfacmecorp");
    expect(account.name).toBe("[parameters('stateAccountName')]");
  });

  // Storage account names: 3-24 lowercase letters and digits. An Azure slug
  // is at most 18 characters.
  it("fits Azure's name rules for the longest slug", () => {
    expect(azureStateStorageAccountName("a1-".repeat(6).slice(0, 18))).toMatch(/^[a-z0-9]{3,24}$/);
  });

  // No key to leak: state readers need an Entra ID identity with a data role.
  it("accepts only Entra ID sign-in, over TLS, with nothing public", () => {
    expect(account.properties).toMatchObject({
      allowSharedKeyAccess: false,
      allowBlobPublicAccess: false,
      minimumTlsVersion: "TLS1_2",
      supportsHttpsTrafficOnly: true,
    });
  });

  it("keeps state recoverable, but not old secrets forever", () => {
    expect(blobService.properties).toMatchObject({ isVersioningEnabled: true });
    expect(JSON.stringify(policy.properties)).toContain('"daysAfterCreationGreaterThan":30');
  });

  // Blob Data Contributor, on the state container only. Terraform's backend
  // needs to read, write and lease the state; nothing grants the identity
  // data access to the chatbot's documents.
  it("gives the deployment identity data access to its state container and nothing more", () => {
    expect(stateAssignment?.scope).toBe(
      "[format('Microsoft.Storage/storageAccounts/{0}/blobServices/default/containers/{1}', parameters('stateAccountName'), parameters('stateContainerName'))]",
    );
    expect(azureNested.properties.template.variables.storageBlobDataContributorRoleId).toBe(
      "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
    );
    expect(stateAssignment?.properties?.roleDefinitionId).toContain("storageBlobDataContributorRoleId");
    expect(azureTemplate.variables.stateContainerName).toBe("tfstate");
  });
});

describe("azureBootstrapCommand", () => {
  const command = azureBootstrapCommand({
    templateBaseUrl,
    tenantId,
    tenantSlug: "acme-corp",
    githubRepo,
    region: "westeurope",
  });

  it("deploys the published template at subscription scope", () => {
    expect(command).toContain("az deployment sub create");
    expect(command).toContain(`--template-uri ${templateBaseUrl}/${AZURE_TEMPLATE_OBJECT}`);
    expect(command).toContain("--location westeurope");
  });

  it("passes every parameter the template declares", () => {
    for (const name of Object.keys(azureTemplate.parameters)) {
      expect(command).toMatch(new RegExp(`\\b${name}=\\S+`));
    }
  });

  // Without it the CLI deploys into whichever subscription it defaults to —
  // for an operator who also has a work subscription, rarely the customer's.
  it("names the customer's subscription when it is known", () => {
    const pinned = azureBootstrapCommand({
      templateBaseUrl,
      tenantId,
      tenantSlug: "acme-corp",
      githubRepo,
      region: "westeurope",
      subscriptionId: "22222222-2222-2222-2222-222222222222",
    });
    expect(pinned).toContain("--subscription 22222222-2222-2222-2222-222222222222");
    expect(command).not.toContain("--subscription");
  });
});

describe("azureStateStorageCommands", () => {
  const commands = azureStateStorageCommands({
    tenantSlug: "acme-corp",
    region: "westeurope",
    clientId: "11111111-1111-1111-1111-111111111111",
    subscriptionId: "22222222-2222-2222-2222-222222222222",
  });

  it("creates the account without Shared Key, in the chatbot's resource group", () => {
    expect(commands).toContain("--resource-group chatbot-acme-corp --name cbtfacmecorp");
    expect(commands).toContain("--allow-shared-key-access false");
  });

  it("grants the given identity a data role on the state container alone", () => {
    expect(commands).toContain(
      '--assignee 11111111-1111-1111-1111-111111111111 --role "Storage Blob Data Contributor" --scope /subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/chatbot-acme-corp/providers/Microsoft.Storage/storageAccounts/cbtfacmecorp/blobServices/default/containers/tfstate',
    );
  });
});
