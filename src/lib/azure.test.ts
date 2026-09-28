import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateDocsSignerSecret } from "./azure";
import { decryptSecret } from "@/lib/crypto";

describe("generateDocsSignerSecret", () => {
  const originalKey = process.env.PLATFORM_ENCRYPTION_KEY;

  beforeEach(() => {
    // A real (not mocked) encrypt/decrypt round-trip needs a valid key —
    // this exercises the actual @/lib/crypto module, not a stub. No Azure
    // SDK call happens in this function at all (unlike AWS's
    // ensureDocsSignerSecret) — the vault doesn't exist yet at onboarding
    // time, so there's nothing to mock here beyond crypto.
    process.env.PLATFORM_ENCRYPTION_KEY = "1".repeat(64);
  });

  afterEach(() => {
    process.env.PLATFORM_ENCRYPTION_KEY = originalKey;
  });

  it("generates a 64-hex-char plaintext secret", () => {
    const result = generateDocsSignerSecret();
    expect(result.docsSignerSecretPlaintext).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns an encrypted copy that decrypts back to the exact plaintext", () => {
    const result = generateDocsSignerSecret();
    expect(decryptSecret(result.docsSignerSecretEncrypted)).toBe(result.docsSignerSecretPlaintext);
  });

  it("generates a different secret value on every call", () => {
    const first = generateDocsSignerSecret();
    const second = generateDocsSignerSecret();
    expect(first.docsSignerSecretPlaintext).not.toBe(second.docsSignerSecretPlaintext);
  });
});
