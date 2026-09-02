import Link from "next/link";
import {
  Rocket,
  MessageSquare,
  SlidersHorizontal,
  Cloud,
  ExternalLink,
  ShieldCheck,
  Monitor,
  CloudUpload,
  Database,
  Lock,
} from "lucide-react";
import GuideHeader from "../GuideHeader";

const TOC = [
  { id: "overview", label: "Overview" },
  { id: "how-it-works", label: "How It Works" },
  { id: "what-you-need", label: "What You Need" },
  {
    id: "your-first-deployment",
    label: "Your First Deployment",
    children: [
      { id: "create-chatbot", label: "1. Create Chatbot" },
      { id: "configure", label: "2. Configure" },
      { id: "deploy", label: "3. Deploy" },
      { id: "access-chatbot", label: "4. Access Chatbot" },
    ],
  },
  { id: "next-steps", label: "Next Steps" },
];

const FLOW = [
  { icon: MessageSquare, tone: "bg-green-100 text-green-600", title: "Create", detail: "Create your chatbot and define basic settings." },
  {
    icon: SlidersHorizontal,
    tone: "bg-blue-100 text-blue-600",
    title: "Configure",
    detail: "Choose your cloud provider and configure deployment options.",
  },
  { icon: Cloud, tone: "bg-purple-100 text-purple-600", title: "Deploy", detail: "We deploy the chatbot to your cloud account." },
  {
    icon: ExternalLink,
    tone: "bg-amber-100 text-amber-600",
    title: "Access",
    detail: "Open your chatbot URL and start using it.",
  },
];

const HOW_IT_WORKS_SUMMARY = [
  {
    icon: Monitor,
    title: "1. You use the platform",
    detail: "From this platform you create and configure a chatbot for your own tenant.",
  },
  {
    icon: CloudUpload,
    title: "2. We deploy to your cloud",
    detail: "The platform provisions all required infrastructure in your own AWS or Azure account.",
  },
  {
    icon: Database,
    title: "3. Your data stays in your cloud",
    detail: "Documents, embeddings, and logs are stored in your own cloud environment, never the platform's.",
  },
  {
    icon: MessageSquare,
    title: "4. You access your chatbot",
    detail: "You get a URL to access your chatbot, hosted entirely in your own cloud account.",
  },
];

