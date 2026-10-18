import { afterEach, describe, expect, it, vi } from "vitest";
import { WebToolsError } from "../src/errors.ts";
import { firecrawlScrapeEndpoint, isCustomFirecrawlEndpoint, autoFetch, probeCamoufox, renderedFetch, runCamoufoxBridge } from "../src/fetch/rendered.ts";

const GUARD = { allowLocalNetworks: true, rawBodyMaxBytes: 32 * 1024 * 1024 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firecrawl client", () => {
  const opts = {
    ...GUARD,
    renderer: "firecrawl" as const,
    bridgeScript: undefined as string | undefined,
    firecrawlApiKey: "fc-key",
    python: "python3",
    maxChars: 65536,
    timeoutMs: 2000,
  };

  it("caps multibyte markdown without splitting a character", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { markdown: "界😀x" } })));
    const result = await renderedFetch("http://127.0.0.1/", { ...opts, maxChars: 2 });
    expect(result.markdown).toBe("界😀");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(8);
    expect(result.warning).toContain("3 characters; returning the first 2 characters");
  });

  it("posts to the scrape endpoint and maps markdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.firecrawl.dev/v2/scrape"); // cloud default when no base URL is configured
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer fc-key");
        const body = JSON.parse(String(init.body));
        expect(body.formats).toContain("markdown");
        return Response.json({ data: { markdown: "# Rendered page", metadata: { title: "T", sourceURL: "https://example.com" } } });
      }),
    );
    const result = await renderedFetch("https://example.com", opts);
    expect(result.tier).toBe("rendered");
    expect(result.provider).toBe("firecrawl");
    expect(result.markdown).toContain("Rendered page");
    expect(result.warning).toMatch(/third-party/); // remote egress caveat
  });

  it("targets a configured local server, normalizing trailing slashes", async () => {
    for (const [base, expected] of [
      ["http://localhost:3002", "http://localhost:3002/v2/scrape"],
      ["http://localhost:3002/", "http://localhost:3002/v2/scrape"],
      ["http://localhost:3002///", "http://localhost:3002/v2/scrape"],
      ["http://127.0.0.1:3002/fc", "http://127.0.0.1:3002/fc/v2/scrape"],
    ] as const) {
      const seen: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          seen.push(url);
          return Response.json({ data: { markdown: "# ok" } });
        }),
      );
      const result = await renderedFetch("https://example.com", { ...opts, firecrawlBaseUrl: base });
      expect(result.markdown).toContain("ok");
      expect(seen).toEqual([expected]);
    }
    expect(firecrawlScrapeEndpoint("http://h/")).toBe("http://h/v2/scrape");
    expect(firecrawlScrapeEndpoint(undefined)).toBe("https://api.firecrawl.dev/v2/scrape");
  });

  it("maps 402 to E_QUOTA_EXHAUSTED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("payment", { status: 402 })));
    await expect(renderedFetch("https://example.com", opts)).rejects.toMatchObject({ code: "E_QUOTA_EXHAUSTED" });
  });

  it("maps 429 to E_RATE_LIMIT", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate", { status: 429 })));
    await expect(renderedFetch("https://example.com", opts)).rejects.toMatchObject({ code: "E_RATE_LIMIT" });
  });

  it("allows a keyless request against a custom (self-hosted) endpoint and omits the Authorization header", async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return Response.json({ data: { markdown: "# keyless ok" } });
      }),
    );
    const result = await renderedFetch("https://example.com", { ...opts, firecrawlApiKey: undefined, firecrawlBaseUrl: "http://localhost:3002" });
    expect(result.markdown).toContain("keyless ok");
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!)).not.toContain("authorization"); // no empty/invalid auth header for keyless servers
  });

  it("still requires a key for the hosted cloud endpoint, even when an explicit base URL points back at the cloud", async () => {
    await expect(renderedFetch("https://example.com", { ...opts, firecrawlApiKey: undefined })).rejects.toMatchObject({ code: "E_RENDERER_UNAVAILABLE" });
    await expect(
      renderedFetch("https://example.com", { ...opts, firecrawlApiKey: undefined, firecrawlBaseUrl: "https://api.firecrawl.dev/" }),
    ).rejects.toMatchObject({ code: "E_RENDERER_UNAVAILABLE" });
  });

  it("treats cloud host variants as hosted regardless of scheme or case (still requires a key)", async () => {
    expect(isCustomFirecrawlEndpoint("https://API.FIRECRAWL.DEV")).toBe(false);
    expect(isCustomFirecrawlEndpoint("https://Api.Firecrawl.dev")).toBe(false);
    expect(isCustomFirecrawlEndpoint("https://api.firecrawl.dev:443")).toBe(false);
    expect(isCustomFirecrawlEndpoint("http://api.firecrawl.dev")).toBe(false);
    expect(isCustomFirecrawlEndpoint("http://API.FIRECRAWL.DEV")).toBe(false);
    expect(isCustomFirecrawlEndpoint("http://localhost:3002")).toBe(true);
    expect(isCustomFirecrawlEndpoint(undefined)).toBe(false);
    expect(isCustomFirecrawlEndpoint("")).toBe(false);
    await expect(
      renderedFetch("https://example.com", { ...opts, firecrawlApiKey: undefined, firecrawlBaseUrl: "https://API.FIRECRAWL.DEV" }),
    ).rejects.toMatchObject({ code: "E_RENDERER_UNAVAILABLE" });
    await expect(
      renderedFetch("https://example.com", { ...opts, firecrawlApiKey: undefined, firecrawlBaseUrl: "http://api.firecrawl.dev" }),
    ).rejects.toMatchObject({ code: "E_RENDERER_UNAVAILABLE" });
  });

  it("sends a Bearer key to a custom endpoint when one is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer fc-key");
        return Response.json({ data: { markdown: "# keyed ok" } });
      }),
    );
    const result = await renderedFetch("https://example.com", { ...opts, firecrawlBaseUrl: "http://localhost:3002" });
    expect(result.markdown).toContain("keyed ok");
  });

  it("throws E_RENDERER_UNAVAILABLE without a key on the cloud default", async () => {
    await expect(renderedFetch("https://example.com", { ...opts, firecrawlApiKey: undefined })).rejects.toMatchObject({ code: "E_RENDERER_UNAVAILABLE" });
  });

  it("rejects SSRF targets before calling the remote service", async () => {
    await expect(renderedFetch("http://127.0.0.1:9000/", { ...opts, allowLocalNetworks: false })).rejects.toMatchObject({ code: "E_SSRF_BLOCKED" });
  });
});

