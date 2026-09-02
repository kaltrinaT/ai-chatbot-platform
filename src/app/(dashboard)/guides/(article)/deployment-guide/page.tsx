import Link from "next/link";
import {
  Box,
  Info,
  User,
  ClipboardCheck,
  Send,
  GitBranch,
  Layers,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
  Ban,
  FileText,
  Cloud,
  Wrench,
  ShieldAlert,
  Rocket,
  ArrowRight,
  Database,
} from "lucide-react";
import { CloudLogo } from "@/app/(dashboard)/_components/ProviderLogo";
import GuideHeader from "../GuideHeader";
import SectionHeading from "../SectionHeading";

const WORKFLOW_STEPS = [
  { icon: User, title: "1. Select Chatbot", detail: "Choose the chatbot and target environment for deployment." },
  {
    icon: ClipboardCheck,
    title: "2. Review Prerequisites",
    detail: "Validate cloud, network, IAM, storage, and other requirements.",
  },
  { icon: Send, title: "3. Submit Deployment", detail: "Provide configuration inputs and trigger the deployment." },
  {
    icon: GitBranch,
    title: "4. GitHub Actions Workflow",
    detail: "A workflow is dispatched and orchestrates the provisioning steps.",
  },
  {
    icon: Layers,
    title: "5. Terraform Provisioning",
    detail: "Terraform provisions or updates infrastructure in your cloud environment.",
  },
  {
    icon: CheckCircle2,
    title: "6. Runtime Available",
    detail: "Once complete, the chatbot runtime and endpoint are ready.",
  },
];

const STATUSES = [
  { icon: Clock, tone: "orange", label: "Pending", detail: "Deployment has been queued and is awaiting execution." },
  { icon: Loader2, tone: "blue", label: "Running", detail: "Deployment is in progress. Infrastructure is being provisioned.", spin: true },
  { icon: CheckCircle2, tone: "green", label: "Succeeded", detail: "Deployment completed successfully. Runtime is available." },
  { icon: XCircle, tone: "red", label: "Failed", detail: "Deployment encountered an error and did not complete." },
  { icon: Ban, tone: "gray", label: "Cancelled", detail: "Deployment was cancelled before it finished." },
];

const STATUS_TONES: Record<string, string> = {
  orange: "bg-orange-100 text-orange-600",
  blue: "bg-blue-100 text-blue-600",
  green: "bg-green-100 text-green-600",
  red: "bg-red-100 text-red-600",
  gray: "bg-gray-100 text-gray-500",
};

const DURING_DEPLOYMENT_LEFT = [
  { title: "Validate configuration", detail: "Validate provided settings and dependencies." },
  { title: "Prepare provider credentials", detail: "Assume roles / service principals and validate access." },
  { title: "Dispatch workflow", detail: "Trigger the GitHub Actions workflow with deployment inputs." },
  { title: "Provision AWS or Azure resources", detail: "Create or update infrastructure using Terraform." },
];

const DURING_DEPLOYMENT_RIGHT = [
  { title: "Prepare frontend & backend containers", detail: "Build and configure container images and services." },
  { title: "Configure secrets", detail: "Store and reference secrets securely in your environment." },
  { title: "Return chatbot endpoint", detail: "Register the endpoint and make the runtime available." },
];

const RESULT_ITEMS = [
  "Chatbot URL (tenant-specific endpoint)",
  "Deployment status and timestamp",
  "GitHub Actions workflow link and run details",
  "Infrastructure summary (resources and key endpoints — see the Infrastructure tab)",
];

const NEXT_LINKS = [
  { icon: Cloud, label: "Cloud Prerequisites", href: "/guides/cloud-prerequisites" },
  { icon: Wrench, label: "Troubleshooting", href: undefined },
  { icon: ShieldAlert, label: "Security & Isolation", href: "/guides/security-isolation" },
  { icon: Rocket, label: "Getting Started", href: "/guides/getting-started" },
];

