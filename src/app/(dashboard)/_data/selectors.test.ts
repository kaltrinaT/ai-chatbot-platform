import { describe, it, expect } from "vitest";
import {
  avatarInitials,
  avatarTone,
  buildActivity,
  buildAttentionItems,
  chatbotStatus,
  computeChatbotsPageStats,
  computeDashboardStats,
  computeGettingStartedSteps,
  filterAndSortTenants,
  hasCloudAccount,
  latestDeployByTenant,
} from "./selectors";
import type { DeployJoinRow, DeploymentRow, DocJoinRow, TenantRow } from "./queries";

function tenantRow(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: "tenant-1",
    name: "Acme Bot",
    slug: "acme-bot",
    ownerUserId: "user-1",
    cloudProvider: "aws",
    awsAccountId: null,
    awsRegion: null,
    deploymentRoleArn: null,
    s3DocsBucket: null,
    s3DocsPrefix: null,
    acmCertificateArn: null,
    docsSignerSecretArn: null,
    docsSignerSecretEncrypted: null,
    docsSignerUrl: null,
    azureSubscriptionId: null,
    azureTenantId: null,
    azureClientId: null,
    azureResourceGroup: null,
    azureRegion: null,
    azureStorageAccount: null,
    azureStorageContainer: null,
    azureKeyVaultName: null,
    llmProvider: "anthropic",
    llmApiKeyEncrypted: "encrypted",
    llmSecretArn: null,
    llmModel: null,
    llmBaseUrl: null,
    vectorStore: "pinecone",
    pineconeApiKeyEncrypted: null,
    pineconeSecretArn: null,
    domain: null,
    chatbotVersion: "latest",
    albDnsName: null,
    chatbotUrl: null,
    config: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function deploymentRow(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: "dep-1",
    tenantId: "tenant-1",
    kind: "deploy",
    status: "succeeded",
    chatbotVersion: "latest",
    githubRunId: null,
    githubRunUrl: null,
    secretsClaimedAt: null,
    triggeredByUserId: "user-1",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    finishedAt: null,
    errorMessage: null,
    ...overrides,
  };
}

function deployJoinRow(overrides: Partial<DeploymentRow> = {}, tenantName = "Acme Bot", tenantSlug = "acme-bot"): DeployJoinRow {
  return { deployment: deploymentRow(overrides), tenantName, tenantSlug };
}

