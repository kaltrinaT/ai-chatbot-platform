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
    title: "Create the IAM role",
    detail:
      "IAM → Roles → Create role → Custom trust policy, trusting the platform's account. Don't add an sts:ExternalId condition — the platform's AssumeRole call doesn't send one, and a trust policy that requires it will make every deploy fail.",
  },
  {
    title: "Name it correctly",
    detail:
      "The role name must start with chatbot-client-deploy- (e.g. chatbot-client-deploy-acme). This is required, not cosmetic — the platform can only assume roles matching that prefix; any other name is denied before your trust policy is even evaluated.",
  },
  {
    title: "Attach the permissions policy",
    detail:
      "Grants everything Terraform provisions on your behalf: a VPC, load balancer, ECS cluster with two Fargate services, two ECR repos, an S3 documents bucket, a docs-signer Lambda, Secrets Manager secrets, a CloudWatch log group, and (if you chose pgvector) an RDS instance. See the policy below.",
  },
  {
    title: "Copy the role's ARN",
    detail: "arn:aws:iam::<your-account-id>:role/chatbot-client-deploy-<something> — you'll paste this during onboarding.",
  },
];

const AZURE_STEPS: Step[] = [
  {
    title: "Get your subscription & tenant ID",
    detail:
      "Azure Portal → Subscriptions for the Subscription ID; Microsoft Entra ID → Overview for the Tenant ID. Or run az account show --query \"{sub:id, tenant:tenantId}\".",
  },
  {
    title: "Create a service principal",
    detail: "Microsoft Entra ID → App registrations → New registration. Copy the Application (client) ID.",
  },
  {
    title: "Create a client secret",
    detail:
      "Certificates & secrets → New client secret. Copy the \"Value\" column immediately — it's shown only once.",
  },
  {
    title: "Grant Contributor at the subscription level",
    detail:
      "Must be subscription-scoped, not a resource group — Terraform creates the resource group itself during deployment, so a narrower scope will fail at the very first deploy step.",
  },
];

const AWS_TRUST_POLICY = `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::PLATFORM_ACCOUNT_ID:root" },
      "Action": "sts:AssumeRole"
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

const AZURE_ROLE_ASSIGNMENT_CMD = `az role assignment create \\
  --assignee <app-client-id> \\
  --role Contributor \\
  --scope /subscriptions/<subscription-id>`;

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
                Create an IAM role that the platform will assume to provision resources in your AWS account.
              </p>

              <div className="mt-6">
                <StepList steps={AWS_STEPS} />
              </div>

              <div className="mt-6 rounded-lg border bg-gray-50 p-4">
                <div className="text-sm font-semibold text-gray-900">Trust Policy</div>
                <p className="mt-1 text-xs text-gray-500">
                  Replace PLATFORM_ACCOUNT_ID with the value the platform operator gives you.
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
                Create a service principal that the platform will use to provision resources in your Azure subscription.
              </p>

              <div className="mt-6">
                <StepList steps={AZURE_STEPS} />
              </div>

              <div className="mt-6 rounded-lg border bg-gray-50 p-4">
                <div className="text-sm font-semibold text-gray-900">Role Assignment Command</div>
                <pre className="mt-3 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                  <code>{AZURE_ROLE_ASSIGNMENT_CMD}</code>
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
              <span className="font-medium text-gray-900">AWS — HTTP only.</span>{" "}
              <span className="text-gray-600">
                The load balancer only provisions an HTTP listener on port 80 — there&apos;s no HTTPS/TLS termination.
                Access your chatbot with http://, not https://; if your browser auto-upgrades the URL, the connection
                will simply time out.
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
                Optional on both clouds — point a CNAME at the URL assigned after your first deployment.
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