export default function DeploymentGuidePage() {
  return (
    <div className="max-w-7xl px-8 py-8">
      <GuideHeader
        current="Deployment Guide"
        icon={Box}
        tone="purple"
        title="Deployment Guide"
        subtitle="This guide describes how the AI Chatbot Deployment Platform provisions a tenant-specific chatbot in a client-owned AWS or Azure environment."
      />

      <div className="mt-6 flex items-start gap-3 rounded-lg border bg-blue-50/60 p-4">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
        <div>
          <div className="text-sm font-semibold text-gray-900">Deployment Scope</div>
          <p className="mt-1 text-xs leading-relaxed text-gray-600">
            Deployments are performed per chatbot (tenant). Infrastructure is provisioned in your own cloud
            account. The platform&apos;s control plane orchestrates the process but does not host or store your
            runtime data.
          </p>
        </div>
      </div>

      <div className="mt-8 space-y-6">
        <div className="rounded-lg border bg-white p-5">
          <SectionHeading n={1} title="Deployment Workflow" />
            <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
              {WORKFLOW_STEPS.map((step) => (
                <div key={step.title} className="text-center">
                  <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                    <step.icon className="h-5 w-5" />
                  </div>
                  <div className="mt-2 text-xs font-semibold text-gray-900">{step.title}</div>
                  <p className="mt-1 text-[11px] leading-snug text-gray-500">{step.detail}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <div className="rounded-lg border bg-white p-5 lg:col-span-2">
              <SectionHeading n={2} title="Deployment Statuses" />
              <div className="mt-4 space-y-2">
                {STATUSES.map((s) => (
                  <div key={s.label} className="flex items-center gap-3 rounded-lg border p-3">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${STATUS_TONES[s.tone]}`}>
                      <s.icon className={`h-4 w-4 ${s.spin ? "animate-spin" : ""}`} />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{s.label}</div>
                      <div className="text-xs text-gray-500">{s.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border bg-white p-5 lg:col-span-3">
              <SectionHeading n={3} title="What Happens During Deployment" />
              <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                {[...DURING_DEPLOYMENT_LEFT, ...DURING_DEPLOYMENT_RIGHT].map((item) => (
                  <div key={item.title} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                    <div>
                      <div className="text-sm font-medium text-gray-900">{item.title}</div>
                      <div className="text-xs text-gray-500">{item.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="rounded-lg border bg-white p-5">
            <SectionHeading n={4} title="Deployment Result" />
            <div className="mt-4 flex gap-3">
              <FileText className="h-5 w-5 shrink-0 text-indigo-600" />
              <div>
                <p className="text-xs text-gray-500">After a successful deployment, the operator receives:</p>
                <ul className="mt-2 space-y-1.5 text-xs text-gray-600">
                  {RESULT_ITEMS.map((item) => (
                    <li key={item} className="flex gap-1.5">
                      <span className="text-gray-300">•</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-white p-5">
            <SectionHeading n={5} title="Where to Go Next" />
            <div className="mt-4 grid grid-cols-1 gap-2">
              {NEXT_LINKS.map((link) =>
                link.href ? (
                  <Link
                    key={link.label}
                    href={link.href}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm text-gray-700 hover:border-blue-300 hover:bg-blue-50/50"
                  >
                    <span className="flex items-center gap-2">
                      <link.icon className="h-4 w-4 text-gray-400" />
                      {link.label}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-gray-400" />
                  </Link>
                ) : (
                  <div
                    key={link.label}
                    className="flex cursor-not-allowed items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm text-gray-300"
                  >
                    <span className="flex items-center gap-2">
                      <link.icon className="h-4 w-4 text-gray-300" />
                      {link.label}
                    </span>
                    <span className="text-[10px] text-gray-300">Soon</span>
                  </div>
                ),
              )}
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-lg border bg-white p-5">
              <div className="text-sm font-semibold text-gray-900">Supported Providers</div>
              <div className="mt-3 flex items-center gap-4">
                <span className="flex items-center gap-1.5 text-sm text-gray-700">
                  <CloudLogo provider="aws" className="h-5 w-auto" /> AWS
                </span>
                <span className="flex items-center gap-1.5 text-sm text-gray-700">
                  <CloudLogo provider="azure" className="h-5 w-auto" /> Azure
                </span>
              </div>
            </div>

            <div className="rounded-lg border bg-white p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <Database className="h-4 w-4 text-indigo-600" />
                Runtime Options
              </div>
              <p className="mt-2 text-xs leading-relaxed text-gray-500">
                Pinecone or pgvector, depending on tenant configuration.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
