/**
 * The Terraform init scripts, run for real against stand-ins for `aws`, `az`
 * and `terraform`.
 *
 * This is where a tenant's state moves out of the platform's bucket and into
 * the customer's own cloud, and the one mistake either script must never make
 * is starting Terraform from empty state for a tenant whose infrastructure
 * exists: a deploy would then create everything a second time, and a
 * teardown would report success while deleting nothing. The workflows cannot
 * run in a test, but the scripts can. Each case below scripts what the cloud
 * answers, then checks what the script does with it.
 *
 * Needs bash and jq, as the workflow runners have. Skipped where either is
 * missing rather than failing on a machine that could never run the scripts.
 */
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const TOOLS_AVAILABLE =
  spawnSync("bash", ["-c", "command -v jq >/dev/null"], { stdio: "ignore" }).status === 0;

// Each case starts several real processes, which is slow on Windows and
// slower still while the rest of the suite runs in parallel. The default five
// seconds made the longest cases fail on timing alone.
vi.setConfig({ testTimeout: 30_000 });

const posix = (p: string) => p.replace(/\\/g, "/");
const scriptPath = (name: string) => posix(join(process.cwd(), ".github/scripts", name));

const PLATFORM_BUCKET = "platform-state";

/** Reads a flag's value from a stub's arguments. */
const ARG_HELPER = `arg() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }`;

const HEAD_OBJECT_ANSWER = `
    case "$answer" in
      present) exit 0 ;;
      absent) echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254 ;;
      *) echo "An error occurred (403) when calling the HeadObject operation: Forbidden" >&2; exit 254 ;;
    esac`;

const TERRAFORM_STUB = `#!/usr/bin/env bash
echo "terraform $*" >> "$STUB_LOG"
`;

type Answer = "present" | "absent" | "forbidden";

function state(lineage: string, resources: number): string {
  return JSON.stringify({ version: 4, lineage, serial: 7, resources: Array.from({ length: resources }, () => ({})) });
}

/**
 * Runs one script with the given stand-ins first on PATH. STUB_LEGACY_STATE
 * holds the platform's copy of the state; STUB_CURRENT_STATE is what reading
 * it back from the customer's cloud returns — the same by default.
 */
function runWithStubs(script: string, stubs: Record<string, string>, env: Record<string, string>, copied?: string) {
  const dir = mkdtempSync(join(tmpdir(), "tfinit-"));
  try {
    for (const [name, body] of Object.entries({ ...stubs, terraform: TERRAFORM_STUB })) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
    const legacyState = join(dir, "legacy.json");
    const currentState = join(dir, "current.json");
    const log = join(dir, "calls.log");
    writeFileSync(legacyState, state("lineage-1", 3));
    writeFileSync(currentState, copied ?? state("lineage-1", 3));
    writeFileSync(log, "");

    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const result = spawnSync("bash", [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ""}`,
        STUB_LOG: posix(log),
        STUB_LEGACY_STATE: posix(legacyState),
        STUB_CURRENT_STATE: posix(currentState),
        LEGACY_STATE_REGION: "us-east-1",
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

const NEW_BUCKET = "tfstate-acme-111122223333-eu-central-1-an";

const AWS_STUB = `#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
${ARG_HELPER}
case "$1 $2" in
  "s3api head-bucket")
    [ "$STUB_BUCKET" = exists ] && exit 0
    echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254 ;;
  "s3api head-object")
    if [ "$(arg --bucket "$@")" = "$LEGACY_STATE_BUCKET" ]; then answer="$STUB_LEGACY"; else answer="$STUB_CURRENT"; fi
    ${HEAD_OBJECT_ANSWER} ;;
  "s3 cp")
    case "$3" in
      "s3://$LEGACY_STATE_BUCKET/"*) cat "$STUB_LEGACY_STATE" ;;
      *) cat "$STUB_CURRENT_STATE" ;;
    esac ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

function runAws(opts: { bucket?: "exists" | "missing"; current: Answer; legacy: Answer; copied?: string; legacyBucket?: string }) {
  return runWithStubs(
    scriptPath("terraform-init-aws.sh"),
    { aws: AWS_STUB },
    {
      STUB_BUCKET: opts.bucket ?? "exists",
      STUB_CURRENT: opts.current,
      STUB_LEGACY: opts.legacy,
      TENANT_SLUG: "acme",
      AWS_ACCOUNT_ID: "111122223333",
      TENANT_REGION: "eu-central-1",
      LEGACY_STATE_BUCKET: opts.legacyBucket ?? PLATFORM_BUCKET,
    },
    opts.copied,
  );
}

