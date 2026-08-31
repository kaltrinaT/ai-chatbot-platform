import { describe, it, expect, beforeEach, vi } from "vitest";
import { selectWhereChain } from "@/test/db-chains";
import { buildFormData } from "@/test/form-data";

const { authMock, dbSelectWhere, triggerDeployment, triggerTenantDestroy, revalidatePath } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    dbSelectWhere: vi.fn(),
    triggerDeployment: vi.fn(),
    triggerTenantDestroy: vi.fn(),
    revalidatePath: vi.fn(),
  }));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/db", () => ({
  db: { select: vi.fn(() => selectWhereChain(dbSelectWhere)) },
}));
vi.mock("@/lib/deploy", () => ({ triggerDeployment, triggerTenantDestroy }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { redeployTenant, deleteTenant } from "./actions";

function formData(tenantId: string | undefined) {
  return buildFormData({ tenantId });
}

const tenantRow = {
  id: "tenant-1",
  ownerUserId: "user-1",
  chatbotVersion: "v1.2.3",
};

describe("redeployTenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbSelectWhere.mockResolvedValue([tenantRow]);
    triggerDeployment.mockResolvedValue({ id: "deploy-1" });
  });

  it("throws when there is no authenticated session", async () => {
    authMock.mockResolvedValue(null);

    await expect(redeployTenant(formData("tenant-1"))).rejects.toThrow("Not authenticated");
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it("throws 'Tenant not found' when the query returns nothing (wrong owner or missing tenant)", async () => {
    dbSelectWhere.mockResolvedValue([]);

    await expect(redeployTenant(formData("tenant-1"))).rejects.toThrow("Tenant not found");
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it("treats a missing tenantId field as an empty string rather than throwing on formData.get", async () => {
    dbSelectWhere.mockResolvedValue([]);

    await expect(redeployTenant(formData(undefined))).rejects.toThrow("Tenant not found");
  });

  it("triggers a redeploy with the tenant's existing chatbotVersion and the session user", async () => {
    await redeployTenant(formData("tenant-1"));

    expect(triggerDeployment).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      chatbotVersion: "v1.2.3",
      triggeredByUserId: "user-1",
    });
  });

  it("revalidates the tenant's page path after triggering the deployment", async () => {
    await redeployTenant(formData("tenant-1"));

    expect(revalidatePath).toHaveBeenCalledWith("/tenants/tenant-1");
    expect(triggerDeployment.mock.invocationCallOrder[0]).toBeLessThan(
      revalidatePath.mock.invocationCallOrder[0],
    );
  });

  it("does not revalidate when triggerDeployment throws", async () => {
    triggerDeployment.mockRejectedValue(new Error("dispatch failed"));

    await expect(redeployTenant(formData("tenant-1"))).rejects.toThrow("dispatch failed");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deleteTenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbSelectWhere.mockResolvedValue([tenantRow]);
    triggerTenantDestroy.mockResolvedValue({ id: "destroy-1" });
  });

  it("throws when there is no authenticated session", async () => {
    authMock.mockResolvedValue(null);

    await expect(deleteTenant(formData("tenant-1"))).rejects.toThrow("Not authenticated");
    expect(triggerTenantDestroy).not.toHaveBeenCalled();
  });

  it("throws 'Tenant not found' when the query returns nothing (wrong owner, missing, or already deleted)", async () => {
    dbSelectWhere.mockResolvedValue([]);

    await expect(deleteTenant(formData("tenant-1"))).rejects.toThrow("Tenant not found");
    expect(triggerTenantDestroy).not.toHaveBeenCalled();
  });

  it("triggers tenant destroy for the session user", async () => {
    await deleteTenant(formData("tenant-1"));

    expect(triggerTenantDestroy).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      triggeredByUserId: "user-1",
    });
  });

  it("revalidates both the tenant page and the dashboard after triggering destroy", async () => {
    await deleteTenant(formData("tenant-1"));

    expect(revalidatePath).toHaveBeenCalledWith("/tenants/tenant-1");
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("does not revalidate when triggerTenantDestroy throws", async () => {
    triggerTenantDestroy.mockRejectedValue(new Error("dispatch failed"));

    await expect(deleteTenant(formData("tenant-1"))).rejects.toThrow("dispatch failed");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
