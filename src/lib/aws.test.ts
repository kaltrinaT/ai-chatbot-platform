import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { stsSend, stsCredentials, secretsSend, hostHeader } = vi.hoisted(() => ({
  stsSend: vi.fn(),
  stsCredentials: vi.fn(),
  secretsSend: vi.fn(),
  // What the host puts on the incoming request, per test.
  hostHeader: { oidcToken: undefined as string | undefined },
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(hostHeader.oidcToken ? { "x-vercel-oidc-token": hostHeader.oidcToken } : {}),
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
    // The platform's own credentials, as the SDK's default chain resolved them.
    this.config = { credentials: stsCredentials };
  });
  const AssumeRoleCommand = vi.fn(function (this: MockInstance, input: unknown) {
    this.input = input;
  });
  const AssumeRoleWithWebIdentityCommand = vi.fn(function (this: MockInstance, input: unknown) {
    this.input = input;
  });
  return { STSClient, AssumeRoleCommand, AssumeRoleWithWebIdentityCommand };
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

import {
  STSClient,
  AssumeRoleCommand,
  AssumeRoleWithWebIdentityCommand,
} from "@aws-sdk/client-sts";
import { CreateSecretCommand, UpdateSecretCommand } from "@aws-sdk/client-secrets-manager";
import {
  assumeTenantRole,
  writeTenantSecret,
  ensureDocsSignerSecret,
  LongLivedAwsKeyError,
  PlatformCredentialsError,
} from "./aws";
import { decryptSecret } from "@/lib/crypto";

// What `aws login` or `aws sso login` hands the SDK: temporary, so it carries
// a session token.
const signInSession = {
  accessKeyId: "ASIAPLATFORM",
  secretAccessKey: "platform-secret",
  sessionToken: "platform-session",
};

describe("assumeTenantRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stsCredentials.mockResolvedValue(signInSession);
  });

  it("refuses a long-lived access key without calling STS", async () => {
    stsCredentials.mockResolvedValue({ accessKeyId: "AKIAPLATFORM", secretAccessKey: "platform-secret" });

    await expect(
      assumeTenantRole({ roleArn: "arn:x", sessionName: "s", region: "us-east-1" }),
    ).rejects.toBeInstanceOf(LongLivedAwsKeyError);
    expect(stsSend).not.toHaveBeenCalled();
  });

  it("propagates a missing sign-in session without calling STS", async () => {
    const noSession = Object.assign(new Error("Could not load credentials from any providers"), {
      name: "CredentialsProviderError",
    });
    stsCredentials.mockRejectedValue(noSession);

    await expect(
      assumeTenantRole({ roleArn: "arn:x", sessionName: "s", region: "us-east-1" }),
    ).rejects.toThrow("Could not load credentials from any providers");
    expect(stsSend).not.toHaveBeenCalled();
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

  // The confused-deputy guard: a customer's trust policy conditions on this
  // value, so a call made for another tenant is refused by STS.
  it("sends the tenant's ExternalId when one is given", async () => {
    stsSend.mockResolvedValue({
      Credentials: { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "c" },
    });

    await assumeTenantRole({
      roleArn: "arn:aws:iam::111111111111:role/deploy",
      sessionName: "session-1",
      region: "us-east-1",
      externalId: "0b6f3c7e-9a1d-4a7e-8f53-2d1c6b9e4a10",
    });

    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ ExternalId: "0b6f3c7e-9a1d-4a7e-8f53-2d1c6b9e4a10" }),
    );
  });

  // Omitted rather than sent empty: STS rejects an empty ExternalId outright,
  // which would break every tenant onboarded before this existed.
  it("omits ExternalId entirely when none is given", async () => {
    stsSend.mockResolvedValue({
      Credentials: { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "c" },
    });

    await assumeTenantRole({ roleArn: "arn:x", sessionName: "s", region: "us-east-1" });

    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.not.objectContaining({ ExternalId: expect.anything() }),
    );
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
    stsCredentials.mockResolvedValue(signInSession);
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
      externalId: "0b6f3c7e-9a1d-4a7e-8f53-2d1c6b9e4a10",
    });

    // Onboarding's second assume must carry the condition too, or a customer
    // who applied it could complete neither half of onboarding.
    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ ExternalId: "0b6f3c7e-9a1d-4a7e-8f53-2d1c6b9e4a10" }),
    );

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

