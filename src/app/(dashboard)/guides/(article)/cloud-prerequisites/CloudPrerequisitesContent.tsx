"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";

type CloudTab = "aws" | "azure";

type Step = { title: string; detail: string };

const AWS_STEPS: Step[] = [
  {
    title: "Get your account ID & region",
    detail:
      "Copy your 12-digit AWS account ID (top-right in the console, or run aws sts get-caller-identity) and pick the region you want your chatbot infrastructure to run in.",
  },
  {
    title: "Start onboarding and choose a slug",
    detail:
      "The slug names your deployment role and your Terraform state bucket, so the form checks it as you type, against every other chatbot and against S3 bucket names held anywhere. The setup button appears once the slug is confirmed free. Save a draft before leaving the form: a new form gets a new chatbot ID, which a setup already run does not trust.",
  },
  {
    title: "Run the one-click setup",
    detail:
      "Configure AWS account opens CloudFormation with every value filled in. The stack registers GitHub as an identity provider (if your account already has it, the form offers to reuse it), creates the role chatbot-client-deploy-<slug> with the trust policy and permissions below, and creates the state bucket tfstate-<slug>-<account>-<region>-an. Run it before submitting the form, since onboarding writes your keys into your Secrets Manager immediately.",
  },
  {
    title: "Copy the role's ARN and test the connection",
    detail:
      "Copy DeploymentRoleArn from the stack's Outputs tab into the form, then press Test connection. It signs in exactly as a deployment would and checks the state bucket, without changing anything. A role another chatbot already uses is refused: each chatbot's setup creates its own.",
  },
];

const AZURE_STEPS: Step[] = [
  {
    title: "Get your subscription & tenant ID",
    detail:
      "Azure Portal → Subscriptions for the Subscription ID; Microsoft Entra ID → Overview for the Tenant ID. Or run az account show --query \"{sub:id, tenant:tenantId}\". The setup deployment also shows both in its outputs.",
  },
  {
    title: "Start onboarding and choose a slug",
    detail:
      "3–18 characters. The slug names your resource group, deployment identity and state storage, and several Azure names built from it must be unique worldwide, so the form checks it as you type, against every other chatbot and against names Azure already holds. The setup button appears once the slug is confirmed free. Save a draft before leaving the form: a new form gets a new chatbot ID, which a setup already run does not trust.",
  },
  {
    title: "Run the one-click setup",
    detail:
      "Configure Azure opens the portal's custom deployment. Enter the values the form lists beside the button — Chatbot Id is this chatbot's ID from the form, not your Azure tenant ID — or run the az deployment sub create command the form shows with every value filled in. The setup creates the resource group chatbot-<slug>, a user-assigned managed identity with a federated credential that trusts this chatbot's deployments only, Contributor and User Access Administrator on that resource group alone, and the state storage account cbtf<slug>.",
  },
  {
    title: "Copy the client ID and test the connection",
    detail:
      "Copy clientId from the deployment's Outputs into the form, then press Test connection. It signs in exactly as a deployment would and checks the resource group and state storage, without changing anything; if sign-in fails, it says why and what to fix. A client ID another chatbot already uses is refused. Never create a client secret: the platform does not ask for one.",
  },
];

const AWS_TRUST_POLICY = `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GitHubActionsDeploy",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:environment:tenant-CHATBOT_ID"
        }
      }
    },
    {
      "Sid": "PlatformOnboarding",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::PLATFORM_ACCOUNT_ID:root" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "sts:ExternalId": "CHATBOT_ID" }
      }
    }
  ]
}`;

const AWS_PERMISSIONS_POLICY = `{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Networking", "Effect": "Allow", "Action": "ec2:*", "Resource": "*" },
    { "Sid": "LoadBalancer", "Effect": "Allow", "Action": "elasticloadbalancing:*", "Resource": "*" },
    { "Sid": "Compute", "Effect": "Allow", "Action": "ecs:*", "Resource": "*" },
    { "Sid": "Images", "Effect": "Allow", "Action": "ecr:*", "Resource": "*" },
    { "Sid": "Storage", "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
    { "Sid": "Functions", "Effect": "Allow", "Action": "lambda:*", "Resource": "*" },
    { "Sid": "Secrets", "Effect": "Allow", "Action": "secretsmanager:*", "Resource": "*" },
    { "Sid": "Logs", "Effect": "Allow", "Action": "logs:*", "Resource": "*" },
    { "Sid": "Database", "Effect": "Allow", "Action": "rds:*", "Resource": "*" },
    { "Sid": "Cdn", "Effect": "Allow", "Action": "cloudfront:*", "Resource": "*" },
    {
      "Sid": "IamForTaskRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole",
        "iam:TagRole", "iam:PassRole", "iam:CreateServiceLinkedRole"
      ],
      "Resource": "*"
    }
  ]
}`;