function docJoinRow(
  overrides: Partial<DocJoinRow["document"]> = {},
  tenantName = "Acme Bot",
): DocJoinRow {
  return {
    document: {
      id: "doc-1",
      tenantId: "tenant-1",
      objectKey: "docs/file.pdf",
      displayName: "file.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
      status: "uploaded",
      uploadedByUserId: "user-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    },
    tenantName,
  };
}

describe("latestDeployByTenant", () => {
  it("keeps the newest row per tenant when the input is already newest-first", () => {
    const rows = [
      deployJoinRow({ id: "dep-new", tenantId: "t1", startedAt: new Date("2026-01-02T00:00:00Z") }),
      deployJoinRow({ id: "dep-old", tenantId: "t1", startedAt: new Date("2026-01-01T00:00:00Z") }),
      deployJoinRow({ id: "dep-other", tenantId: "t2" }),
    ];

    const map = latestDeployByTenant(rows);

    expect(map.get("t1")?.deployment.id).toBe("dep-new");
    expect(map.get("t2")?.deployment.id).toBe("dep-other");
    expect(map.size).toBe(2);
  });
});

describe("hasCloudAccount", () => {
  it("requires both role ARN and account ID for AWS", () => {
    expect(hasCloudAccount(tenantRow({ cloudProvider: "aws" }))).toBe(false);
    expect(
      hasCloudAccount(tenantRow({ cloudProvider: "aws", deploymentRoleArn: "arn:aws:iam::1:role/x" })),
    ).toBe(false);
    expect(
      hasCloudAccount(
        tenantRow({ cloudProvider: "aws", deploymentRoleArn: "arn:aws:iam::1:role/x", awsAccountId: "1" }),
      ),
    ).toBe(true);
  });

  it("requires both subscription ID and tenant ID for Azure", () => {
    expect(hasCloudAccount(tenantRow({ cloudProvider: "azure" }))).toBe(false);
    expect(
      hasCloudAccount(
        tenantRow({ cloudProvider: "azure", azureSubscriptionId: "sub", azureTenantId: "tid" }),
      ),
    ).toBe(true);
  });
});

describe("chatbotStatus", () => {
  it("maps undefined to 'Never deployed'", () => {
    expect(chatbotStatus(undefined)).toEqual({ label: "Never deployed", tone: "gray" });
  });

  it("maps succeeded to 'Online'", () => {
    expect(chatbotStatus(deploymentRow({ status: "succeeded" }))).toEqual({ label: "Online", tone: "green" });
  });

  it.each(["pending", "running"] as const)("maps '%s' to 'Deploying'", (status) => {
    expect(chatbotStatus(deploymentRow({ status }))).toEqual({ label: "Deploying", tone: "blue" });
  });

  it("maps failed to 'Failed'", () => {
    expect(chatbotStatus(deploymentRow({ status: "failed" }))).toEqual({ label: "Failed", tone: "red" });
  });
});

describe("buildAttentionItems", () => {
  it("returns one item per failed-latest-deploy tenant", () => {
    const latest = latestDeployByTenant([
      deployJoinRow({ id: "dep-fail", tenantId: "t1", status: "failed" }, "Failing Bot"),
      deployJoinRow({ id: "dep-ok", tenantId: "t2", status: "succeeded" }),
    ]);

    const items = buildAttentionItems(latest, []);

    expect(items).toEqual([
      {
        type: "failed-deploy",
        at: expect.any(Date),
        tenantId: "t1",
        tenantName: "Failing Bot",
        deploymentId: "dep-fail",
      },
    ]);
  });

  it("aggregates non-uploaded documents into a single item using the most recent one's date", () => {
    const docs = [
      docJoinRow({ id: "d1", status: "pending", createdAt: new Date("2026-01-01T00:00:00Z") }),
      docJoinRow({ id: "d2", status: "failed", createdAt: new Date("2026-01-03T00:00:00Z") }),
      docJoinRow({ id: "d3", status: "uploaded", createdAt: new Date("2026-01-05T00:00:00Z") }),
    ];

    const items = buildAttentionItems(new Map(), docs);

    expect(items).toEqual([{ type: "docs", at: new Date("2026-01-03T00:00:00Z"), count: 2 }]);
  });

  it("sorts failed deploys and the docs item together, newest first", () => {
    const latest = latestDeployByTenant([
      deployJoinRow({ id: "dep-fail", tenantId: "t1", status: "failed", startedAt: new Date("2026-01-01T00:00:00Z") }),
    ]);
    const docs = [docJoinRow({ status: "pending", createdAt: new Date("2026-01-05T00:00:00Z") })];

    const items = buildAttentionItems(latest, docs);

    expect(items.map((i) => i.type)).toEqual(["docs", "failed-deploy"]);
  });

  it("returns an empty array when nothing needs attention", () => {
    const latest = latestDeployByTenant([deployJoinRow({ status: "succeeded" })]);
    expect(buildAttentionItems(latest, [docJoinRow({ status: "uploaded" })])).toEqual([]);
  });
});

describe("buildActivity", () => {
  it("merges deploys and documents sorted newest first", () => {
    const deploys = [deployJoinRow({ id: "dep-1", startedAt: new Date("2026-01-01T00:00:00Z") })];
    const docs = [docJoinRow({ id: "doc-1", createdAt: new Date("2026-01-02T00:00:00Z") })];

    const activity = buildActivity(deploys, docs);

    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ kind: "document" });
    expect(activity[1]).toMatchObject({ kind: "deploy" });
  });
});

describe("computeDashboardStats", () => {
  it("aggregates counts and cost across tenants", () => {
    const tenants = [
      tenantRow({ id: "t1", cloudProvider: "aws", vectorStore: "pinecone" }),
      tenantRow({ id: "t2", cloudProvider: "azure", vectorStore: "pinecone" }),
    ];
    const latest = latestDeployByTenant([
      deployJoinRow({ tenantId: "t1", status: "succeeded" }),
      deployJoinRow({ tenantId: "t2", status: "running" }),
    ]);
    const docs = [docJoinRow({ status: "uploaded" }), docJoinRow({ status: "pending" })];

    const stats = computeDashboardStats(tenants, latest, docs);

    expect(stats).toMatchObject({
      totalChatbots: 2,
      onlineCount: 1,
      deployingCount: 1,
      awsCount: 1,
      azureCount: 1,
      totalDocs: 2,
      uploadedDocs: 1,
      pendingOrFailedDocsCount: 1,
    });
    expect(stats.costLow).toBeGreaterThan(0);
    expect(stats.costHigh).toBeGreaterThanOrEqual(stats.costLow);
  });
});

