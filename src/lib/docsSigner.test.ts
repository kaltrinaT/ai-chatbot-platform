import { describe, it, expect, beforeEach, vi } from "vitest";

const { decryptSecret } = vi.hoisted(() => ({
  decryptSecret: vi.fn((blob: string) => `decrypted:${blob}`),
}));

vi.mock("@/lib/crypto", () => ({ decryptSecret }));

import {
  acceptDocsSignerUrl,
  callDocsSigner,
  deleteViaSigner,
  docsSignerUrlProblem,
  presignUpload,
} from "./docsSigner";

const identity = { cloudProvider: "aws" as const, slug: "acme", awsRegion: "us-east-1" };

const tenant = {
  ...identity,
  docsSignerUrl: "https://abc123.lambda-url.us-east-1.on.aws/",
  docsSignerSecretEncrypted: "iv:tag:ct",
};

describe("docsSignerUrlProblem", () => {
  const azure = { cloudProvider: "azure" as const, slug: "acme", awsRegion: null };

  // Exactly what production stores, read from the live database.
  it.each([
    [identity, "https://nosvvotqvsapojf6sakh4u675i0yrxdf.lambda-url.us-east-1.on.aws/"],
    [azure, "https://chatbot-acme-docs-signer.azurewebsites.net/api/docs-signer"],
  ])("accepts the URL Terraform builds (%#)", (who, url) => {
    expect(docsSignerUrlProblem(who, url)).toBeNull();
  });

  it.each([
    "https://attacker.example/",
    "http://abc.lambda-url.us-east-1.on.aws/",
    "https://abc.lambda-url.eu-west-1.on.aws/",
    "https://abc.lambda-url.us-east-1.on.aws.attacker.example/",
    "https://abc.lambda-url.us-east-1.on.aws/elsewhere",
    "https://user:pw@abc.lambda-url.us-east-1.on.aws/",
    "https://abc.lambda-url.us-east-1.on.aws:8443/",
    "not a url",
  ])("refuses %s for an AWS tenant in us-east-1", (url) => {
    expect(docsSignerUrlProblem(identity, url)).not.toBeNull();
  });

  it.each([
    "https://chatbot-other-docs-signer.azurewebsites.net/api/docs-signer",
    "https://chatbot-acme-docs-signer.azurewebsites.net/api/other",
    "https://chatbot-acme-docs-signer.azurewebsites.net.attacker.example/api/docs-signer",
  ])("refuses %s for Azure tenant acme", (url) => {
    expect(docsSignerUrlProblem(azure, url)).not.toBeNull();
  });
});

describe("acceptDocsSignerUrl", () => {
  const url = "https://abc123.lambda-url.us-east-1.on.aws/";

  it("accepts a first URL of the right shape", () => {
    expect(acceptDocsSignerUrl({ ...identity, docsSignerUrl: null }, url)).toBeNull();
  });

  it("accepts the recorded URL again", () => {
    expect(acceptDocsSignerUrl({ ...identity, docsSignerUrl: url }, url)).toBeNull();
  });

  // The shape alone admits anyone's Lambda in the region; the pin does not.
  it("refuses to replace the recorded URL, even with a well-formed one", () => {
    const other = "https://zzz999.lambda-url.us-east-1.on.aws/";
    expect(acceptDocsSignerUrl({ ...identity, docsSignerUrl: url }, other)).toMatch(/already on record/);
  });
});

describe("callDocsSigner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decryptSecret.mockImplementation((blob: string) => `decrypted:${blob}`);
    global.fetch = vi.fn();
  });

  it("throws without calling fetch when the tenant has no docsSignerUrl", async () => {
    await expect(
      callDocsSigner(
        { ...identity, docsSignerUrl: null, docsSignerSecretEncrypted: "iv:tag:ct" },
        { action: "delete", objectKey: "docs/x" },
      ),
    ).rejects.toThrow(/deploy has not completed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws without calling fetch when the tenant has no docsSignerSecretEncrypted", async () => {
    await expect(
      callDocsSigner(
        { ...identity, docsSignerUrl: tenant.docsSignerUrl, docsSignerSecretEncrypted: null },
        { action: "delete", objectKey: "docs/x" },
      ),
    ).rejects.toThrow(/deploy has not completed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  // The last line of defence: whatever is stored, the secret only ever goes
  // to a URL that is this tenant's signer.
  it("never sends the secret to a URL that is not the tenant's signer", async () => {
    await expect(
      callDocsSigner(
        { ...tenant, docsSignerUrl: "https://attacker.example/collect" },
        { action: "delete", objectKey: "docs/x" },
      ),
    ).rejects.toThrow(/Refusing to send the docs-signer secret/);
    expect(fetch).not.toHaveBeenCalled();
    expect(decryptSecret).not.toHaveBeenCalled();
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

  it("round-trips an Azure-shaped response (no fields — a single SAS URL, not a presigned-POST)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ objectKey: "docs/uuid-file.pdf", url: "https://acct.blob.core.windows.net/documents/docs/uuid-file.pdf?sv=..." }),
    });

    const result = await presignUpload(tenant, {
      fileName: "file.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
    });

    expect(result.objectKey).toBe("docs/uuid-file.pdf");
    expect(result.fields).toBeUndefined();
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
