import { describe, it, expect, beforeEach, vi } from "vitest";
import { triggerReindex, docsBucketName } from "./reindex";

describe("docsBucketName", () => {
  it("uses the stored bucket when there is one", () => {
    expect(docsBucketName({ slug: "acme-co", s3DocsBucket: "custom-bucket" })).toBe("custom-bucket");
  });

  // s3DocsBucket is null for every real tenant: the column exists but nothing
  // writes to it. Without this fallback a reindex posts "bucket": null and the
  // chatbot backend answers 500.
  it("derives Terraform's name when the column is null, as it always is", () => {
    expect(docsBucketName({ slug: "acme-co", s3DocsBucket: null })).toBe("chatbot-acme-co-docs");
  });
});

describe("triggerReindex", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("never sends a null bucket, even when the column is unset", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await triggerReindex({
      slug: "acme-co",
      chatbotUrl: "http://chatbot-acme-co.us-east-1.elb.amazonaws.com",
      s3DocsBucket: null,
      s3DocsPrefix: null,
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      tenant_id: "acme-co",
      bucket: "chatbot-acme-co-docs",
      prefix: "",
    });
  });

  it("returns ok:false without calling fetch when the tenant has no chatbotUrl", async () => {
    const result = await triggerReindex({
      slug: "acme-co",
      chatbotUrl: null,
      s3DocsBucket: "chatbot-acme-co-docs",
      s3DocsPrefix: "docs/",
    });

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/deploy has not completed/) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("POSTs tenant_id (slug), bucket, and prefix to {chatbotUrl}/api/index", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await triggerReindex({
      slug: "acme-co",
      chatbotUrl: "http://chatbot-acme-co.us-east-1.elb.amazonaws.com",
      s3DocsBucket: "chatbot-acme-co-docs",
      s3DocsPrefix: "docs/",
    });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://chatbot-acme-co.us-east-1.elb.amazonaws.com/api/index");
    expect(JSON.parse(init.body)).toEqual({
      tenant_id: "acme-co",
      bucket: "chatbot-acme-co-docs",
      prefix: "docs/",
    });
  });

  it("defaults prefix to an empty string when s3DocsPrefix is null", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await triggerReindex({
      slug: "acme-co",
      chatbotUrl: "http://chatbot.example.com",
      s3DocsBucket: "chatbot-acme-co-docs",
      s3DocsPrefix: null,
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body).prefix).toBe("");
  });

  it("returns ok:true on a 2xx response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const result = await triggerReindex({
      slug: "acme-co",
      chatbotUrl: "http://chatbot.example.com",
      s3DocsBucket: "b",
      s3DocsPrefix: "",
    });

    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false with the status code when the backend responds with an error", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 502 });

    const result = await triggerReindex({
      slug: "acme-co",
      chatbotUrl: "http://chatbot.example.com",
      s3DocsBucket: "b",
      s3DocsPrefix: "",
    });

    expect(result).toEqual({ ok: false, error: "Reindex endpoint returned 502" });
  });

  it("returns ok:false with the error message when fetch itself rejects (network error)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fetch failed"));

    const result = await triggerReindex({
      slug: "acme-co",
      chatbotUrl: "http://chatbot.example.com",
      s3DocsBucket: "b",
      s3DocsPrefix: "",
    });

    expect(result).toEqual({ ok: false, error: "fetch failed" });
  });
});
