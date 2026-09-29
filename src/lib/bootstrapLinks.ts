/**
 * The one-click links that create a tenant's deployment identity.
 *
 * Both clouds can open their own console on a review screen for a template
 * fetched from a URL. That turns the worst step of onboarding — composing a
 * trust policy in the IAM console, or running two `az` commands that have to
 * be exactly right — into a page the customer reads and approves. The
 * approval still happens in their cloud, under their own sign-in; the
 * platform only builds the link.
 *
 * Both templates have to be fetched over the public internet: CloudFormation
 * fetches the S3 object server-side, and the Azure portal fetches its template
 * from the customer's browser. Neither can reach a control plane running on
 * localhost, and neither can read a file in a private repository, which is why
 * the templates are published to a public bucket rather than served from this
 * application (see infra/platform/bootstrap-templates). Public means readable:
 * the templates hold no customer data, since every tenant-specific value is a
 * parameter.
 *
 * Pure functions with no environment access, so the wizard can render the
 * links and a test can check them.
 */

import type { GithubRepo } from "@/lib/githubOidc";

export const AWS_TEMPLATE_OBJECT = "aws/tenant-bootstrap.yaml";
export const AZURE_TEMPLATE_OBJECT = "azure/tenant-bootstrap.json";

/** Trailing slashes removed so joining never produces a double slash. */
function joinUrl(base: string, object: string): string {
  return `${base.trim().replace(/\/+$/, "")}/${object}`;
}

export type AwsBootstrapOptions = {
  templateBaseUrl: string;
  tenantId: string;
  tenantSlug: string;
  githubRepo: GithubRepo;
  platformAccountId: string;
  region: string;
  /**
   * False when the customer's account already has GitHub registered as an
   * identity provider — from another chatbot, or from unrelated use of GitHub
   * Actions. An account may register an issuer only once, so a second attempt
   * fails the whole stack.
   */
  createOidcProvider?: boolean;
};

/**
 * A CloudFormation Quick Create link: the console opens straight on the
 * stack's review page with every parameter filled in, so the customer reads
 * what will be created and presses one button.
 *
 * Parameters ride in the fragment, after the `#`, because that is where the
 * console's own router reads them. A value that needs escaping therefore has
 * to be encoded by hand — the browser will not do it for the fragment.
 */
export function awsQuickCreateUrl(opts: AwsBootstrapOptions): string {
  const region = opts.region.trim();
  const parameters: Record<string, string> = {
    templateURL: joinUrl(opts.templateBaseUrl, AWS_TEMPLATE_OBJECT),
    stackName: `chatbot-bootstrap-${opts.tenantSlug}`,
    param_TenantId: opts.tenantId,
    param_TenantSlug: opts.tenantSlug,
    param_GitHubOwner: opts.githubRepo.owner,
    param_GitHubRepo: opts.githubRepo.repo,
    param_PlatformAccountId: opts.platformAccountId,
    param_CreateGitHubOidcProvider: opts.createOidcProvider === false ? "No" : "Yes",
  };

  const query = Object.entries(parameters)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  // The region appears twice on purpose: once for the console host, and once
  // as a query parameter, because the console honours the latter when
  // switching regions after sign-in.
  return (
    `https://${region}.console.aws.amazon.com/cloudformation/home` +
    `?region=${encodeURIComponent(region)}#/stacks/create/review?${query}`
  );
}

/**
 * The bucket that holds a tenant's Terraform state, in the customer's own
 * account.
 *
 * The "-<account>-<region>-an" suffix places it in the account's regional
 * namespace, where only that account can create a bucket. The name stays
 * predictable, so the platform derives it rather than being told it, and no
 * other account can register it first. Must match the template's
 * TerraformStateBucket and .github/scripts/terraform-init-aws.sh.
 */
export function awsStateBucketName(tenantSlug: string, awsAccountId: string, region: string): string {
  return `tfstate-${tenantSlug}-${awsAccountId}-${region}-an`;
}

/** The parameters the AWS template declares, in its own order. */
const AWS_TEMPLATE_PARAMETERS = [
  "TenantId",
  "TenantSlug",
  "GitHubOwner",
  "GitHubRepo",
  "PlatformAccountId",
  "CreateGitHubOidcProvider",
] as const;

/**
 * Moves an existing bootstrap stack to the current template, keeping every
 * value it was created with.
 *
 * A Quick Create link cannot do this: the stack's name is fixed per tenant, so
 * creating it again fails. Tenants bootstrapped before the template gained
 * its Terraform state bucket run this once, and their next deploy moves their
 * state into it.
 */
export function awsUpdateStackCommand(opts: {
  templateBaseUrl: string;
  tenantSlug: string;
  region: string;
}): string {
  const parameters = AWS_TEMPLATE_PARAMETERS.map((p) => `ParameterKey=${p},UsePreviousValue=true`).join(" ");
  return [
    "aws cloudformation update-stack",
    `--region ${opts.region.trim()}`,
    `--stack-name chatbot-bootstrap-${opts.tenantSlug}`,
    `--template-url ${joinUrl(opts.templateBaseUrl, AWS_TEMPLATE_OBJECT)}`,
    `--parameters ${parameters}`,
    "--capabilities CAPABILITY_NAMED_IAM",
  ].join(" \\\n  ");
}

/**
 * The state bucket's essentials, for a customer who builds by hand instead of
 * using the template. us-east-1 is the one region CreateBucket refuses a
 * location constraint for.
 */
