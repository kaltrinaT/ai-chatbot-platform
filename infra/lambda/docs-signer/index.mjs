import { randomUUID, timingSafeEqual } from "node:crypto";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const DOCS_BUCKET = process.env.DOCS_BUCKET;
const DOCS_PREFIX = process.env.DOCS_PREFIX ?? "";
const DOCS_SIGNER_SECRET_ARN = process.env.DOCS_SIGNER_SECRET_ARN;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);

// Content-types this knowledge base accepts. Enforced both here (early
// rejection) and as an S3 presigned-POST policy condition (the real
// enforcement point — this Lambda's IAM role has no way to bypass it).
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const s3 = new S3Client({});
const secretsManager = new SecretsManagerClient({});

// Cached across warm invocations in the same execution environment so every
// request doesn't re-fetch the secret.
let cachedSecret;
async function getSharedSecret() {
  if (cachedSecret) return cachedSecret;
  const res = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: DOCS_SIGNER_SECRET_ARN }),
  );
  cachedSecret = res.SecretString;
  return cachedSecret;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function sanitizeFileName(name) {
  const base = String(name ?? "document").split(/[/\\]/).pop() ?? "document";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "document";
}

async function authorized(event) {
  const header = event.headers?.["x-docs-signer-secret"] ?? "";
  const expected = await getSharedSecret();
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  if (!(await authorized(event))) {
    return json(401, { error: "unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "invalid json body" });
  }

  if (payload.action === "presign-upload") {
    const { fileName, contentType, sizeBytes } = payload;

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return json(400, { error: `unsupported content type: ${contentType}` });
    }
    if (typeof sizeBytes !== "number" || sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
      return json(400, { error: `file size must be between 1 and ${MAX_UPLOAD_BYTES} bytes` });
    }

    const objectKey = `${DOCS_PREFIX}${randomUUID()}-${sanitizeFileName(fileName)}`;

    const presigned = await createPresignedPost(s3, {
      Bucket: DOCS_BUCKET,
      Key: objectKey,
      Conditions: [
        ["content-length-range", 1, MAX_UPLOAD_BYTES],
        ["eq", "$Content-Type", contentType],
        ["eq", "$key", objectKey],
      ],
      Fields: {
        key: objectKey,
        "Content-Type": contentType,
      },
      Expires: 60,
    });

    return json(200, {
      objectKey,
      url: presigned.url,
      fields: presigned.fields,
    });
  }

  if (payload.action === "delete") {
    const { objectKey } = payload;
    if (typeof objectKey !== "string" || !objectKey.startsWith(DOCS_PREFIX)) {
      return json(400, { error: "objectKey outside configured prefix" });
    }

    await s3.send(new DeleteObjectCommand({ Bucket: DOCS_BUCKET, Key: objectKey }));
    return json(200, { ok: true });
  }

  return json(400, { error: `unknown action: ${payload.action}` });
};