describe("the platform's own credentials", () => {
  const savedRoleArn = process.env.PLATFORM_AWS_ROLE_ARN;
  const savedToken = process.env.VERCEL_OIDC_TOKEN;
  const PLATFORM_ROLE = "arn:aws:iam::229647349798:role/platform-control-plane";

  /** The credential provider assumeTenantRole handed to its STS client, if any. */
  function credentialProviderPassedToSts() {
    const opts = vi.mocked(STSClient).mock.calls[0][0] as {
      credentials?: () => Promise<{ accessKeyId: string; sessionToken: string }>;
    };
    return opts.credentials;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stsCredentials.mockResolvedValue(signInSession);
    stsSend.mockResolvedValue({
      Credentials: { AccessKeyId: "ASIATENANT", SecretAccessKey: "s", SessionToken: "t" },
    });
  });

  afterEach(() => {
    if (savedRoleArn === undefined) delete process.env.PLATFORM_AWS_ROLE_ARN;
    else process.env.PLATFORM_AWS_ROLE_ARN = savedRoleArn;
    if (savedToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = savedToken;
    hostHeader.oidcToken = undefined;
  });

  // A developer machine: the operator's own sign-in session, resolved by the
  // SDK's chain, which is why no provider is passed at all.
  it("leaves the SDK's default chain in place when no platform role is configured", async () => {
    delete process.env.PLATFORM_AWS_ROLE_ARN;

    await assumeTenantRole({ roleArn: "arn:x", sessionName: "s", region: "us-east-1" });

    expect(credentialProviderPassedToSts()).toBeUndefined();
    expect(AssumeRoleWithWebIdentityCommand).not.toHaveBeenCalled();
  });

  it("exchanges the host's OIDC token for the platform role when one is configured", async () => {
    process.env.PLATFORM_AWS_ROLE_ARN = PLATFORM_ROLE;
    process.env.VERCEL_OIDC_TOKEN = "signed.host.token";

    await assumeTenantRole({ roleArn: "arn:x", sessionName: "s", region: "eu-central-1" });

    const provider = credentialProviderPassedToSts();
    expect(provider).toBeTypeOf("function");

    stsSend.mockResolvedValueOnce({
      Credentials: { AccessKeyId: "ASIAHOST", SecretAccessKey: "hs", SessionToken: "ht" },
    });
    const credentials = await provider!();

    expect(AssumeRoleWithWebIdentityCommand).toHaveBeenCalledWith({
      RoleArn: PLATFORM_ROLE,
      RoleSessionName: "platform-control-plane",
      WebIdentityToken: "signed.host.token",
      DurationSeconds: 3600,
    });
    expect(credentials).toMatchObject({ accessKeyId: "ASIAHOST", sessionToken: "ht" });
  });

  // The path that actually runs in production: Vercel signs a token per
  // invocation and sends it as a request header, leaving the environment
  // variable empty outside a build.
  it("takes the token from the request header when the environment has none", async () => {
    process.env.PLATFORM_AWS_ROLE_ARN = PLATFORM_ROLE;
    delete process.env.VERCEL_OIDC_TOKEN;
    hostHeader.oidcToken = "header.host.token";

    await assumeTenantRole({ roleArn: "arn:x", sessionName: "s", region: "us-east-1" });

    stsSend.mockResolvedValueOnce({
      Credentials: { AccessKeyId: "ASIAHOST", SecretAccessKey: "hs", SessionToken: "ht" },
    });
    await credentialProviderPassedToSts()!();

    expect(AssumeRoleWithWebIdentityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ WebIdentityToken: "header.host.token", RoleArn: PLATFORM_ROLE }),
    );
  });

  // Silently falling back would mean a hosted platform quietly running as
  // whatever else the chain can find, which is the failure this whole change
  // exists to prevent.
  it("refuses to reach for anything else when the host issued no token", async () => {
    process.env.PLATFORM_AWS_ROLE_ARN = PLATFORM_ROLE;
    delete process.env.VERCEL_OIDC_TOKEN;

    await assumeTenantRole({ roleArn: "arn:x", sessionName: "s", region: "us-east-1" });
    const provider = credentialProviderPassedToSts();

    await expect(provider!()).rejects.toBeInstanceOf(PlatformCredentialsError);
    expect(AssumeRoleWithWebIdentityCommand).not.toHaveBeenCalled();
  });
});
