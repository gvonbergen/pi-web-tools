import { afterEach, describe, expect, it, vi } from "vitest";
import { WebToolsError } from "../src/errors.ts";
import { backoffDelay, providerRequest } from "../src/providers/http.ts";
import { BraveAdapter } from "../src/providers/brave.ts";
import { SerperAdapter } from "../src/providers/serper.ts";
import { WebToolsCore } from "../src/registry.ts";

const baseOpts = {
  provider: "serper" as const,
  apiSecret: "test-key",
  timeoutMs: 2000,
  backoffBaseMs: 1,
};

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => handler(String(url), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("providerRequest: error mapping", () => {
  it("maps 401 to E_INVALID_KEY and does not retry", async () => {
    const f = mockFetch(() => new Response("unauthorized", { status: 401 }));
    await expect(providerRequest("https://x.example", { method: "POST" }, baseOpts)).rejects.toMatchObject({ code: "E_INVALID_KEY" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("maps 400 to E_BAD_REQUEST", async () => {
    mockFetch(() => new Response("bad", { status: 400 }));
    await expect(providerRequest("https://x.example", { method: "POST" }, baseOpts)).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
  });

  it("retries 429 with backoff then succeeds", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return calls === 1 ? new Response("rate", { status: 429 }) : Response.json({ ok: true });
    });
    const res = await providerRequest("https://x.example", { method: "GET" }, baseOpts);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("retries 5xx up to maxTries then throws E_UPSTREAM", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    await expect(providerRequest("https://x.example", { method: "GET" }, { ...baseOpts, maxTries: 3 })).rejects.toMatchObject({ code: "E_UPSTREAM" });
  });

  it("honors Retry-After header (capped)", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return calls === 1 ? new Response("rate", { status: 429, headers: { "retry-after": "0" } }) : Response.json({ ok: true });
    });
    const start = Date.now();
    await providerRequest("https://x.example", { method: "GET" }, baseOpts);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("serper adapter", () => {
  it("sends POST with X-API-KEY and 1-based page", async () => {
    const f = mockFetch((_url, init) => {
      expect((init.headers as Record<string, string>)["X-API-KEY"]).toBe("k");
      expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      const body = JSON.parse(String(init.body));
      expect(body.page).toBe(2); // page 1 (0-based) → 2 (serper)
      return Response.json({ organic: [{ title: "t", link: "https://a.example" }] });
    });
    const adapter = new SerperAdapter("k");
    const out = await adapter.search("web", { query: "q", num: 8, page: 1, safesearch: "moderate" }, { timeoutMs: 1000 });
    expect(out.results[0]?.url).toBe("https://a.example");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("surfaces E_QUOTA_EXHAUSTED for persistent 429", async () => {
    mockFetch(() => new Response("rate", { status: 429 }));
    const adapter = new SerperAdapter("k");
    await expect(adapter.search("web", { query: "q", num: 8, page: 0, safesearch: "moderate" }, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "E_QUOTA_EXHAUSTED" });
  });

  it("flags the 2-credit cost note for images num>10", async () => {
    mockFetch(() => Response.json({ images: [] }));
    const adapter = new SerperAdapter("k");
    const out = await adapter.search("images", { query: "q", num: 20, page: 0, safesearch: "strict" }, { timeoutMs: 1000 });
    expect(out.costNote).toMatch(/2 credits/);
  });

  it("throws E_NO_PROVIDER without a key", async () => {
    const adapter = new SerperAdapter(undefined);
    await expect(adapter.search("web", { query: "q", num: 1, page: 0, safesearch: "moderate" }, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "E_NO_PROVIDER" });
  });
});

describe("brave adapter", () => {
  it("sends GET with X-Subscription-Token and count/offset", async () => {
    const f = mockFetch((url, init) => {
      expect((init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("k");
      expect(String(url)).toContain("count=8");
      expect(String(url)).toContain("offset=8"); // page 1 * 8
      expect(String(url)).toContain("safesearch=moderate");
      return Response.json({ web: { results: [{ title: "t", url: "https://b.example" }] } });
    });
    const adapter = new BraveAdapter("k");
    const out = await adapter.search("web", { query: "q", num: 8, page: 1, safesearch: "moderate" }, { timeoutMs: 1000 });
    expect(out.results[0]?.url).toBe("https://b.example");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("caps offset at 9 for deep pagination", async () => {
    mockFetch((url) => {
      expect(String(url)).toContain("offset=9");
      return Response.json({ web: { results: [] } });
    });
    const adapter = new BraveAdapter("k");
    await adapter.search("web", { query: "q", num: 10, page: 4, safesearch: "moderate" }, { timeoutMs: 1000 });
  });

  it("maps strict safesearch for images", async () => {
    mockFetch((url) => {
      expect(String(url)).toContain("safesearch=strict");
      return Response.json({ images: { results: [] } });
    });
    const adapter = new BraveAdapter("k");
    await adapter.search("images", { query: "q", num: 5, page: 0, safesearch: "moderate" }, { timeoutMs: 1000 });
  });
});

describe("WebToolsCore: caching, cost caps, provider resolution", () => {
  function coreWith(overrides: Record<string, string> = {}) {
    const cfgEnv = { SERPER_API_KEY: "s", BRAVE_API_KEY: "b", ...overrides };
    const { loadConfig } = require("../src/config.ts") as typeof import("../src/config.ts");
    return new WebToolsCore(loadConfig(cfgEnv as unknown as NodeJS.ProcessEnv));
  }

  it("caches identical searches and honors bypassCache", async () => {
    const core = coreWith();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return Response.json({ organic: [] });
      }),
    );
    const opts = { timeoutMs: 1000 };
    await core.search("web", { query: "same", num: 8, page: 0, safesearch: "moderate" }, opts);
    await core.search("web", { query: "same", num: 8, page: 0, safesearch: "moderate" }, opts);
    expect(calls).toBe(1);
    await core.search("web", { query: "same", num: 8, page: 0, safesearch: "moderate" }, { ...opts, bypassCache: true });
    expect(calls).toBe(2);
  });

  it("throws E_NO_PROVIDER when nothing configured", () => {
    const { loadConfig } = require("../src/config.ts") as typeof import("../src/config.ts");
    const core = new WebToolsCore(loadConfig({} as unknown as NodeJS.ProcessEnv));
    let code: string | undefined;
    try {
      core.resolveProvider();
    } catch (err) {
      code = (err as WebToolsError).code;
    }
    expect(code).toBe("E_NO_PROVIDER");
  });

  it("throws E_PROVIDER_MISSING when requesting an unconfigured provider", () => {
    const { loadConfig } = require("../src/config.ts") as typeof import("../src/config.ts");
    const core = new WebToolsCore(loadConfig({ BRAVE_API_KEY: "b" } as unknown as NodeJS.ProcessEnv));
    expect(() => core.resolveProvider("serper")).toThrowError(expect.objectContaining({ code: "E_PROVIDER_MISSING" }));
  });

  it("enforces the per-session cost cap", async () => {
    const { loadConfig } = require("../src/config.ts") as typeof import("../src/config.ts");
    const core = new WebToolsCore(loadConfig({ SERPER_API_KEY: "s", PI_WEB_TOOLS_MAX_CALLS_PER_SESSION: "2" } as unknown as NodeJS.ProcessEnv));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ organic: [] })));
    const opts = { timeoutMs: 1000, bypassCache: true };
    await core.search("web", { query: "a", num: 1, page: 0, safesearch: "moderate" }, opts);
    await core.search("web", { query: "b", num: 1, page: 0, safesearch: "moderate" }, opts);
    await expect(core.search("web", { query: "c", num: 1, page: 0, safesearch: "moderate" }, opts)).rejects.toMatchObject({ code: "E_COST_CAP" });
  });

  it("serializes provider calls through the semaphore", async () => {
    const { loadConfig } = require("../src/config.ts") as typeof import("../src/config.ts");
    const core = new WebToolsCore(loadConfig({ SERPER_API_KEY: "s", PI_WEB_TOOLS_PROVIDER_CONCURRENCY: "1" } as unknown as NodeJS.ProcessEnv));
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return Response.json({ organic: [] });
      }),
    );
    const opts = { timeoutMs: 1000, bypassCache: true };
    await Promise.all(
      ["x", "y", "z"].map((q) => core.search("web", { query: q, num: 1, page: 0, safesearch: "moderate" }, opts)),
    );
    expect(maxActive).toBe(1);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially within jitter bounds", () => {
    for (let i = 0; i < 20; i++) {
      const d = backoffDelay(2, 500);
      expect(d).toBeGreaterThanOrEqual(1600); // 2000 - 20%
      expect(d).toBeLessThanOrEqual(2400); // 2000 + 20%
    }
  });
});