describe("computeGettingStartedSteps", () => {
  it("marks the first four steps done based on real account state, without a live chatbot URL", () => {
    const tenants = [tenantRow({ id: "t1", deploymentRoleArn: "arn:x", awsAccountId: "1" })];
    const deploys = [deployJoinRow({ tenantId: "t1", kind: "deploy", status: "succeeded" })];
    const docs = [docJoinRow()];

    const steps = computeGettingStartedSteps(tenants, deploys, docs);

    expect(steps.map((s) => ({ label: s.label, done: s.done }))).toEqual([
      { label: "Configure Cloud", done: true },
      { label: "Create Chatbot", done: true },
      { label: "Deploy", done: true },
      { label: "Upload Documents", done: true },
      { label: "Test Chatbot", done: false },
    ]);
    expect(steps.find((s) => s.label === "Test Chatbot")?.href).toBeUndefined();
  });

  it("marks 'Test Chatbot' done and links to it once a tenant has a live chatbotUrl", () => {
    const tenants = [tenantRow({ id: "t1", chatbotUrl: "https://acme.example.com" })];

    const steps = computeGettingStartedSteps(tenants, [], []);

    const testStep = steps.find((s) => s.label === "Test Chatbot");
    expect(testStep?.done).toBe(true);
    expect(testStep?.href).toBe("https://acme.example.com");
  });

  it("marks steps not done when there is no data yet", () => {
    const steps = computeGettingStartedSteps([], [], []);
    expect(steps.every((s) => s.done === false)).toBe(true);
  });
});

describe("computeChatbotsPageStats", () => {
  it("breaks tenants down by derived status and counts distinct clouds", () => {
    const tenants = [
      tenantRow({ id: "t1", cloudProvider: "aws" }),
      tenantRow({ id: "t2", cloudProvider: "azure" }),
      tenantRow({ id: "t3", cloudProvider: "aws" }),
      tenantRow({ id: "t4", cloudProvider: "aws" }),
    ];
    const latest = latestDeployByTenant([
      deployJoinRow({ tenantId: "t1", status: "succeeded" }),
      deployJoinRow({ tenantId: "t2", status: "running" }),
      deployJoinRow({ tenantId: "t3", status: "failed" }),
      // t4 has no deployment at all.
    ]);
    const docs = [docJoinRow({ status: "uploaded" }), docJoinRow({ status: "pending" })];

    const stats = computeChatbotsPageStats(tenants, latest, docs);

    expect(stats).toEqual({
      total: 4,
      cloudsInUse: 2,
      online: 1,
      onlinePct: 25,
      deploying: 1,
      failed: 1,
      totalDocs: 2,
      uploadedDocs: 1,
      pendingOrFailedDocs: 1,
    });
  });

  it("doesn't divide by zero when there are no tenants", () => {
    expect(computeChatbotsPageStats([], new Map(), []).onlinePct).toBe(0);
  });
});

describe("filterAndSortTenants", () => {
  const tenants = [
    tenantRow({ id: "t1", name: "Zeta Bot" }),
    tenantRow({ id: "t2", name: "Alpha Bot" }),
    tenantRow({ id: "t3", name: "Failing Bot" }),
  ];
  const latest = latestDeployByTenant([
    deployJoinRow({ tenantId: "t1", status: "succeeded", startedAt: new Date("2026-01-01T00:00:00Z") }),
    deployJoinRow({ tenantId: "t2", status: "running", startedAt: new Date("2026-01-03T00:00:00Z") }),
    deployJoinRow({ tenantId: "t3", status: "failed", startedAt: new Date("2026-01-02T00:00:00Z") }),
  ]);

  it("filters by derived status", () => {
    const result = filterAndSortTenants(tenants, latest, { status: "failed", sort: "name" });
    expect(result.map((t) => t.id)).toEqual(["t3"]);
  });

  it("passes everything through for status 'all'", () => {
    const result = filterAndSortTenants(tenants, latest, { status: "all", sort: "name" });
    expect(result).toHaveLength(3);
  });

  it("sorts by name", () => {
    const result = filterAndSortTenants(tenants, latest, { status: "all", sort: "name" });
    expect(result.map((t) => t.name)).toEqual(["Alpha Bot", "Failing Bot", "Zeta Bot"]);
  });

  it("sorts by last deployment, newest first, falling back to createdAt when never deployed", () => {
    const withUndeployed = [
      ...tenants,
      tenantRow({ id: "t4", name: "New Bot", createdAt: new Date("2026-01-05T00:00:00Z") }),
    ];
    const result = filterAndSortTenants(withUndeployed, latest, { status: "all", sort: "last-deployment" });
    expect(result.map((t) => t.id)).toEqual(["t4", "t2", "t3", "t1"]);
  });
});

describe("avatarInitials", () => {
  it("uses the first letter of the first two words for multi-word names", () => {
    expect(avatarInitials("Global Support Bot")).toBe("GS");
  });

  it("uses the first two characters for a single-word name", () => {
    expect(avatarInitials("Acme")).toBe("AC");
  });
});

describe("avatarTone", () => {
  it("is deterministic for the same tenant id", () => {
    expect(avatarTone("tenant-1")).toBe(avatarTone("tenant-1"));
  });
});
