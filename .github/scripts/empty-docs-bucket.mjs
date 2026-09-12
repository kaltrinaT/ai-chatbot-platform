#!/usr/bin/env node
/**
 * Empties a tenant's docs bucket completely, so `terraform destroy` can delete
 * it. Run by .github/workflows/destroy-tenant.yml immediately before Terraform.
 *
 * Why this exists: force_destroy on aws_s3_bucket.docs is documented as the
 * backstop that stops a destroy stalling on a non-empty bucket, but it does not
 * cover a bucket whose versioning was enabled outside Terraform. Noncurrent
 * versions and delete markers survive, and DeleteBucket then fails with
 * "BucketNotEmpty: You must delete all versions in the bucket". That stranded
 * chatbot-tenat1012-docs, which had to be purged by hand. Versioning is now
 * declared deliberately (aws_s3_bucket_versioning.docs), so every tenant has
 * noncurrent versions to clear rather than only the ones that had drifted —
 * which makes this script load-bearing on every teardown, not a backstop.
 *
 * Shells out to the AWS CLI rather than using an SDK: the CLI is present on the
 * runner and already holds the assumed tenant-role credentials from the
 * configure-aws-credentials step, and this script has no package.json to
 * install from.
 *
 * Best-effort by design. A tenant whose deploy never created the bucket must
 * still be destroyable, so a missing bucket is success.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUCKET = process.env.BUCKET;
if (!BUCKET) {
  console.error("BUCKET is not set.");
  process.exit(1);
}

// list-object-versions pages at 1000 and delete-objects accepts 1000 per call,
// so one cycle clears at most 1000. The cap only exists to bound a pathological
// loop; a tenant bucket holding 100k versions is not a thing this platform
// creates.
const MAX_PASSES = 100;

// Outside the checkout on purpose: the runner's working directory is the repo,
// and a batch file dropped there shows up as an untracked change.
const BATCH_FILE = join(tmpdir(), "s3-delete-batch.json");

/** Runs an AWS CLI command. Returns parsed JSON, or null if the call failed. */
function aws(args, { quiet = false } = {}) {
  const res = spawnSync("aws", [...args, "--output", "json"], { encoding: "utf8" });
  if (res.status !== 0) {
    if (!quiet) console.log(`  aws ${args.slice(0, 2).join(" ")} failed: ${(res.stderr ?? "").trim()}`);
    return null;
  }
  const out = (res.stdout ?? "").trim();
  return out ? JSON.parse(out) : {};
}

if (aws(["s3api", "head-bucket", "--bucket", BUCKET], { quiet: true }) === null) {
  console.log(`Bucket ${BUCKET} does not exist or is unreachable; nothing to empty.`);
  process.exit(0);
}

let removed = 0;
for (let pass = 0; pass < MAX_PASSES; pass++) {
  const listing = aws(["s3api", "list-object-versions", "--bucket", BUCKET, "--max-keys", "1000"]);
  if (listing === null) break;

  // Delete markers count as content just as objects do: DeleteBucket refuses
  // while either remains.
  const items = [...(listing.Versions ?? []), ...(listing.DeleteMarkers ?? [])].map((e) => ({
    Key: e.Key,
    VersionId: e.VersionId,
  }));
  if (items.length === 0) break;

  writeFileSync(BATCH_FILE, JSON.stringify({ Objects: items, Quiet: true }));
  if (aws(["s3api", "delete-objects", "--bucket", BUCKET, "--delete", `file://${BATCH_FILE}`]) === null) {
    break;
  }
  removed += items.length;
  console.log(`  removed ${items.length} version(s)/marker(s)`);
}

// An incomplete multipart upload also keeps a bucket non-empty while being
// invisible to an object listing.
const uploads = aws(["s3api", "list-multipart-uploads", "--bucket", BUCKET], { quiet: true }) ?? {};
for (const u of uploads.Uploads ?? []) {
  aws(
    ["s3api", "abort-multipart-upload", "--bucket", BUCKET, "--key", u.Key, "--upload-id", u.UploadId],
    { quiet: true },
  );
  console.log(`  aborted multipart upload for ${u.Key}`);
}

console.log(`${BUCKET}: removed ${removed} version(s)/marker(s) in total.`);
