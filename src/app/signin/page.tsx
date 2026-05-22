import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold">AI Chatbot Platform</h1>
        <p className="mt-1 text-sm text-gray-500">
          Sign in to deploy chatbot stacks into customer cloud accounts.
        </p>
        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Continue with GitHub
          </button>
        </form>
      </div>
    </main>
  );
}