describe.skipIf(!TOOLS_AVAILABLE)("terraform-init-aws.sh", () => {
  it("stops before touching Terraform when the tenant's state bucket is missing", () => {
    const run = runAws({ bucket: "missing", current: "absent", legacy: "absent" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Terraform state bucket missing/);
    expect(run.output).toMatch(/update an existing stack/);
    expect(run.inits).toEqual([]);
  });

  it("moves an existing tenant's state into the customer's bucket, and checks the copy", () => {
    const run = runAws({ current: "absent", legacy: "present" });

    expect(run.status).toBe(0);
    expect(run.output).toMatch(/Moving Terraform state into the customer's account/);
    expect(run.inits).toHaveLength(2);
    expect(run.inits[0]).toContain(`bucket=${PLATFORM_BUCKET}`);
    expect(run.inits[0]).toContain("key=tenants/acme.tfstate");
    expect(run.inits[1]).toContain(`bucket=${NEW_BUCKET}`);
    expect(run.inits[1]).toContain("use_lockfile=true");
    expect(run.inits[1]).toContain("-migrate-state");
    expect(run.inits[1]).toContain("-force-copy");
  });

  it("refuses to continue when the copy is not the same state", () => {
    const run = runAws({ current: "absent", legacy: "present", copied: state("lineage-1", 0) });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/did not copy intact/);
  });

  it("uses the customer's bucket, locked, once the state has moved", () => {
    const run = runAws({ current: "present", legacy: "absent" });

    expect(run.status).toBe(0);
    expect(run.inits).toHaveLength(1);
    expect(run.inits[0]).toContain(`bucket=${NEW_BUCKET}`);
    expect(run.inits[0]).toContain("use_lockfile=true");
    expect(run.inits[0]).not.toContain("-migrate-state");
  });

  it("warns about a superseded copy left in the platform bucket", () => {
    const run = runAws({ current: "present", legacy: "present" });

    expect(run.status).toBe(0);
    expect(run.output).toMatch(/Old Terraform state still in the platform bucket/);
    expect(run.inits).toHaveLength(1);
    expect(run.inits[0]).toContain(`bucket=${NEW_BUCKET}`);
  });

  it("starts from empty state only for a tenant with no state anywhere", () => {
    const run = runAws({ current: "absent", legacy: "absent" });

    expect(run.status).toBe(0);
    expect(run.inits).toHaveLength(1);
    expect(run.inits[0]).toContain(`bucket=${NEW_BUCKET}`);
  });

  // The failure that would do the damage: an unreadable answer taken to mean
  // "no state", after which Terraform would start from nothing.
  it("never reads a permission error in the customer's bucket as 'no state'", () => {
    const run = runAws({ current: "forbidden", legacy: "absent" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Could not tell whether Terraform state exists/);
    expect(run.inits).toEqual([]);
  });

  it("never reads a permission error in the platform bucket as 'nothing to move'", () => {
    const run = runAws({ current: "absent", legacy: "forbidden" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Could not tell whether Terraform state exists/);
    expect(run.inits).toEqual([]);
  });

  // Once every tenant has moved, the operator unsets the legacy bucket and
  // the platform's bucket is no longer consulted at all.
  it("does not look in the platform bucket once it is no longer configured", () => {
    const run = runAws({ current: "absent", legacy: "present", legacyBucket: "" });

    expect(run.status).toBe(0);
    expect(run.calls.some((c) => c.includes(PLATFORM_BUCKET))).toBe(false);
    expect(run.inits).toHaveLength(1);
  });
});

// ── Azure ─────────────────────────────────────────────────────────────────

const AZ_STUB = `#!/usr/bin/env bash
echo "az $*" >> "$STUB_LOG"
${ARG_HELPER}
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
  "storage blob exists")
    case "$STUB_CURRENT" in
      present) echo true ;;
      absent) echo false ;;
      *) echo "ERROR: (AuthorizationPermissionMismatch) This request is not authorized to perform this operation using this permission." >&2; exit 1 ;;
    esac ;;
  "storage blob upload") exit 0 ;;
  "storage blob download") cp "$STUB_CURRENT_STATE" "$(arg --file "$@")" ;;
  *) echo "unexpected az call: $*" >&2; exit 99 ;;
esac
`;

// Only the platform's old bucket is on AWS now.
const AZURE_AWS_STUB = `#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
case "$1 $2" in
  "s3api head-object")
    answer="$STUB_LEGACY"
    ${HEAD_OBJECT_ANSWER} ;;
  "s3 cp") cp "$STUB_LEGACY_STATE" "$4" ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

function runAzure(opts: {
  account?: "exists" | "missing";
  container?: "exists" | "missing" | "forbidden";
  current: Answer;
  legacy: Answer;
  copied?: string;
  legacyBucket?: string;
}) {
  return runWithStubs(
    scriptPath("terraform-init-azure.sh"),
    { az: AZ_STUB, aws: AZURE_AWS_STUB },
    {
      STUB_ACCOUNT: opts.account ?? "exists",
      STUB_CONTAINER: opts.container ?? "exists",
      STUB_CURRENT: opts.current,
      STUB_LEGACY: opts.legacy,
      TENANT_SLUG: "acme-corp",
      AZURE_SUBSCRIPTION_ID: "22222222-2222-2222-2222-222222222222",
      AZURE_TENANT_ID: "33333333-3333-3333-3333-333333333333",
      AZURE_CLIENT_ID: "44444444-4444-4444-4444-444444444444",
      LEGACY_STATE_BUCKET: opts.legacyBucket ?? PLATFORM_BUCKET,
    },
    opts.copied,
  );
}

describe.skipIf(!TOOLS_AVAILABLE)("terraform-init-azure.sh", () => {
  it("stops before touching Terraform when the state account is not in the tenant's resource group", () => {
    const run = runAzure({ account: "missing", current: "absent", legacy: "absent" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Terraform state storage account missing/);
    expect(run.output).toMatch(/run the bootstrap again/);
    expect(run.inits).toEqual([]);
  });

  it("stops when the state container is missing", () => {
    const run = runAzure({ container: "missing", current: "absent", legacy: "absent" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Terraform state container missing/);
    expect(run.inits).toEqual([]);
  });

  it("moves an existing tenant's state into the customer's subscription, and checks the copy", () => {
    const run = runAzure({ current: "absent", legacy: "present" });

    expect(run.status).toBe(0);
    expect(run.output).toMatch(/Moving Terraform state into the customer's subscription/);
    expect(run.calls.some((c) => c.startsWith("az storage blob upload"))).toBe(true);
    expect(run.inits).toHaveLength(1);
    expect(run.inits[0]).toContain("storage_account_name=cbtfacmecorp");
    expect(run.inits[0]).toContain("container_name=tfstate");
    expect(run.inits[0]).toContain("use_azuread_auth=true");
    expect(run.inits[0]).toContain("use_oidc=true");
  });

  it("refuses to continue when the copy is not the same state", () => {
    const run = runAzure({ current: "absent", legacy: "present", copied: state("lineage-2", 3) });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/did not copy intact/);
    expect(run.inits).toEqual([]);
  });

  it("uses the customer's storage once the state has moved", () => {
    const run = runAzure({ current: "present", legacy: "absent" });

    expect(run.status).toBe(0);
    expect(run.calls.some((c) => c.startsWith("az storage blob upload"))).toBe(false);
    expect(run.inits).toHaveLength(1);
  });

  it("warns about a superseded copy left in the platform bucket", () => {
    const run = runAzure({ current: "present", legacy: "present" });

    expect(run.status).toBe(0);
    expect(run.output).toMatch(/Old Terraform state still in the platform bucket/);
    expect(run.inits).toHaveLength(1);
  });

  it("starts from empty state only for a tenant with no state anywhere", () => {
    const run = runAzure({ current: "absent", legacy: "absent" });

    expect(run.status).toBe(0);
    expect(run.inits).toHaveLength(1);
  });

  // A failure inside `$(...)` exits only its subshell. Used directly in a
  // test, the empty answer read as "no" — this case caught exactly that.
  it("never reads a permission error on the container as an answer", () => {
    const run = runAzure({ container: "forbidden", current: "absent", legacy: "absent" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Could not tell whether the state container exists/);
    expect(run.inits).toEqual([]);
  });

  it("never reads a missing data role on the state as 'no state'", () => {
    const run = runAzure({ current: "forbidden", legacy: "absent" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Could not tell whether Terraform state exists/);
    expect(run.inits).toEqual([]);
  });

  it("never reads a permission error in the platform bucket as 'nothing to move'", () => {
    const run = runAzure({ current: "absent", legacy: "forbidden" });

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Could not tell whether Terraform state exists/);
    expect(run.inits).toEqual([]);
  });

  it("does not look in the platform bucket once it is no longer configured", () => {
    const run = runAzure({ current: "absent", legacy: "present", legacyBucket: "" });

    expect(run.status).toBe(0);
    expect(run.calls.some((c) => c.startsWith("aws "))).toBe(false);
    expect(run.inits).toHaveLength(1);
  });
});
