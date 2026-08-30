import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { stsSend, secretsSend } = vi.hoisted(() => ({
  stsSend: vi.fn(),
  secretsSend: vi.fn(),
}));

// Mock implementations use `function` (not arrow functions) so `new` works,
// and are wrapped in vi.fn so construction calls/args are assertable — see
// the earlier "is not a constructor" fix for the Octokit mock in github.test.ts.
// `this`/args are typed as Record<string, unknown> rather than `any` to keep
// the assignments legal without tripping @typescript-eslint/no-explicit-any.
type MockInstance = Record<string, unknown>;

vi.mock("@aws-sdk/client-sts", () => {
  const STSClient = vi.fn(function (this: MockInstance, opts: unknown) {
    this.opts = opts;
    this.send = stsSend;
  });
  const AssumeRoleCommand = vi.fn(function (this: MockInstance, input: unknown) {
    this.input = input;
  });
  return { STSClient, AssumeRoleCommand };
});

vi.mock("@aws-sdk/client-secrets-manager", () => {
  const SecretsManagerClient = vi.fn(function (this: MockInstance, opts: unknown) {
    this.opts = opts;
    this.send = secretsSend;
  });
  const CreateSecretCommand = vi.fn(function (this: MockInstance, input: unknown) {
    this.input = input;
  });
  const UpdateSecretCommand = vi.fn(function (this: MockInstance, input: unknown) {
    this.input = input;
  });
  return { SecretsManagerClient, CreateSecretCommand, UpdateSecretCommand };
});

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { CreateSecretCommand, UpdateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { assumeTenantRole, writeTenantSecret, ensureDocsSignerSecret } from "./aws";
import { decryptSecret } from "@/lib/crypto";

describe("assumeTenantRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns mapped credentials on success", async () => {
    stsSend.mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKIA123",
        SecretAccessKey: "secret",
        SessionToken: "token",
      },
    });

    const creds = await assumeTenantRole({
      roleArn: "arn:aws:iam::111111111111:role/deploy",
      sessionName: "session-1",
      region: "us-east-1",
    });

    expect(creds).toEqual({
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      sessionToken: "token",
    });
    expect(STSClient).toHaveBeenCalledWith({ region: "us-east-1" });
    expect(AssumeRoleCommand).toHaveBeenCalledWith({
      RoleArn: "arn:aws:iam::111111111111:role/deploy",
      RoleSessionName: "session-1",
      DurationSeconds: 900,
    });
  });

  it("throws when Credentials is missing entirely", async () => {
    stsSend.mockResolvedValue({});

    await expect(
      assumeTenantRole({ roleArn: "arn:x", sessionName: "s", region: "us-east-1" }),
    ).rejects.toThrow(/incomplete credentials/);
  });

  it.each(["AccessKeyId", "SecretAccessKey", "SessionToken"])(
    "throws when %s is missing from the response",
    async (missingField) => {
      const full = { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "c" };
      stsSend.mockResolvedValue({ Credentials: { ...full, [missingField]: undefined } });

      await expect(
        assumeTenantRole({ roleArn: "arn:x", sessionName: "s", region: "us-east-1" }),
      ).rejects.toThrow(/incomplete credentials/);
    },
  );
});

describe("writeTenantSecret", () => {
  const opts = {
    credentials: { accessKeyId: "a", secretAccessKey: "b", sessionToken: "c" },
    region: "us-east-1",
    secretName: "acme-co/llm-api-key",
    secretValue: "sk-secret",
    description: "LLM API key",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new secret and returns its ARN", async () => {
    secretsSend.mockResolvedValue({ ARN: "arn:aws:secretsmanager:us-east-1:1:secret:acme-co/llm-api-key" });

    const arn = await writeTenantSecret(opts);

    expect(arn).toBe("arn:aws:secretsmanager:us-east-1:1:secret:acme-co/llm-api-key");
    expect(CreateSecretCommand).toHaveBeenCalledWith({
      Name: opts.secretName,
      SecretString: opts.secretValue,
      Description: opts.description,
    });
    expect(UpdateSecretCommand).not.toHaveBeenCalled();
  });

  it("throws when CreateSecret succeeds but returns no ARN", async () => {
    secretsSend.mockResolvedValue({});

    await expect(writeTenantSecret(opts)).rejects.toThrow(/CreateSecret returned no ARN/);
  });

  it("falls back to UpdateSecret when the secret already exists", async () => {
    const exists = Object.assign(new Error("already exists"), { name: "ResourceExistsException" });
    secretsSend
      .mockRejectedValueOnce(exists)
      .mockResolvedValueOnce({ ARN: "arn:aws:secretsmanager:us-east-1:1:secret:acme-co/llm-api-key" });

    const arn = await writeTenantSecret(opts);

    expect(arn).toBe("arn:aws:secretsmanager:us-east-1:1:secret:acme-co/llm-api-key");
    expect(UpdateSecretCommand).toHaveBeenCalledWith({
      SecretId: opts.secretName,
      SecretString: opts.secretValue,
    });
  });

  it("throws when the UpdateSecret fallback returns no ARN", async () => {
    const exists = Object.assign(new Error("already exists"), { name: "ResourceExistsException" });
    secretsSend.mockRejectedValueOnce(exists).mockResolvedValueOnce({});

    await expect(writeTenantSecret(opts)).rejects.toThrow(/UpdateSecret returned no ARN/);
  });

  it("rethrows an error that isn't ResourceExistsException without attempting an update", async () => {
    const denied = Object.assign(new Error("access denied"), { name: "AccessDeniedException" });
    secretsSend.mockRejectedValueOnce(denied);

    await expect(writeTenantSecret(opts)).rejects.toThrow("access denied");
    expect(UpdateSecretCommand).not.toHaveBeenCalled();
  });
});

