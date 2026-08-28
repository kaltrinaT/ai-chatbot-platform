import { describe, it, expect, beforeEach, vi } from "vitest";

const { setSecret } = vi.hoisted(() => ({ setSecret: vi.fn() }));

type MockInstance = Record<string, unknown>;

vi.mock("@azure/identity", () => {
  const ClientSecretCredential = vi.fn(function (
    this: MockInstance,
    tenantId: string,
    clientId: string,
    clientSecret: string,
  ) {
    this.tenantId = tenantId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  });
  return { ClientSecretCredential };
});

vi.mock("@azure/keyvault-secrets", () => {
  const SecretClient = vi.fn(function (this: MockInstance, vaultUrl: string, credential: unknown) {
    this.vaultUrl = vaultUrl;
    this.credential = credential;
    this.setSecret = setSecret;
  });
  return { SecretClient };
});

import { ClientSecretCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { writeAzureKeyVaultSecret } from "./azure";

const opts = {
  credentials: {
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: "secret-1",
    subscriptionId: "sub-1",
  },
  keyVaultName: "acme-co-kv",
  secretName: "llm-api-key",
  secretValue: "sk-secret",
};

describe("writeAzureKeyVaultSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the vault URI (without version) on success", async () => {
    setSecret.mockResolvedValue({ properties: { id: "https://acme-co-kv.vault.azure.net/secrets/llm-api-key/abc123" } });

    const result = await writeAzureKeyVaultSecret(opts);

    expect(result).toBe("https://acme-co-kv.vault.azure.net/secrets/llm-api-key");
  });

  it("builds the vault URL from the key vault name", async () => {
    setSecret.mockResolvedValue({ properties: { id: "x" } });

    await writeAzureKeyVaultSecret(opts);

    expect(SecretClient).toHaveBeenCalledWith(
      "https://acme-co-kv.vault.azure.net",
      expect.any(Object),
    );
  });

  it("constructs the credential with tenantId, clientId, clientSecret in order", async () => {
    setSecret.mockResolvedValue({ properties: { id: "x" } });

    await writeAzureKeyVaultSecret(opts);

    expect(ClientSecretCredential).toHaveBeenCalledWith("tenant-1", "client-1", "secret-1");
  });

  it("calls setSecret with the name, value, and text/plain content type", async () => {
    setSecret.mockResolvedValue({ properties: { id: "x" } });

    await writeAzureKeyVaultSecret(opts);

    expect(setSecret).toHaveBeenCalledWith("llm-api-key", "sk-secret", { contentType: "text/plain" });
  });

  it("throws when the Key Vault response has no secret id", async () => {
    setSecret.mockResolvedValue({ properties: {} });

    await expect(writeAzureKeyVaultSecret(opts)).rejects.toThrow(/no secret ID/);
  });

  it("propagates a rejection from setSecret", async () => {
    setSecret.mockRejectedValue(new Error("Key Vault unreachable"));

    await expect(writeAzureKeyVaultSecret(opts)).rejects.toThrow("Key Vault unreachable");
  });
});
