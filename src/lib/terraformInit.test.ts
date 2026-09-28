/**
 * The Terraform init scripts, run for real against stand-ins for `aws`, `az`
 * and `terraform`.
 *
 * They decide where a tenant's state is read from and written to, which is
 * always the customer's own cloud. What they must never do is let Terraform
 * start when the place they are pointing at is missing or unreadable: a deploy
 * would then create everything a second time, and a teardown would report
 * success while deleting nothing. The workflows cannot run in a test, but the
 * scripts can. Each case below scripts what the cloud answers, then checks
 * what the script does with it.
 *
 * Needs bash, as the workflow runners have. Skipped where it is missing rather
 * than failing on a machine that could never run the scripts.
 */
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const BASH_AVAILABLE = spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

// Each case starts several real processes, which is slow on Windows and
// slower still while the rest of the suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

const posix = (p: string) => p.replace(/\\/g, "/");
const scriptPath = (name: string) => posix(join(process.cwd(), ".github/scripts", name));

const TERRAFORM_STUB = `#!/usr/bin/env bash
echo "terraform $*" >> "$STUB_LOG"
`;

/** Runs one script with the given stand-ins first on PATH. */
function runWithStubs(script: string, stubs: Record<string, string>, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "tfinit-"));
  try {
    for (const [name, body] of Object.entries({ ...stubs, terraform: TERRAFORM_STUB })) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
    const log = join(dir, "calls.log");
    writeFileSync(log, "");

    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const result = spawnSync("bash", [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ""}`,
        STUB_LOG: posix(log),
        ...env,
      },
    });
    const calls = readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls,
      inits: calls.filter((c) => c.startsWith("terraform init")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── AWS ───────────────────────────────────────────────────────────────────

const AWS_BUCKET = "tfstate-acme-111122223333-eu-central-1-an";

const AWS_STUB = `#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
case "$1 $2" in
  "s3api head-bucket")
    case "$STUB_BUCKET" in
      exists) exit 0 ;;
      other-owner) echo "An error occurred (403) when calling the HeadBucket operation: Forbidden" >&2; exit 254 ;;
      *) echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254 ;;
    esac ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

function runAws(bucket: "exists" | "missing" | "other-owner") {
  return runWithStubs(scriptPath("terraform-init-aws.sh"), { aws: AWS_STUB }, {
    STUB_BUCKET: bucket,
    TENANT_SLUG: "acme",
    AWS_ACCOUNT_ID: "111122223333",
    TENANT_REGION: "eu-central-1",
  });
}

describe.skipIf(!BASH_AVAILABLE)("terraform-init-aws.sh", () => {
  it("stops before touching Terraform when the tenant's state bucket is missing", () => {
    const run = runAws("missing");

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Terraform state bucket missing/);
    expect(run.output).toMatch(/update an existing stack/);
    expect(run.inits).toEqual([]);
  });

  // --expected-bucket-owner turns a same-named bucket in another account into
  // a refusal, not a place to write this tenant's state.
  it("stops when the bucket belongs to another account", () => {
    const run = runAws("other-owner");

    expect(run.status).toBe(1);
    expect(run.calls[0]).toContain("--expected-bucket-owner 111122223333");
    expect(run.inits).toEqual([]);
  });

  it("initialises once, against the customer's bucket, locked", () => {
    const run = runAws("exists");

    expect(run.status).toBe(0);
    expect(run.inits).toHaveLength(1);
    expect(run.inits[0]).toContain(`bucket=${AWS_BUCKET}`);
    expect(run.inits[0]).toContain("key=terraform.tfstate");
    expect(run.inits[0]).toContain("use_lockfile=true");
    expect(run.inits[0]).not.toContain("-migrate-state");
  });
});

// ── Azure ─────────────────────────────────────────────────────────────────

const AZ_STUB = `#!/usr/bin/env bash
echo "az $*" >> "$STUB_LOG"
case "$1 $2 $3" in
  "storage account show")
    [ "$STUB_ACCOUNT" = exists ] && exit 0
    echo "ERROR: (ResourceNotFound) The Resource was not found." >&2; exit 3 ;;
  "storage container exists")
    case "$STUB_CONTAINER" in
      exists) echo true ;;
      missing) echo false ;;
      *) echo "ERROR: (AuthorizationFailure) This request is not authorized to perform this operation." >&2; exit 1 ;;
    esac ;;
  *) echo "unexpected az call: $*" >&2; exit 99 ;;
esac
`;

// Any call into the platform's own AWS account is a regression.
const NO_AWS_STUB = `#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
exit 99
`;

function runAzure(opts: { account?: "exists" | "missing"; container?: "exists" | "missing" | "forbidden" }) {
  return runWithStubs(scriptPath("terraform-init-azure.sh"), { az: AZ_STUB, aws: NO_AWS_STUB }, {
    STUB_ACCOUNT: opts.account ?? "exists",
    STUB_CONTAINER: opts.container ?? "exists",
    TENANT_SLUG: "acme-corp",
    AZURE_SUBSCRIPTION_ID: "22222222-2222-2222-2222-222222222222",
    AZURE_TENANT_ID: "33333333-3333-3333-3333-333333333333",
    AZURE_CLIENT_ID: "44444444-4444-4444-4444-444444444444",
  });
}

describe.skipIf(!BASH_AVAILABLE)("terraform-init-azure.sh", () => {
  it("stops before touching Terraform when the state account is not in the tenant's resource group", () => {
    const run = runAzure({ account: "missing" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Terraform state storage account missing/);
    expect(run.output).toMatch(/run the bootstrap again/);
    expect(run.inits).toEqual([]);
  });

  it("stops when the state container is missing", () => {
    const run = runAzure({ container: "missing" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Terraform state container missing/);
    expect(run.inits).toEqual([]);
  });

  // A failure inside `$(...)` exits only its subshell. Used directly in a
  // test, the empty answer read as "no" — this case caught exactly that.
  it("never reads a permission error on the container as an answer", () => {
    const run = runAzure({ container: "forbidden" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Could not tell whether the state container exists/);
    expect(run.inits).toEqual([]);
  });

  it("initialises once, against the customer's storage, through Entra ID", () => {
    const run = runAzure({});

    expect(run.status).toBe(0);
    expect(run.inits).toHaveLength(1);
    expect(run.inits[0]).toContain("storage_account_name=cbtfacmecorp");
    expect(run.inits[0]).toContain("container_name=tfstate");
    expect(run.inits[0]).toContain("use_azuread_auth=true");
    expect(run.inits[0]).toContain("use_oidc=true");
    expect(run.calls.some((c) => c.startsWith("aws "))).toBe(false);
  });
});
