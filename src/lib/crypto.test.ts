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

  it("throws on a blob whose segments are non-hex text (passes the format check, fails at decode)", () => {
    // Non-hex characters make Buffer.from(..., "hex") decode to 0 bytes
    // rather than throwing, so this fails downstream — in createDecipheriv,
    // as an invalid IV length — not at the "Invalid encrypted blob format"
    // check, since all three colon-delimited segments are non-empty strings.
    expect(() => decryptSecret("not-hex:not-hex:not-hex")).toThrow(/Invalid initialization vector/);
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
