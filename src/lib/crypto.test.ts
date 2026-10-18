import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecret, decryptSecret } from "./crypto";

const VALID_KEY = "0".repeat(64); // 32 bytes hex

describe("crypto", () => {
  const originalKey = process.env.PLATFORM_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.PLATFORM_ENCRYPTION_KEY = VALID_KEY;
  });

  afterEach(() => {
    process.env.PLATFORM_ENCRYPTION_KEY = originalKey;
  });

  it("round-trips plaintext through encrypt and decrypt", () => {
    const plaintext = "sk-super-secret-api-key";
    const encrypted = encryptSecret(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("produces a colon-delimited iv:tag:ciphertext blob", () => {
    const encrypted = encryptSecret("hello");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]{24}$/); // 12-byte IV
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/); // 16-byte GCM tag
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("throws when PLATFORM_ENCRYPTION_KEY is not set", () => {
    delete process.env.PLATFORM_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/PLATFORM_ENCRYPTION_KEY is not set/);
  });

  it("throws when PLATFORM_ENCRYPTION_KEY is the wrong length", () => {
    process.env.PLATFORM_ENCRYPTION_KEY = "abcd"; // 2 bytes
    expect(() => encryptSecret("x")).toThrow(/must be 32 bytes/);
  });

  it("throws on a malformed blob missing parts", () => {
    expect(() => decryptSecret("only-one-part")).toThrow(/Invalid encrypted blob format/);
    expect(() => decryptSecret("iv:tag")).toThrow(/Invalid encrypted blob format/);
  });

  it("throws when the blob was tampered with (auth tag mismatch)", () => {
    const encrypted = encryptSecret("do-not-tamper");
    const [iv, tag, ct] = encrypted.split(":");
    const tamperedCt = ct.slice(0, -2) + (ct.slice(-2) === "00" ? "ff" : "00");
    expect(() => decryptSecret(`${iv}:${tag}:${tamperedCt}`)).toThrow();
  });

  it("throws when decrypting with a different key than it was encrypted with", () => {
    const encrypted = encryptSecret("cross-key-test");
    process.env.PLATFORM_ENCRYPTION_KEY = "1".repeat(64);
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  it("throws on a blob whose segments are non-hex text", () => {
    // Non-hex characters make Buffer.from(..., "hex") decode to 0 bytes
    // rather than throwing, so it is the IV and tag length check that
    // refuses this, before any decryption is attempted.
    expect(() => decryptSecret("not-hex:not-hex:not-hex")).toThrow(/Invalid encrypted blob format/);
  });

  // Attack matrix — invalid ciphertext. Each variation starts from a real
  // blob, so a refusal is the change's doing and not a broken fixture.
  describe("a blob altered by someone with write access to the database", () => {
    const parts = () => encryptSecret("sk-live-customer-key").split(":");

    it.each([4, 8, 12, 15])("refuses the real tag truncated to %i bytes", (bytes) => {
      const [iv, tag, ct] = parts();
      expect(() => decryptSecret(`${iv}:${tag.slice(0, bytes * 2)}:${ct}`)).toThrow(
        /Invalid encrypted blob format/,
      );
    });

    it("refuses an IV of another length, even a prefix of the real one", () => {
      const [iv, tag, ct] = parts();
      expect(() => decryptSecret(`${iv.slice(0, 16)}:${tag}:${ct}`)).toThrow(/Invalid encrypted blob format/);
      expect(() => decryptSecret(`${iv}00:${tag}:${ct}`)).toThrow(/Invalid encrypted blob format/);
    });

    it("refuses a blob with a fourth segment rather than ignoring it", () => {
      const [iv, tag, ct] = parts();
      expect(() => decryptSecret(`${iv}:${tag}:${ct}:${ct}`)).toThrow(/Invalid encrypted blob format/);
    });

    it("refuses one tenant's ciphertext spliced under another's IV and tag", () => {
      const [ivA, tagA] = parts();
      const [, , ctB] = encryptSecret("sk-other-tenant-key").split(":");
      expect(() => decryptSecret(`${ivA}:${tagA}:${ctB}`)).toThrow();
    });

    it("refuses a flipped bit in the tag", () => {
      const [iv, tag, ct] = parts();
      const flipped = (parseInt(tag[0], 16) ^ 1).toString(16) + tag.slice(1);
      expect(() => decryptSecret(`${iv}:${flipped}:${ct}`)).toThrow();
    });

    it("control: the unaltered blob still decrypts", () => {
      const [iv, tag, ct] = parts();
      expect(decryptSecret(`${iv}:${tag}:${ct}`)).toBe("sk-live-customer-key");
    });
  });

  // Attack matrix — secret rotation. The platform has one key and no
  // re-encryption step, so rotating PLATFORM_ENCRYPTION_KEY must make the old
  // ciphertexts fail loudly rather than decrypt to something else.
  describe("after PLATFORM_ENCRYPTION_KEY is rotated", () => {
    it("refuses every blob written under the old key, and accepts new ones", () => {
      const before = [encryptSecret("llm"), encryptSecret("pinecone"), encryptSecret("signer")];
      process.env.PLATFORM_ENCRYPTION_KEY = "f".repeat(64);

      for (const blob of before) expect(() => decryptSecret(blob)).toThrow();
      expect(decryptSecret(encryptSecret("after"))).toBe("after");
    });

    it("refuses to fall back to the old key when the new one is malformed", () => {
      const blob = encryptSecret("llm");
      process.env.PLATFORM_ENCRYPTION_KEY = "f".repeat(63);

      expect(() => decryptSecret(blob)).toThrow(/must be 32 bytes/);
    });
  });

  it("rejects an empty-string plaintext because the empty ciphertext hex fails the blob-format check", () => {
    // GCM produces a zero-length ciphertext for an empty plaintext, so the
    // ct segment of iv:tag:ct is "" — which decryptSecret's truthiness check
    // treats as a malformed blob rather than valid empty content.
    const encrypted = encryptSecret("");
    expect(encrypted.endsWith(":")).toBe(true);
    expect(() => decryptSecret(encrypted)).toThrow(/Invalid encrypted blob format/);
  });
});
