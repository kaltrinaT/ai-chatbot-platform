import { NextResponse } from "next/server";
import { releaseDeploymentSecrets, SecretsRequestError } from "@/lib/deploymentSecrets";

/**
 * An Azure deploy or teardown run fetches its tenant's application secrets
 * here, authenticating with its own GitHub OIDC token rather than any shared
 * secret. See src/lib/deploymentSecrets.ts for what the token has to prove.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    return NextResponse.json({ error: "A GitHub Actions OIDC bearer token is required." }, { status: 401 });
  }

  const { id } = await params;
  try {
    const secrets = await releaseDeploymentSecrets(id, match[1]);
    return NextResponse.json(secrets, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof SecretsRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