export default function GettingStartedPage() {
  return (
    <div className="max-w-7xl px-8 py-8">
      <GuideHeader
        current="Getting Started"
        icon={Rocket}
        tone="green"
        title="Getting Started"
        subtitle="Learn the basics of the platform and deploy your first AI chatbot in just a few simple steps."
      />

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[180px_1fr_280px]">
        <nav className="hidden lg:block">
          <div className="sticky top-8 space-y-1 text-sm">
            {TOC.map((item) => (
              <div key={item.id}>
                <a
                  href={`#${item.id}`}
                  className="block rounded-md px-3 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  {item.label}
                </a>
                {item.children && (
                  <div className="ml-3 space-y-0.5 border-l pl-3">
                    {item.children.map((child) => (
                      <a
                        key={child.id}
                        href={`#${child.id}`}
                        className="block rounded-md px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                      >
                        {child.label}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 space-y-10">
          <section id="overview">
            <h2 className="text-lg font-semibold text-gray-900">Overview</h2>
            <p className="mt-3 text-sm leading-relaxed text-gray-600">
              The AI Chatbot Platform lets you deploy a secure, isolated, and fully managed chatbot in your own
              cloud environment (AWS or Azure). You stay in control of your data, documents and infrastructure.
            </p>

            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {FLOW.map((step) => (
                <div key={step.title} className="text-center">
                  <div
                    className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${step.tone}`}
                  >
                    <step.icon className="h-6 w-6" />
                  </div>
                  <div className="mt-2 text-sm font-semibold text-gray-900">{step.title}</div>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">{step.detail}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
              <div>
                <div className="text-sm font-semibold text-green-900">You remain in control</div>
                <p className="mt-1 text-xs leading-relaxed text-green-800">
                  All resources, documents, and runtime components are deployed in your own cloud account. The
                  platform only helps you automate and monitor the deployment.
                </p>
              </div>
            </div>
          </section>

          <section id="how-it-works">
            <h2 className="text-lg font-semibold text-gray-900">How It Works</h2>
            <p className="mt-3 text-sm leading-relaxed text-gray-600">
              This platform is a control plane only: it deploys and monitors infrastructure, but never touches
              your chat traffic, documents, or logs. Everything that matters runs inside your own cloud account.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600">
              <li>
                You fill out a form describing your cloud account, LLM provider, and vector store — nothing is
                deployed until you submit it.
              </li>
              <li>
                The platform assumes a role you create in your own account (AWS) or a service principal you grant
                access to (Azure) — see the Cloud Prerequisites guide for exactly what to set up.
              </li>
              <li>Terraform provisions the chatbot&apos;s infrastructure directly inside your cloud account.</li>
              <li>
                The only thing that ever comes back to the platform is deployment status and the resulting
                chatbot URL.
              </li>
            </ul>
          </section>

          <section id="what-you-need">
            <h2 className="text-lg font-semibold text-gray-900">What You Need</h2>
            <ul className="mt-3 space-y-2 text-sm text-gray-600">
              <li>An AWS or Azure account with the required role/permissions already set up.</li>
              <li>An API key from your chosen LLM provider (OpenAI, Anthropic, or OpenRouter).</li>
              <li>
                A Pinecone API key, only if you choose Pinecone instead of pgvector as your vector store.
              </li>
            </ul>
            <p className="mt-3 text-sm text-gray-600">
              Full setup steps for each of these live in{" "}
              <Link href="/guides/cloud-prerequisites" className="text-blue-600 hover:underline">
                Cloud Prerequisites
              </Link>
              .
            </p>
          </section>

          <section id="your-first-deployment">
            <h2 className="text-lg font-semibold text-gray-900">Your First Deployment</h2>

            <div id="create-chatbot" className="mt-4 scroll-mt-8">
              <h3 className="text-sm font-semibold text-gray-900">1. Create Chatbot</h3>
              <p className="mt-1 text-sm text-gray-600">
                From the Chatbots page, start a new tenant. Give it a name and a slug — the slug can&apos;t be
                changed later, so pick something short and lowercase.
              </p>
            </div>

            <div id="configure" className="mt-4 scroll-mt-8">
              <h3 className="text-sm font-semibold text-gray-900">2. Configure</h3>
              <p className="mt-1 text-sm text-gray-600">
                Pick your cloud provider and paste in your account details, choose an LLM provider and paste in
                its API key, and choose pgvector or Pinecone as your vector store.
              </p>
            </div>

            <div id="deploy" className="mt-4 scroll-mt-8">
              <h3 className="text-sm font-semibold text-gray-900">3. Deploy</h3>
              <p className="mt-1 text-sm text-gray-600">
                Submitting the form triggers a deployment right away. You can watch its progress on the tenant
                page — it assumes your role, writes your keys into your own account&apos;s secret store, then
                provisions everything.
              </p>
            </div>

            <div id="access-chatbot" className="mt-4 scroll-mt-8">
              <h3 className="text-sm font-semibold text-gray-900">4. Access Chatbot</h3>
              <p className="mt-1 text-sm text-gray-600">
                Once the deployment succeeds, the tenant page shows your chatbot&apos;s URL. AWS tenants get an
                HTTP-only URL (no HTTPS yet); Azure tenants get a managed HTTPS URL automatically.
              </p>
            </div>
          </section>

          <section id="next-steps">
            <h2 className="text-lg font-semibold text-gray-900">Next Steps</h2>
            <ul className="mt-3 space-y-2 text-sm text-gray-600">
              <li>Upload your knowledge-base documents from the tenant&apos;s Documents tab (AWS tenants only, for now).</li>
              <li>Check the tenant page&apos;s Infrastructure tab to see what was provisioned in your account.</li>
              <li>Review the estimated monthly cost breakdown for your configuration.</li>
              <li>
                Read{" "}
                <Link href="/guides/secure-document-handling-rag" className="text-blue-600 hover:underline">
                  Secure Document Handling &amp; RAG
                </Link>{" "}
                to understand how your documents stay private.
              </li>
            </ul>
          </section>
        </div>

        <aside className="hidden lg:block">
          <div className="sticky top-8 rounded-lg border border-indigo-100 bg-indigo-50/50 p-5">
            <div className="text-sm font-semibold text-indigo-700">How It Works</div>
            <ol className="relative mt-4 space-y-5">
              {HOW_IT_WORKS_SUMMARY.map((step, i) => (
                <li key={step.title} className="relative flex gap-3">
                  {i < HOW_IT_WORKS_SUMMARY.length - 1 && (
                    <span aria-hidden className="absolute left-4 top-9 h-[calc(100%-0.5rem)] w-px border-l border-dashed border-indigo-200" />
                  )}
                  <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-indigo-600 shadow-sm">
                    <step.icon className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-xs font-semibold text-gray-900">{step.title}</div>
                    <p className="mt-0.5 text-xs leading-relaxed text-gray-600">{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-5 flex items-start gap-2 border-t border-indigo-100 pt-4">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
              <div>
                <div className="text-xs font-semibold text-gray-900">Fully isolated per tenant</div>
                <p className="mt-0.5 text-xs leading-relaxed text-gray-600">
                  Each deployment is isolated and cannot access any other tenant&apos;s resources or data.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
