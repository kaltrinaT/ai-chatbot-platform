import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import TenantForm from "./TenantForm";

export default async function NewTenantPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/" className="text-sm text-gray-500 hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">Deploy new tenant</h1>
      <p className="mt-1 text-sm text-gray-500">
        Provisions the chatbot stack into the customer&apos;s AWS account. The
        customer must have already created a deployment role that trusts this
        platform.
      </p>
      <TenantForm />
    </main>
  );
}
