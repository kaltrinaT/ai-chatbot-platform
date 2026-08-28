import { describe, it, expect, beforeEach, vi } from "vitest";

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
import { assumeTenantRole, writeTenantSecret } from "./aws";

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
