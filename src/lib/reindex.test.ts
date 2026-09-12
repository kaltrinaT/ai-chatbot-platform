import { describe, it, expect, beforeEach, vi } from "vitest";
import { triggerReindex, docsBucketName, controlPlaneUrl } from "./reindex";

describe("controlPlaneUrl", () => {
  it("bypasses the CDN, whose 60s origin cap is below the 120s a reindex is allowed", () => {
    expect(
      controlPlaneUrl({
        chatbotUrl: "https://d111111abcdef8.cloudfront.net",
        albDnsName: "chatbot-acme-co-123.us-east-1.elb.amazonaws.com",
      }),
    ).toBe("http://chatbot-acme-co-123.us-east-1.elb.amazonaws.com");
  });

  it("keeps using the tenant's own HTTPS endpoint when it terminates TLS itself", () => {
    expect(
      controlPlaneUrl({
        chatbotUrl: "https://chat.acme.com",
        albDnsName: "chatbot-acme-co-123.us-east-1.elb.amazonaws.com",
      }),
    ).toBe("https://chat.acme.com");
  });

  it("falls back to the chatbot URL when there is no load balancer to address, as on Azure", () => {
    expect(
      controlPlaneUrl({
        chatbotUrl: "https://chatbot-beta.azurecontainerapps.io",
        albDnsName: null,
      }),
    ).toBe("https://chatbot-beta.azurecontainerapps.io");
  });
});

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

const tenant = () => ({
  slug: "acme-co",
  chatbotUrl: "http://chatbot.example.com",
  s3DocsBucket: "b",
  s3DocsPrefix: "",
});

describe("triggerReindex", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    // The failure path logs the real error; keep it out of the test output.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("posts to the load balancer, not the CDN, for a CloudFront-fronted tenant", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await triggerReindex({
      slug: "acme-co",
      chatbotUrl: "https://d111111abcdef8.cloudfront.net",
      albDnsName: "chatbot-acme-co-123.us-east-1.elb.amazonaws.com",
      s3DocsBucket: null,
      s3DocsPrefix: null,
    });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://chatbot-acme-co-123.us-east-1.elb.amazonaws.com/api/index");
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

  it("returns the status code and the backend's own explanation", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '{"detail":"Configuration error: ids[0] must be a string"}',
    });

    const result = await triggerReindex(tenant());

    // The body is where the backend says what went wrong. Reporting only the
    // status number sent us chasing the wrong layer for hours.
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("Configuration error: ids[0] must be a string"),
    });
    expect((result as { error: string }).error).toContain("500");
  });

  it("still reports the status when the error body cannot be read", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => {
        throw new Error("stream consumed");
      },
    });

    expect(await triggerReindex(tenant())).toEqual({
      ok: false,
      error: "Reindex endpoint returned 502",
    });
  });

  // Node reports every transport-level problem as the bare string "fetch
  // failed" and puts the reason in `cause`. Surfacing only the message told
  // the operator nothing at all.
  it("unwraps the cause instead of reporting a bare 'fetch failed'", async () => {
    const err = new Error("fetch failed");
    err.cause = Object.assign(new Error("getaddrinfo ENOTFOUND chatbot.example.com"), {
      code: "ENOTFOUND",
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const result = await triggerReindex(tenant());

    expect(result).toEqual({ ok: false, error: expect.stringContaining("ENOTFOUND") });
    expect((result as { error: string }).error).not.toBe("fetch failed");
  });

  it("names a timeout as a timeout, since the backend may still be working", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const result = await triggerReindex(tenant());

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/did not finish within 120s/) });
  });
});