describe("tier=auto escalation", () => {
  it("escalates at most once and degrades gracefully when no renderer exists", async () => {
    // autoFetch with an SPA served locally + no camoufox/firecrawl → light result with renderingUnavailable.
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><html><body><div id="root"></div></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    try {
      const result = await autoFetch(`http://127.0.0.1:${addr.port}/`, {
        ...GUARD,
        renderer: "camoufox",
        python: "definitely-not-a-real-python-binary",
        maxChars: 65536,
        timeoutMs: 2000,
      });
      expect(result.tier).toBe("light");
      expect(result.needsRendering).toBe(true);
      expect(result.renderingUnavailable).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not escalate on SSRF/unsupported errors", async () => {
    await expect(
      autoFetch("file:///etc/passwd", { ...GUARD, renderer: "firecrawl", firecrawlApiKey: "k", python: "python3", maxChars: 1000, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "E_INJECTION_GUARD" });
  });
});

describe("camoufox probe + bridge", () => {
  it.each([
    ["escaped", "界".repeat(600)],
    ["utf8", "界".repeat(600)],
  ])("accepts HTML within the byte cap over %s JSON transport", async (mode, html) => {
    const result = await runCamoufoxBridge(mode, {
      ...GUARD, renderer: "camoufox", python: "python3",
      bridgeScript: "test/fixtures/size-bridge.py", rawBodyMaxBytes: 2000,
      maxChars: 1000, timeoutMs: 2000,
    });
    expect(result.html).toBe(html);
  });

  it.each(["html-overflow", "transport-overflow"])("rejects %s independently", async (mode) => {
    await expect(runCamoufoxBridge(mode, {
      ...GUARD, renderer: "camoufox", python: "python3",
      bridgeScript: "test/fixtures/size-bridge.py", rawBodyMaxBytes: 2000,
      maxChars: 1000, timeoutMs: 2000,
    })).rejects.toMatchObject({ code: "E_RAW_TOO_LARGE" });
  });

  it("caps Camoufox extracted output by characters", async () => {
    const result = await renderedFetch("http://127.0.0.1/", {
      ...GUARD, renderer: "camoufox", python: process.execPath,
      bridgeScript: "test/fixtures/unicode-bridge.cjs", maxChars: 2, timeoutMs: 2000,
    });
    expect(result.markdown).toBe("界😀");
    expect(result.truncated).toBe(true);
    expect(result.warning).toContain("returning the first 2 characters");
  });

  it("probe returns a boolean without throwing", async () => {
    const ok = await probeCamoufox("python3");
    expect(typeof ok).toBe("boolean");
  });

  it("probe fails fast for a missing interpreter", async () => {
    expect(await probeCamoufox("no-such-python")).toBe(false);
  });

  it("bridge rejects with E_RENDERER_UNAVAILABLE when the interpreter is missing", async () => {
    await expect(
      runCamoufoxBridge("https://example.com", { ...GUARD, renderer: "camoufox", python: "no-such-python", maxChars: 1000, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "E_RENDERER_UNAVAILABLE" });
  });

  it("bridge cleanup: abort kills the child process (no orphan)", async () => {
    // Use a python script that sleeps long enough to be killed mid-flight.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pwt-test-"));
    const script = join(dir, "slow_bridge.py");
    writeFileSync(script, "import time, sys\ntime.sleep(30)\n");
    const controller = new AbortController();
    const opts = { ...GUARD, renderer: "camoufox" as const, python: "python3", bridgeScript: script, maxChars: 1000, timeoutMs: 30_000, signal: controller.signal };
    const p = runCamoufoxBridge("https://example.com", opts);
    setTimeout(() => controller.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: "E_CANCELLED" });
  });

  it("bridge output over the raw-response safety cap rejects with E_RAW_TOO_LARGE", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pwt-test-"));
    const script = join(dir, "bomb_bridge.py");
    writeFileSync(script, "import sys\nsys.stdout.write('A' * (7 * 1024 * 1024))\n");
    const opts = { ...GUARD, renderer: "camoufox" as const, python: "python3", bridgeScript: script, rawBodyMaxBytes: 1024 * 1024, maxChars: 1000, timeoutMs: 30_000 };
    await expect(runCamoufoxBridge("https://example.com", opts)).rejects.toMatchObject({ code: "E_RAW_TOO_LARGE" });
  });

  it("autoFetch does not escalate to the rendered tier on E_RAW_TOO_LARGE", async () => {
    // A raw-safety overflow from the light tier must rethrow rather than
    // escalate: the rendered tier would hit the same safety limit.
    const { createServer } = await import("node:http");
    const { gzipSync } = await import("node:zlib");
    const server = createServer((_req, res) => {
      const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024, 0));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": String(bomb.length) });
      res.end(bomb);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    try {
      await expect(
        autoFetch(`http://127.0.0.1:${addr.port}/`, {
          ...GUARD,
          renderer: "camoufox",
          python: "python3",
          rawBodyMaxBytes: 32 * 1024 * 1024,
          maxChars: 65536,
          timeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ code: "E_RAW_TOO_LARGE" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
