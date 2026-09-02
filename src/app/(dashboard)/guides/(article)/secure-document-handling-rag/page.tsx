import { ShieldCheck, Monitor, HardDrive, Server, Database, Bot, ArrowRight, X, ShieldOff, Users, Cloud } from "lucide-react";
import GuideHeader from "../GuideHeader";
import SectionHeading from "../SectionHeading";

const SECTIONS = [
  { n: 1, title: "Overview" },
  { n: 2, title: "Secure Flow" },
  { n: 3, title: "Security Principles" },
  { n: 4, title: "What the platform may display" },
];

const FLOW_STEPS = [
  "Open the tenant's Documents tab (AWS tenants only — Azure document upload isn't wired up yet).",
  "Pick a file. The platform requests a presigned upload URL from that tenant's own docs-signer Lambda, which runs inside the tenant's own AWS account, not the platform's.",
  "The browser uploads the file bytes directly to the tenant's S3 bucket using that presigned URL — bytes never pass through the platform's server.",
  "The browser confirms the upload, which flips the document's status and triggers the tenant's own chatbot backend to re-index.",
  "The chatbot backend chunks, embeds, and stores the document in the tenant's own vector store (pgvector, or the customer's own Pinecone project).",
  "At question-answering time, the chatbot retrieves the most relevant chunks and sends them as context to the configured LLM provider.",
];

const PRINCIPLES = [
  {
    icon: ShieldOff,
    title: "No control-plane document proxying",
    detail:
      "File bytes flow directly between the browser and the tenant's own storage via a presigned URL — the platform's server never receives or forwards document content.",
  },
  {
    icon: X,
    title: "No document preview or download in the platform UI",
    detail:
      "The platform never calls S3's GetObject or ListBucket for a tenant's documents — it can't display, preview, or download contents even if it wanted to.",
  },
  {
    icon: Users,
    title: "Tenant-scoped indexing and retrieval",
    detail:
      "Indexing and retrieval run inside that tenant's own chatbot runtime, scoped to that tenant's own vector store — nothing is pooled or shared across tenants.",
  },
  {
    icon: Cloud,
    title: "Your configured providers do process content",
    detail:
      "The LLM provider you configured — and Pinecone, if you chose it over pgvector — does receive document chunks and prompts to generate answers. That's inherent to RAG, and scoped only to the providers you configured for that tenant.",
  },
];

export default function SecureDocumentHandlingPage() {
  return (
    <div className="max-w-6xl px-8 py-8">
      <GuideHeader
        current="Secure Document Handling & RAG"
        icon={ShieldCheck}
        tone="amber"
        title="Secure Document Handling & RAG"
        subtitle="How tenant documents are handled securely without exposing document content to the control plane."
      />

      <div className="mt-6 flex flex-wrap gap-4 border-t border-b py-3 text-xs text-gray-500">
        {SECTIONS.map((s) => (
          <span key={s.n} className="flex items-center gap-1.5">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700">
              {s.n}
            </span>
            {s.title}
          </span>
        ))}
      </div>

      <div className="mt-8 space-y-10">
        <section>
          <SectionHeading n={1} title="Overview" size="base" />
          <p className="mt-3 text-sm leading-relaxed text-gray-600">
            Documents belong to a specific chatbot (tenant) and are processed exclusively within that tenant&apos;s
            own cloud account — the client-controlled data plane. The control plane (this platform) provides
            deployment guidance and status visibility only, and never accesses, stores, or displays document
            contents.
          </p>
        </section>

        <section>
          <SectionHeading n={2} title="Secure Flow" size="base" />
          <ol className="mt-4 space-y-3">
            {FLOW_STEPS.map((step, i) => (
              <li key={step} className="flex gap-3 text-sm">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-blue-200 text-[11px] font-semibold text-blue-700">
                  {i + 1}
                </span>
                <span className="text-gray-600">{step}</span>
              </li>
            ))}
          </ol>

          <div className="mt-6 rounded-lg border">
            <div className="rounded-t-lg border-b bg-blue-50/50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">
                Tenant (Client) Data Plane
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2 sm:gap-1">
                <FlowNode icon={Monitor} label="Browser" />
                <FlowArrow />
                <FlowNode icon={HardDrive} label="Client S3 (AWS only)" />
                <FlowArrow />
                <FlowNode icon={Server} label="Tenant Runtime" />
                <FlowArrow />
                <FlowNode icon={Database} label="pgvector or Client-owned Pinecone" />
                <FlowArrow />
                <FlowNode icon={Bot} label="LLM Provider" />
              </div>
            </div>
            <div className="rounded-b-lg bg-red-50/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-red-700">
                Control Plane (AI Chatbot Deployment Platform)
              </div>
              <div className="mt-2 flex items-start gap-2 text-sm">
                <X className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <div>
                  <span className="font-medium text-gray-900">No document content access.</span>{" "}
                  <span className="text-gray-600">
                    The control plane only ever sees deployment lifecycle data and document metadata (name, size,
                    status) — never file contents.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section>
          <SectionHeading n={3} title="Security Principles" size="base" />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="rounded-lg border p-4">
                <p.icon className="h-5 w-5 text-blue-600" />
                <div className="mt-2 text-sm font-semibold text-gray-900">{p.title}</div>
                <div className="mt-1 text-xs leading-relaxed text-gray-500">{p.detail}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHeading n={4} title="What the platform may display" size="base" />
          <p className="mt-2 text-sm text-gray-500">
            The platform shows only the metadata it stores for operational visibility — no document contents.
          </p>
          <div className="mt-4 overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-xs text-gray-500">
                  <th className="px-4 py-2 font-medium">Document Name</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Uploaded</th>
                  <th className="px-4 py-2 font-medium">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr>
                  <td className="px-4 py-2.5 text-gray-600">employee_handbook.pdf</td>
                  <td className="px-4 py-2.5 text-gray-600">PDF</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                      Uploaded
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500">2 days ago</td>
                  <td className="px-4 py-2.5 text-gray-500">1.2 MB</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-500">(Example row — for illustration only.)</p>
          <p className="mt-4 text-xs leading-relaxed text-gray-500">
            Two limitations worth knowing: reindexing after an upload or delete is a full resync — it re-embeds
            every document under the tenant&apos;s prefix, not just the one that changed — and deleting a document
            removes it from storage and from this list, but its already-generated vectors aren&apos;t purged from
            the vector store until something else cleans them up.
          </p>
        </section>
      </div>
    </div>
  );
}

function FlowNode({ icon: Icon, label }: { icon: typeof Monitor; label: string }) {
  return (
    <div className="flex w-24 flex-col items-center gap-1.5 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-blue-200 bg-white text-blue-600">
        <Icon className="h-5 w-5" />
      </div>
      <span className="text-[11px] leading-tight text-gray-600">{label}</span>
    </div>
  );
}

function FlowArrow() {
  return <ArrowRight className="mb-5 h-4 w-4 shrink-0 text-gray-300" />;
}