const AZURE_BOOTSTRAP_CMD = `az deployment sub create \\
  --subscription <subscription-id> \\
  --name chatbot-bootstrap-<slug> \\
  --location <region> \\
  --template-uri <template URL shown in the form> \\
  --parameters chatbotId=<chatbot ID shown in the form> chatbotSlug=<slug> \\
    gitHubOwner=<owner> gitHubRepo=<repo> location=<region>`;

const TOC = [
  { id: "aws-prerequisites", label: "AWS Prerequisites" },
  { id: "azure-prerequisites", label: "Azure Prerequisites" },
  { id: "llm-api-keys", label: "LLM API Keys" },
  { id: "pinecone", label: "Pinecone (Optional)" },
  { id: "network-requirements", label: "Network Requirements" },
];

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-6">
      {steps.map((step, i) => (
        <li key={step.title} className="relative flex gap-4">
          {i < steps.length - 1 && (
            <span aria-hidden className="absolute left-4 top-9 h-[calc(100%-0.75rem)] w-px bg-blue-200" />
          )}
          <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
            {i + 1}
          </span>
          <div className="pt-1">
            <div className="font-semibold text-gray-900">{step.title}</div>
            <div className="mt-0.5 text-sm leading-relaxed text-gray-500">{step.detail}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function CloudPrerequisitesContent() {
  const [tab, setTab] = useState<CloudTab>("aws");

  function goTo(id: string, forTab?: CloudTab) {
    if (forTab) setTab(forTab);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[200px_1fr]">
      <nav className="hidden lg:block">
        <div className="sticky top-8">
          <div className="text-xs font-semibold uppercase tracking-wide text-blue-600">On this page</div>
          <ul className="mt-3 space-y-2 text-sm">
            {TOC.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => goTo(item.id, item.id === "aws-prerequisites" ? "aws" : item.id === "azure-prerequisites" ? "azure" : undefined)}
                  className="text-left font-medium text-gray-700 hover:text-blue-600"
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className="min-w-0 space-y-10">
        <section id={tab === "aws" ? "aws-prerequisites" : "azure-prerequisites"}>
          <div className="flex gap-6 border-b text-sm">
            <button
              type="button"
              onClick={() => setTab("aws")}
              className={`-mb-px border-b-2 px-1 py-3 font-medium ${
                tab === "aws" ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              AWS
            </button>
            <button
              type="button"
              onClick={() => setTab("azure")}
              className={`-mb-px border-b-2 px-1 py-3 font-medium ${
                tab === "azure" ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Azure
            </button>
          </div>

          {tab === "aws" ? (
            <div className="mt-6">
              <h2 className="text-base font-semibold text-gray-900">AWS Prerequisites</h2>
              <p className="mt-1 text-sm text-gray-500">
                A one-click setup creates the role your chatbot&apos;s deployments sign in as, through GitHub&apos;s
                identity provider. No access key is created or shared.
              </p>

              <div className="mt-6">
                <StepList steps={AWS_STEPS} />
              </div>

              <div className="mt-6 rounded-lg border bg-gray-50 p-4">
                <div className="text-sm font-semibold text-gray-900">Trust Policy</div>
                <p className="mt-1 text-xs text-gray-500">
                  The setup applies this for you. Only if you build the role by hand: the form shows it with your
                  values filled in, GitHub must be registered as an identity provider with audience sts.amazonaws.com,
                  and the role name must start with chatbot-client-deploy- — the platform may assume no other role.
                  The first statement lets this chatbot&apos;s deployments sign in; the second lets the platform
                  write your keys into your Secrets Manager at onboarding, for this chatbot only.
                </p>
                <pre className="mt-3 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                  <code>{AWS_TRUST_POLICY}</code>
                </pre>
              </div>

              <div className="mt-6 rounded-lg border bg-gray-50 p-4">
                <div className="text-sm font-semibold text-gray-900">Required Permissions</div>
                <pre className="mt-3 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                  <code>{AWS_PERMISSIONS_POLICY}</code>
                </pre>
              </div>

              <div className="mt-6">
                <div className="text-sm font-semibold text-gray-900">Other Requirements</div>
                <ul className="mt-2 space-y-1.5">
                  <RequirementRow
                    label="Region"
                    detail="IAM roles are global, not tied to a region — you'll pick the region your infrastructure deploys into separately, on the onboarding form."
                  />
                  <RequirementRow
                    label="Billing"
                    detail="Ensure your account has permission to create billable resources (VPC, load balancer, ECS, and — if using pgvector — RDS)."
                  />
                </ul>
              </div>
            </div>
          ) : (
            <div className="mt-6">
              <h2 className="text-base font-semibold text-gray-900">Azure Prerequisites</h2>
              <p className="mt-1 text-sm text-gray-500">
                A one-click setup creates the identity your chatbot&apos;s deployments sign in as, through a federated
                credential, with permissions confined to the chatbot&apos;s own resource group. No secret is created or
                shared.
              </p>

              <div className="mt-6">
                <StepList steps={AZURE_STEPS} />
              </div>

              <div className="mt-6 rounded-lg border bg-gray-50 p-4">
                <div className="text-sm font-semibold text-gray-900">Setup Command</div>
                <p className="mt-1 text-xs text-gray-500">
                  The same setup as the Configure Azure button, from the command line. The form shows it with every
                  value filled in, including your subscription, so it cannot land in whichever subscription the
                  Azure CLI defaults to. Running it again for an existing chatbot is safe: it adds what is missing
                  and leaves the rest as it is.
                </p>
                <pre className="mt-3 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                  <code>{AZURE_BOOTSTRAP_CMD}</code>
                </pre>
              </div>

              <div className="mt-6">
                <div className="text-sm font-semibold text-gray-900">Other Requirements</div>
                <ul className="mt-2 space-y-1.5">
                  <RequirementRow
                    label="Region"
                    detail="Pick the Azure region you want your chatbot infrastructure deployed into, e.g. eastus or westeurope."
                  />
                  <RequirementRow
                    label="Billing"
                    detail="Ensure your subscription has permission to create billable resources (resource group, Container Apps, and — if using pgvector — PostgreSQL Flexible Server)."
                  />
                </ul>
              </div>
            </div>
          )}
        </section>

        <section id="llm-api-keys">
          <h2 className="text-base font-semibold text-gray-900">LLM API Keys</h2>
          <p className="mt-1 text-sm text-gray-500">
            Get an API key from whichever provider you plan to use — the platform never sees your usage beyond what it
            takes to relay a chat request.
          </p>
          <div className="mt-4 overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-xs text-gray-500">
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Where</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr>
                  <td className="px-4 py-2.5 font-medium text-gray-900">OpenAI</td>
                  <td className="px-4 py-2.5 text-gray-600">platform.openai.com → API keys</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-medium text-gray-900">Anthropic</td>
                  <td className="px-4 py-2.5 text-gray-600">console.anthropic.com → API keys</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-medium text-gray-900">OpenRouter</td>
                  <td className="px-4 py-2.5 text-gray-600">openrouter.ai → Keys</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            OpenRouter users: the platform&apos;s default free-tier model slug can rotate out of availability without
            warning. Set an explicit model override on the onboarding form rather than relying on the default.
          </p>
        </section>

        <section id="pinecone">
          <h2 className="text-base font-semibold text-gray-900">Pinecone (Optional)</h2>
          <p className="mt-1 text-sm text-gray-500">Only needed if you choose Pinecone instead of pgvector as your vector store.</p>
          <p className="mt-3 text-sm leading-relaxed text-gray-600">
            Sign up (or use your existing account) at app.pinecone.io → API keys. The platform creates one dedicated
            serverless index for you inside your own project — you don&apos;t need to create the index yourself.
            Every tenant&apos;s Pinecone index is created in AWS us-east-1, regardless of which cloud or region your
            chatbot infrastructure runs in.
          </p>
        </section>

        <section id="network-requirements">
          <h2 className="text-base font-semibold text-gray-900">Network Requirements</h2>
          <ul className="mt-3 space-y-3 text-sm">
            <li>
              <span className="font-medium text-gray-900">AWS — HTTPS either way, two routes to it.</span>{" "}
              <span className="text-gray-600">
                Supply a TLS certificate ARN and the load balancer terminates TLS itself on 443, with port 80
                redirecting to it and traffic encrypted end to end. Request the certificate in AWS Certificate
                Manager, in the same region as the deployment, covering your custom domain, validated by DNS.
                Leave it blank and a CloudFront distribution is created in front of the load balancer instead,
                so the chatbot is still served over HTTPS on a *.cloudfront.net hostname with no DNS work — but
                the hop from CloudFront to the load balancer is plain HTTP, and the load balancer stays directly
                reachable without encryption.
              </span>
            </li>
            <li>
              <span className="font-medium text-gray-900">Azure — HTTPS out of the box.</span>{" "}
              <span className="text-gray-600">
                Azure Container Apps automatically provisions a managed HTTPS endpoint on a
                *.azurecontainerapps.io FQDN — no extra configuration needed.
              </span>
            </li>
            <li>
              <span className="font-medium text-gray-900">Custom domain.</span>{" "}
              <span className="text-gray-600">
                AWS only for now — supply the hostname with its certificate, then point a CNAME at the load
                balancer address shown after your first deployment. On Azure a custom domain is accepted but not
                yet bound, so the chatbot answers on its *.azurecontainerapps.io address only.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function RequirementRow({ label, detail }: { label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
      <div>
        <span className="font-medium text-gray-900">{label}:</span> <span className="text-gray-600">{detail}</span>
      </div>
    </li>
  );
}
