import {
  ShieldAlert,
  Cloud,
  Server,
  Lock,
  ShieldCheck,
  UserCog,
  Users,
  Key,
  EyeOff,
  Globe,
  CheckCircle2,
  MinusCircle,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import GuideHeader from "../GuideHeader";

const TOC = [
  { id: "overview", label: "Overview" },
  { id: "architecture", label: "Architecture" },
  { id: "tenant-isolation", label: "Tenant Isolation" },
  { id: "data-isolation", label: "Data Isolation" },
  { id: "credentials", label: "Credentials" },
  { id: "external-services", label: "External Services" },
];

const PRINCIPLES = [
  {
    icon: ShieldCheck,
    title: "Client-owned cloud resources",
    detail: "All runtime resources live in the client's own AWS or Azure account.",
  },
  {
    icon: UserCog,
    title: "Dedicated per-tenant role",
    detail: "Each tenant's deployment identity is created by the client's own one-click setup, and trusts only that chatbot's deployment runs.",
  },
  {
    icon: Users,
    title: "Strong tenant isolation",
    detail: "A dedicated network and resource set per tenant. On AWS the vector database is reachable only from that tenant's own compute; on Azure it is not yet network-isolated.",
  },
  {
    icon: Key,
    title: "Secret protection",
    detail: "Secrets are written to and read from managed secret stores inside the client's own account.",
  },
  {
    icon: EyeOff,
    title: "No visibility into document content",
    detail: "The platform never calls S3 GetObject/ListBucket (or the Azure Blob equivalent) — it can't preview, access, or store documents.",
  },
  {
    icon: Lock,
    title: "Encrypted where it matters most",
    detail: "Platform-to-cloud API calls and database connections use TLS, and every chatbot is served over HTTPS. On AWS without your own certificate, the hop from CloudFront to the load balancer is plain HTTP — see Cloud Prerequisites.",
  },
  {
    icon: Globe,
    title: "External service boundary awareness",
    detail: "Your configured LLM provider (and Pinecone, if selected) is the one boundary where document context leaves your environment, by design.",
  },
];

const CLIENT_ENVIRONMENT_ITEMS = [
  "Source documents in S3 / Azure Blob Storage",
  "Runtime services in ECS Fargate or Azure Container Apps",
  "Secrets in AWS Secrets Manager / Azure Key Vault",
  "Logs in CloudWatch / Log Analytics",
];

type AccessLevel = "yes" | "no" | "partial";

const ACCESS_STYLES: Record<AccessLevel, string> = {
  yes: "text-green-600",
  no: "text-gray-300",
  partial: "text-amber-500",
};

const ACCESS_ICONS: Record<AccessLevel, typeof CheckCircle2> = {
  yes: CheckCircle2,
  no: XCircle,
  partial: MinusCircle,
};

type AccessCell = { level: AccessLevel; detail: string };

const ACCESS_MATRIX: { resource: string; controlPlane: AccessCell; clientRuntime: AccessCell; externalProvider: AccessCell }[] = [
  {
    resource: "Document contents",
    controlPlane: { level: "no", detail: "Never accessed" },
    clientRuntime: { level: "yes", detail: "Stored & indexed" },
    externalProvider: { level: "partial", detail: "Relevant chunks, per query" },
  },
  {
    resource: "Document metadata (name, size, status)",
    controlPlane: { level: "yes", detail: "Tracked for the UI" },
    clientRuntime: { level: "yes", detail: "Validated on upload" },
    externalProvider: { level: "no", detail: "—" },
  },
  {
    resource: "Chat queries & answers",
    controlPlane: { level: "no", detail: "Never accessed" },
    clientRuntime: { level: "yes", detail: "Processed by the chatbot backend" },
    externalProvider: { level: "yes", detail: "Sent for inference" },
  },
  {
    resource: "Embeddings / vector data",
    controlPlane: { level: "no", detail: "Never accessed" },
    clientRuntime: { level: "yes", detail: "If using pgvector" },
    externalProvider: { level: "partial", detail: "If using Pinecone instead" },
  },
  {
    resource: "LLM / Pinecone API keys",
    controlPlane: { level: "partial", detail: "Encrypted copy, to provision your secret store" },
    clientRuntime: { level: "yes", detail: "Plaintext, in Secrets Manager / Key Vault" },
    externalProvider: { level: "no", detail: "Used to authenticate, not stored by us" },
  },
  {
    resource: "Deployment status & chatbot URL",
    controlPlane: { level: "yes", detail: "Only lifecycle data it needs" },
    clientRuntime: { level: "yes", detail: "Generated there" },
    externalProvider: { level: "no", detail: "—" },
  },
  {
    resource: "Infrastructure logs",
    controlPlane: { level: "no", detail: "Never accessed" },
    clientRuntime: { level: "yes", detail: "CloudWatch / Log Analytics, in your account" },
    externalProvider: { level: "no", detail: "—" },
  },
];

const EXTERNAL_PROVIDER_ITEMS = [
  "LLM inference via your configured model provider (OpenAI, Anthropic, or OpenRouter)",
  "Pinecone vector database, only if you chose Pinecone over pgvector",
  "Retrieved document context sent to the configured LLM provider to generate an answer",
];

export default function SecurityIsolationPage() {
  return (
    <div className="max-w-7xl px-8 py-8">
      <GuideHeader
        current="Security & Isolation"
        icon={ShieldAlert}
        tone="red"
        title="Security & Isolation"
        subtitle="The platform follows a control-plane / client-data-plane separation model to preserve client ownership and strong isolation of runtime resources and data."
      />

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[180px_1fr]">
        <nav className="hidden lg:block">
          <div className="sticky top-8 space-y-1 text-sm">
            {TOC.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="block rounded-md px-3 py-2 font-medium text-gray-700 hover:bg-gray-50"
              >
                {item.label}
              </a>
            ))}
          </div>
        </nav>

        <div className="min-w-0 space-y-10">
          <section id="overview">
            <h2 className="text-lg font-semibold text-gray-900">Overview</h2>
            <p className="mt-3 text-sm leading-relaxed text-gray-600">
              This platform is a control plane only. It deploys and monitors infrastructure, but has no access to
              the data plane — it does not know your queries, answers, documents, embeddings, or logs. The only
              information that ever crosses from your cloud account back to the platform is deployment lifecycle
              data: success/failure status and the resulting chatbot URL.
            </p>
          </section>

          <section id="architecture">
            <h2 className="text-lg font-semibold text-gray-900">Architecture Overview</h2>
            <div className="mt-4 grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
              <div className="rounded-lg border border-purple-200 bg-purple-50/60 p-5">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-100 text-purple-600">
                  <Cloud className="h-5 w-5" />
                </div>
                <div className="mt-2 text-sm font-semibold text-purple-700">Control Plane</div>
                <ul className="mt-2 space-y-1 text-xs text-gray-600">
                  <li>Manage deployments</li>
                  <li>Store deployment metadata</li>
                  <li>Show deployment status</li>
                  <li>No document content access</li>
                </ul>
              </div>

              <div className="flex flex-row items-center justify-center gap-2 sm:flex-col sm:gap-1">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-600 text-white">
                  <Lock className="h-4 w-4" />
                </span>
                <div className="text-center text-[11px] leading-tight text-gray-500">
                  <div className="font-medium text-purple-700">Boundary:</div>
                  <div>deployment metadata only</div>
                  <div className="mt-1">No access to tenant runtime content</div>
                </div>
              </div>

              <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-5">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-600">
                  <Server className="h-5 w-5" />
                </div>
                <div className="mt-2 text-sm font-semibold text-blue-700">Client Data Plane</div>
                <ul className="mt-2 space-y-1 text-xs text-gray-600">
                  <li>Frontend and backend runtime</li>
                  <li>Document storage</li>
                  <li>Vector storage</li>
                  <li>Secrets</li>
                  <li>Logs and monitoring</li>
                </ul>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900">Key Security Principles</h2>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {PRINCIPLES.map((p) => (
                <div key={p.title} className="rounded-lg border p-4">
                  <p.icon className="h-5 w-5 text-red-600" />
                  <div className="mt-2 text-sm font-semibold text-gray-900">{p.title}</div>
                  <div className="mt-1 text-xs leading-relaxed text-gray-500">{p.detail}</div>
                </div>
              ))}
            </div>
          </section>

          <section id="tenant-isolation">
            <h2 className="text-lg font-semibold text-gray-900">Tenant Isolation</h2>
            <p className="mt-3 text-sm leading-relaxed text-gray-600">
              Every tenant gets its own network, deployed by its own Terraform run — nothing is shared with any
              other tenant at the network level. On AWS each tenant has its own VPC, and where a per-tenant service
              needs to be reachable at all (the vector database, for pgvector tenants), a security group restricts
              it to that tenant&apos;s own compute only — it has no public IP and no ingress from anywhere else.
              Compute runs in public subnets (tasks get public IPs directly, to avoid the cost of NAT gateways), so
              isolation between tenants comes from separate VPCs and security groups, not from private subnetting.
              On Azure each tenant has its own Container Apps environment in its own resource group, but the
              pgvector server uses public networking that admits any Azure-hosted client; its password is what
              protects it.
            </p>
          </section>

          <section id="data-isolation">
            <h2 className="text-lg font-semibold text-gray-900">Data Isolation</h2>
            <p className="mt-3 text-sm leading-relaxed text-gray-600">
              Each tenant gets its own S3 bucket (or Azure Blob container) for documents, its own Secrets Manager
              entries (or Key Vault), and — if using pgvector — its own RDS instance for embeddings. Nothing is
              pooled across tenants. If you use Pinecone instead, the platform creates one dedicated serverless
              index per tenant inside your own Pinecone project.
            </p>
          </section>

          <section id="credentials">
            <h2 className="text-lg font-semibold text-gray-900">Credentials</h2>
            <p className="mt-3 text-sm leading-relaxed text-gray-600">
              The platform never holds an AWS or Azure credential capable of reading your documents. Uploads go
              through a small Lambda (or Function) that lives inside your own account and can only write and
              delete under your tenant&apos;s own prefix — never list or read the bucket. The deployment identity
              is likewise scoped: it accepts only this chatbot&apos;s deployment runs, signed by GitHub, and the
              platform itself may use it on AWS only at onboarding, to write your keys, for this chatbot only. On
              Azure its roles stop at the chatbot&apos;s own resource group. Its AWS permissions policy is broad
              rather than fully minimal today (see Cloud Prerequisites for the exact policy and why).
            </p>
          </section>

          <section id="external-services">
            <h2 className="text-lg font-semibold text-gray-900">External Services</h2>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-green-200 bg-green-50/60 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-green-800">
                  <CheckCircle2 className="h-4 w-4" />
                  What remains in the client environment
                </div>
                <ul className="mt-2 space-y-1.5 text-xs text-gray-700">
                  {CLIENT_ENVIRONMENT_ITEMS.map((item) => (
                    <li key={item} className="flex gap-1.5">
                      <span className="text-green-400">•</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-blue-800">
                  <Globe className="h-4 w-4" />
                  What may involve external providers
                </div>
                <ul className="mt-2 space-y-1.5 text-xs text-gray-700">
                  {EXTERNAL_PROVIDER_ITEMS.map((item) => (
                    <li key={item} className="flex gap-1.5">
                      <span className="text-blue-400">•</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="mt-6">
              <h3 className="text-sm font-semibold text-gray-900">Who Can Access What?</h3>
              <div className="mt-3 overflow-x-auto rounded-lg border">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50 text-xs text-gray-500">
                      <th className="px-4 py-2 font-medium">Resource / data</th>
                      <th className="px-4 py-2 font-medium">Control plane</th>
                      <th className="px-4 py-2 font-medium">Client runtime</th>
                      <th className="px-4 py-2 font-medium">External provider</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {ACCESS_MATRIX.map((row) => (
                      <tr key={row.resource}>
                        <td className="px-4 py-2.5 font-medium text-gray-900">{row.resource}</td>
                        {[row.controlPlane, row.clientRuntime, row.externalProvider].map((cell, i) => {
                          const Icon = ACCESS_ICONS[cell.level];
                          return (
                            <td key={i} className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5 text-xs text-gray-600">
                                <Icon className={`h-3.5 w-3.5 shrink-0 ${ACCESS_STYLES[cell.level]}`} />
                                {cell.detail}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <p className="text-sm text-amber-900">
              This platform is designed to orchestrate deployment and display status. It does not preview or
              store client document contents.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
