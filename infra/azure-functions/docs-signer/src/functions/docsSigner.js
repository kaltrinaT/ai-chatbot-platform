import { app } from "@azure/functions";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

const STORAGE_ACCOUNT = process.env.DOCS_STORAGE_ACCOUNT;
const CONTAINER = process.env.DOCS_CONTAINER;
const DOCS_PREFIX = process.env.DOCS_PREFIX ?? "";
// Set directly as an app setting by Terraform (see main.tf) — unlike the
// Lambda, this Function never reads a secret store at runtime, and its
// identity has no Key Vault access at all.
const DOCS_SIGNER_SECRET = process.env.DOCS_SIGNER_SECRET ?? "";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);

// Content-types this knowledge base accepts. Kept identical to
// infra/lambda/docs-signer/index.mjs's ALLOWED_CONTENT_TYPES — there is no
// shared module between the two runtimes, so keep these two lists in sync
// by hand.
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

// DefaultAzureCredential picks up this Function App's system-assigned
// Managed Identity automatically when running in Azure — no key, no
// connection string, no client secret.
const credential = new DefaultAzureCredential();
const blobServiceClient = new BlobServiceClient(
  `https://${STORAGE_ACCOUNT}.blob.core.windows.net`,
  credential,
);

function sanitizeFileName(name) {
  const base = String(name ?? "document").split(/[/\\]/).pop() ?? "document";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "document";
}

function authorized(request) {
  const header = request.headers.get("x-docs-signer-secret") ?? "";
  const a = Buffer.from(header);
  const b = Buffer.from(DOCS_SIGNER_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

app.http("docsSigner", {
  methods: ["POST"],
  // Auth is entirely the shared-secret header checked below — mirrors the
  // Lambda Function URL's authorization_type = "NONE".
  authLevel: "anonymous",
  route: "docs-signer",
  handler: async (request) => {
    if (!authorized(request)) {
      return { status: 401, jsonBody: { error: "unauthorized" } };
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: "invalid json body" } };
    }

    if (payload.action === "presign-upload") {
      const { fileName, contentType, sizeBytes } = payload;

      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        return { status: 400, jsonBody: { error: `unsupported content type: ${contentType}` } };
      }
      if (typeof sizeBytes !== "number" || sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
        return {
          status: 400,
          jsonBody: { error: `file size must be between 1 and ${MAX_UPLOAD_BYTES} bytes` },
        };
      }

      const objectKey = `${DOCS_PREFIX}${randomUUID()}-${sanitizeFileName(fileName)}`;

      const now = new Date();
      const startsOn = new Date(now.valueOf() - 5 * 60 * 1000); // clock-skew buffer
      const expiresOn = new Date(now.valueOf() + 60 * 1000); // 60s, matches the Lambda's Expires: 60

      const userDelegationKey = await blobServiceClient.getUserDelegationKey(startsOn, expiresOn);

      const sas = generateBlobSASQueryParameters(
        {
          containerName: CONTAINER,
          blobName: objectKey,
          // create+write only — no read, no delete, no list on the token
          // itself. Delete happens separately, via this Function's own
          // identity, never via a SAS handed to the browser.
          permissions: BlobSASPermissions.parse("cw"),
          startsOn,
          expiresOn,
          contentType,
        },
        userDelegationKey,
        STORAGE_ACCOUNT,
      ).toString();

      const url = `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${CONTAINER}/${objectKey}?${sas}`;

      // No "fields" here — Azure Blob SAS is a single URL the browser PUTs
      // to directly, unlike S3's presigned-POST fields object.
      return { status: 200, jsonBody: { objectKey, url } };
    }

    if (payload.action === "delete") {
      const { objectKey } = payload;
      if (typeof objectKey !== "string" || !objectKey.startsWith(DOCS_PREFIX)) {
        return { status: 400, jsonBody: { error: "objectKey outside configured prefix" } };
      }

      const containerClient = blobServiceClient.getContainerClient(CONTAINER);
      await containerClient.getBlockBlobClient(objectKey).deleteIfExists();
      return { status: 200, jsonBody: { ok: true } };
    }

    return { status: 400, jsonBody: { error: `unknown action: ${payload.action}` } };
  },
});
