import { describe, it, expect } from "vitest";
import {
  AWS_OIDC_AUDIENCE,
  CUSTOMER_ACCOUNT_PLACEHOLDER,
  PLATFORM_ACCOUNT_PLACEHOLDER,
  awsExternalId,
  awsFederatedSubject,
  awsTrustPolicy,
} from "./awsTrust";

const tenantA = "0b6f3c7e-9a1d-4a7e-8f53-2d1c6b9e4a10";
const tenantB = "5d2e8a41-7c3b-4f9e-a6d0-91b4c2e7f358";
const repo = { owner: "kaltrinaT", repo: "ai-chatbot-platform" };

describe("awsExternalId", () => {
  // The property the onboarding path's protection rests on: a role whose trust
  // policy names one tenant's value cannot be assumed for another tenant.
  it("differs for every tenant", () => {
    expect(awsExternalId(tenantA)).not.toBe(awsExternalId(tenantB));
  });
});

describe("awsFederatedSubject", () => {
  // The same property for the deploy path. Both clouds now bind on this.
  it("names the tenant's GitHub environment, not the deploy branch", () => {
    expect(awsFederatedSubject(repo, tenantA)).toBe(
      `repo:kaltrinaT/ai-chatbot-platform:environment:tenant-${tenantA}`,
    );
    expect(awsFederatedSubject(repo, tenantA)).not.toBe(awsFederatedSubject(repo, tenantB));
  });
});

describe("awsTrustPolicy", () => {
  const policy = (
    tenantId: string,
    overrides: Partial<Parameters<typeof awsTrustPolicy>[0]> = {},
  ) =>
    JSON.parse(
      awsTrustPolicy({
        platformAccountId: "123456789012",
        customerAccountId: "210987654321",
        githubRepo: repo,
        tenantId,
        ...overrides,
      }),
    );

  const statement = (tenantId: string, sid: string, overrides = {}) =>
    policy(tenantId, overrides).Statement.find((s: { Sid: string }) => s.Sid === sid);

  it("carries exactly the two statements the two callers need", () => {
    expect(policy(tenantA).Statement.map((s: { Sid: string }) => s.Sid)).toEqual([
      "GitHubActionsDeploy",
      "PlatformOnboarding",
    ]);
  });

  describe("the GitHub statement — deploys and teardowns", () => {
    it("federates to the OIDC provider in the customer's own account", () => {
      expect(statement(tenantA, "GitHubActionsDeploy")).toMatchObject({
        Effect: "Allow",
        Action: "sts:AssumeRoleWithWebIdentity",
        Principal: {
          Federated:
            "arn:aws:iam::210987654321:oidc-provider/token.actions.githubusercontent.com",
        },
      });
    });

    it("pins this tenant's subject and the audience AWS requires", () => {
      expect(statement(tenantA, "GitHubActionsDeploy").Condition).toEqual({
        StringEquals: {
          "token.actions.githubusercontent.com:aud": AWS_OIDC_AUDIENCE,
          "token.actions.githubusercontent.com:sub": awsFederatedSubject(repo, tenantA),
        },
      });
    });

    // StringLike with a wildcard subject would let any environment in the
    // repository — so any other tenant's deploy — assume this role. It is the
    // single most consequential character in the file.
    it("matches the subject exactly, never by pattern", () => {
      const condition = statement(tenantA, "GitHubActionsDeploy").Condition;

      expect(Object.keys(condition)).toEqual(["StringEquals"]);
      expect(JSON.stringify(condition)).not.toContain("*");
    });

    it("differs between tenants in the same customer account", () => {
      const subject = (t: string) =>
        statement(t, "GitHubActionsDeploy").Condition.StringEquals[
          "token.actions.githubusercontent.com:sub"
        ];

      expect(subject(tenantA)).not.toBe(subject(tenantB));
    });
  });

  describe("the platform statement — onboarding secret writes", () => {
    it("conditions on this tenant's ExternalId", () => {
      expect(statement(tenantA, "PlatformOnboarding").Condition).toEqual({
        StringEquals: { "sts:ExternalId": awsExternalId(tenantA) },
      });
    });

    it("trusts the platform account as principal", () => {
      expect(statement(tenantA, "PlatformOnboarding")).toMatchObject({
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Principal: { AWS: "arn:aws:iam::123456789012:root" },
      });
    });
  });

  describe("unknown values", () => {
    it("shows a visible placeholder rather than a wrong account", () => {
      expect(
        statement(tenantA, "PlatformOnboarding", { platformAccountId: null }).Principal.AWS,
      ).toContain(PLATFORM_ACCOUNT_PLACEHOLDER);
      expect(
        statement(tenantA, "PlatformOnboarding", { platformAccountId: "  " }).Principal.AWS,
      ).toContain(PLATFORM_ACCOUNT_PLACEHOLDER);
      expect(
        statement(tenantA, "GitHubActionsDeploy", { customerAccountId: null }).Principal.Federated,
      ).toContain(CUSTOMER_ACCOUNT_PLACEHOLDER);
    });

    // A repo the platform has not been told about must not silently produce a
    // subject that looks real; the placeholder is what makes the gap visible
    // in the panel the customer copies from.
    it("shows a placeholder repository rather than an empty subject", () => {
      const subject = statement(tenantA, "GitHubActionsDeploy", { githubRepo: null }).Condition
        .StringEquals["token.actions.githubusercontent.com:sub"];

      expect(subject).toBe(`repo:<owner>/<repo>:environment:tenant-${tenantA}`);
    });
  });
});