export function awsStateBucketCommands(opts: {
  tenantSlug: string;
  awsAccountId: string;
  region: string;
}): string {
  const region = opts.region.trim();
  const bucket = awsStateBucketName(opts.tenantSlug, opts.awsAccountId, region);
  const location = region === "us-east-1" ? "" : ` \\\n  --create-bucket-configuration LocationConstraint=${region}`;
  return [
    `aws s3api create-bucket --bucket ${bucket} --bucket-namespace account-regional --region ${region}${location}`,
    `aws s3api put-bucket-versioning --bucket ${bucket} --versioning-configuration Status=Enabled`,
    `aws s3api put-public-access-block --bucket ${bucket} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`,
  ].join("\n");
}

/**
 * A Deploy to Azure link. The portal opens its custom-deployment blade on the
 * template, and the customer picks the subscription, confirms the values and
 * presses Create.
 *
 * Unlike CloudFormation, the portal's deployment blade takes no parameter
 * values from the URL — only the template's own location — so the wizard shows
 * the values to enter alongside the button (see azureBootstrapParameters).
 * Baking them into a per-tenant template published per onboarding would remove
 * that step, at the cost of an object written into the bucket for every tenant
 * and an onboarding step that can now fail on a bucket write.
 */
export function azureDeployUrl(templateBaseUrl: string): string {
  const template = joinUrl(templateBaseUrl, AZURE_TEMPLATE_OBJECT);
  return `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(template)}`;
}

/**
 * The storage account that holds an Azure tenant's Terraform state, in the
 * tenant's own resource group. Storage account names allow only lowercase
 * letters and digits, and an Azure slug is at most 18 characters, so this is
 * at most 22 with no truncation. The "cbtf" prefix keeps it apart from the
 * chatbot's own "chatbot…" accounts. Must match the bootstrap template and
 * .github/scripts/terraform-init-azure.sh.
 */
export function azureStateStorageAccountName(tenantSlug: string): string {
  return `cbtf${tenantSlug.replace(/-/g, "")}`;
}

/**
 * Runs the bootstrap from the command line, with every value filled in — the
 * one route on Azure that involves no typing, since the portal cannot take
 * values from a link. For an existing chatbot it adds what the template has
 * gained since and leaves everything else as it is, since every resource in
 * the template is declared by name.
 *
 * `--subscription` is included whenever it is known. Without it `az` deploys
 * into whichever subscription it happens to default to, which for an operator
 * who also has a work subscription is rarely the customer's.
 */
export function azureBootstrapCommand(opts: {
  templateBaseUrl: string;
  tenantId: string;
  tenantSlug: string;
  githubRepo: GithubRepo;
  region: string;
  subscriptionId?: string;
}): string {
  const region = opts.region.trim();
  const subscription = opts.subscriptionId?.trim();
  return [
    "az deployment sub create",
    ...(subscription ? [`--subscription ${subscription}`] : []),
    `--name chatbot-bootstrap-${opts.tenantSlug}`,
    `--location ${region}`,
    `--template-uri ${joinUrl(opts.templateBaseUrl, AZURE_TEMPLATE_OBJECT)}`,
    `--parameters chatbotId=${opts.tenantId} chatbotSlug=${opts.tenantSlug} gitHubOwner=${opts.githubRepo.owner} gitHubRepo=${opts.githubRepo.repo} location=${region}`,
  ].join(" \\\n  ");
}

/**
 * The state storage's essentials, for a customer who builds by hand, or whose
 * deployment identity is not the one the template creates. The last command
 * is the one such an identity always needs: without a data role on the state
 * container, Terraform's backend cannot read or lock the state.
 */
export function azureStateStorageCommands(opts: {
  tenantSlug: string;
  region: string;
  clientId: string;
  subscriptionId: string;
}): string {
  const group = `chatbot-${opts.tenantSlug}`;
  const account = azureStateStorageAccountName(opts.tenantSlug);
  const container = `/subscriptions/${opts.subscriptionId}/resourceGroups/${group}/providers/Microsoft.Storage/storageAccounts/${account}/blobServices/default/containers/tfstate`;
  return [
    `az storage account create --resource-group ${group} --name ${account} --location ${opts.region.trim()} --sku Standard_LRS --kind StorageV2 --allow-shared-key-access false --allow-blob-public-access false --min-tls-version TLS1_2 --https-only true`,
    `az storage account blob-service-properties update --resource-group ${group} --account-name ${account} --enable-versioning true`,
    `az storage container-rm create --resource-group ${group} --storage-account ${account} --name tfstate`,
    `az role assignment create --assignee ${opts.clientId} --role "Storage Blob Data Contributor" --scope ${container}`,
  ].join("\n");
}

/**
 * The values the customer types into the portal's deployment blade, in the
 * order the template declares them. Kept here rather than in the component so
 * the template's parameter names and the wizard's labels cannot drift apart
 * without a test noticing.
 *
 * Each label is what the portal itself shows for that parameter — it splits
 * the name at capitals — so the customer can match the two field by field.
 * The first parameter is named chatbotId, not tenantId: the portal is where
 * the customer also sees their Azure tenant, and "Tenant Id" there read as
 * that, so the wrong ID went in and the federated credential trusted a
 * subject no run carries.
 */
export function azureBootstrapParameters(opts: {
  tenantId: string;
  tenantSlug: string;
  githubRepo: GithubRepo;
  region: string;
}): { name: string; label: string; value: string }[] {
  return [
    { name: "chatbotId", label: "Chatbot Id", value: opts.tenantId },
    { name: "chatbotSlug", label: "Chatbot Slug", value: opts.tenantSlug },
    { name: "gitHubOwner", label: "Git Hub Owner", value: opts.githubRepo.owner },
    { name: "gitHubRepo", label: "Git Hub Repo", value: opts.githubRepo.repo },
    { name: "location", label: "Location", value: opts.region },
  ];
}
