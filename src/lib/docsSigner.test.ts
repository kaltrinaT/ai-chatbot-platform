import { describe, it, expect, beforeEach, vi } from "vitest";

const { decryptSecret } = vi.hoisted(() => ({
  decryptSecret: vi.fn((blob: string) => `decrypted:${blob}`),
}));

vi.mock("@/lib/crypto", () => ({ decryptSecret }));

import { callDocsSigner, presignUpload, deleteViaSigner } from "./docsSigner";

const tenant = {
  docsSignerUrl: "https://abc123.lambda-url.us-east-1.on.aws/",
  docsSignerSecretEncrypted: "iv:tag:ct",
};

describe("callDocsSigner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decryptSecret.mockImplementation((blob: string) => `decrypted:${blob}`);
    global.fetch = vi.fn();
  });

  it("throws without calling fetch when the tenant has no docsSignerUrl", async () => {
    await expect(
      callDocsSigner(
        { docsSignerUrl: null, docsSignerSecretEncrypted: "iv:tag:ct" },
        { action: "delete", objectKey: "docs/x" },
      ),
    ).rejects.toThrow(/deploy has not completed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws without calling fetch when the tenant has no docsSignerSecretEncrypted", async () => {
    await expect(
      callDocsSigner(
        { docsSignerUrl: tenant.docsSignerUrl, docsSignerSecretEncrypted: null },
        { action: "delete", objectKey: "docs/x" },
      ),
    ).rejects.toThrow(/deploy has not completed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("POSTs the decrypted secret as a header and the body as JSON", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await callDocsSigner(tenant, { action: "delete", objectKey: "docs/x" });

    expect(decryptSecret).toHaveBeenCalledWith("iv:tag:ct");
    expect(fetch).toHaveBeenCalledWith(
      tenant.docsSignerUrl,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-docs-signer-secret": "decrypted:iv:tag:ct",
        }),
        body: JSON.stringify({ action: "delete", objectKey: "docs/x" }),
      }),
    );
  });

  it("returns the parsed JSON response on success", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ objectKey: "docs/uuid-file.pdf", url: "https://s3...", fields: {} }),
    });

    const result = await callDocsSigner(tenant, {
      action: "presign-upload",
      fileName: "file.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
    });

    expect(result).toEqual({ objectKey: "docs/uuid-file.pdf", url: "https://s3...", fields: {} });
  });

  it("throws with the status code and body text when the response is not ok", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });

    await expect(
      callDocsSigner(tenant, { action: "delete", objectKey: "docs/x" }),
    ).rejects.toThrow(/docs-signer returned 401: unauthorized/);
  });

  it("still throws a useful error when reading the error body itself fails", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("stream already consumed");
      },
    });

    await expect(
      callDocsSigner(tenant, { action: "delete", objectKey: "docs/x" }),
    ).rejects.toThrow(/docs-signer returned 500/);
  });
});

describe("presignUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decryptSecret.mockImplementation((blob: string) => `decrypted:${blob}`);
    global.fetch = vi.fn();
  });

  it("sends a presign-upload action with the given file metadata", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ objectKey: "docs/uuid-file.pdf", url: "https://s3...", fields: { key: "x" } }),
    });

    const result = await presignUpload(tenant, {
      fileName: "file.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
    });

    expect(result.objectKey).toBe("docs/uuid-file.pdf");
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      action: "presign-upload",
      fileName: "file.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
    });
  });
});

describe("deleteViaSigner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decryptSecret.mockImplementation((blob: string) => `decrypted:${blob}`);
    global.fetch = vi.fn();
  });

  it("sends a delete action with the given objectKey", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await deleteViaSigner(tenant, "docs/uuid-file.pdf");

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ action: "delete", objectKey: "docs/uuid-file.pdf" });
  });

  it("propagates a failure from the signer", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "objectKey outside configured prefix",
    });

    await expect(deleteViaSigner(tenant, "other-tenant/x")).rejects.toThrow(
      /objectKey outside configured prefix/,
    );
  });
});