describe("ensureDocsSignerSecret", () => {
  const originalKey = process.env.PLATFORM_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    // A real (not mocked) encrypt/decrypt round-trip needs a valid key —
    // this exercises the actual @/lib/crypto module, not a stub.
    process.env.PLATFORM_ENCRYPTION_KEY = "1".repeat(64);
    stsSend.mockResolvedValue({
      Credentials: { AccessKeyId: "AKIA123", SecretAccessKey: "secret", SessionToken: "token" },
    });
  });

  afterEach(() => {
    process.env.PLATFORM_ENCRYPTION_KEY = originalKey;
  });

  it("assumes the role, writes a freshly generated secret, and returns the ARN plus a decryptable local copy", async () => {
    secretsSend.mockResolvedValue({
      ARN: "arn:aws:secretsmanager:us-east-1:111111111111:secret:acme-co/docs-signer-secret",
    });

    const result = await ensureDocsSignerSecret({
      roleArn: "arn:aws:iam::111111111111:role/deploy",
      region: "us-east-1",
      slug: "acme-co",
      sessionName: "tenant-onboarding-docs-acme-co",
    });

    expect(result.docsSignerSecretArn).toBe(
      "arn:aws:secretsmanager:us-east-1:111111111111:secret:acme-co/docs-signer-secret",
    );
    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        RoleArn: "arn:aws:iam::111111111111:role/deploy",
        RoleSessionName: "tenant-onboarding-docs-acme-co",
      }),
    );

    const createInput = vi.mocked(CreateSecretCommand).mock.calls[0][0] as {
      Name: string;
      SecretString: string;
    };
    expect(createInput.Name).toBe("acme-co/docs-signer-secret");
    // randomBytes(32).toString("hex") — 64 hex characters.
    expect(createInput.SecretString).toMatch(/^[0-9a-f]{64}$/);

    // The platform's own encrypted copy must decrypt back to the exact
    // value written into the tenant's Secrets Manager — that's the whole
    // point of keeping a local copy instead of re-fetching it later.
    expect(decryptSecret(result.docsSignerSecretEncrypted)).toBe(createInput.SecretString);
  });

  it("generates a different secret value on every call", async () => {
    secretsSend.mockResolvedValue({ ARN: "arn:aws:secretsmanager:us-east-1:1:secret:x" });

    await ensureDocsSignerSecret({
      roleArn: "arn:x",
      region: "us-east-1",
      slug: "acme",
      sessionName: "s1",
    });
    await ensureDocsSignerSecret({
      roleArn: "arn:x",
      region: "us-east-1",
      slug: "acme",
      sessionName: "s2",
    });

    const [first, second] = vi.mocked(CreateSecretCommand).mock.calls as {
      0: { SecretString: string };
    }[];
    expect(first[0].SecretString).not.toBe(second[0].SecretString);
  });

  it("propagates an AssumeRole failure without writing a secret", async () => {
    stsSend.mockResolvedValue({});

    await expect(
      ensureDocsSignerSecret({ roleArn: "arn:x", region: "us-east-1", slug: "acme", sessionName: "s" }),
    ).rejects.toThrow(/incomplete credentials/);

    expect(CreateSecretCommand).not.toHaveBeenCalled();
  });
});
