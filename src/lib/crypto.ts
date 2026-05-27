import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function getKey(): Buffer {
  const raw = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "PLATFORM_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32",
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `PLATFORM_ENCRYPTION_KEY must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars); got ${key.length} bytes.`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(blob: string): string {
  const key = getKey();
  const [ivHex, tagHex, ctHex] = blob.split(":");
  if (!ivHex || !tagHex || !ctHex) {
    throw new Error("Invalid encrypted blob format.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
