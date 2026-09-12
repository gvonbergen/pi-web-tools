import { describe, expect, it } from "vitest";
import { FIRECRAWL_DEFAULT_BASE_URL, loadConfig, maskKey, parseFirecrawlBaseUrl, redactSecrets } from "../src/config.ts";

describe("config", () => {
  it("defaults to serper when both keys exist (captain D1)", () => {
    const cfg = loadConfig({ SERPER_API_KEY: "s", BRAVE_API_KEY: "b" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.searchProvider).toBe("serper");
  });

  it("falls back to brave when only brave key exists", () => {
    const cfg = loadConfig({ BRAVE_API_KEY: "b" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.searchProvider).toBe("brave");
  });

  it("operator selection overrides defaults", () => {
    const cfg = loadConfig({ SERPER_API_KEY: "s", BRAVE_API_KEY: "b", PI_WEB_TOOLS_SEARCH_PROVIDER: "brave" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.searchProvider).toBe("brave");
  });

  it("no provider when no keys", () => {
    const cfg = loadConfig({} as unknown as NodeJS.ProcessEnv);
    expect(cfg.searchProvider).toBeUndefined();
  });

  it("renderer default is undefined (local-first resolution at call time)", () => {
    const cfg = loadConfig({ FIRE_CRAWL_API_KEY: "f" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.renderer).toBeUndefined();
    expect(cfg.firecrawlApiKey).toBe("f");
  });

  it("raw escape hatch disabled by default", () => {
    expect(loadConfig({} as unknown as NodeJS.ProcessEnv).rawEnabled).toBe(false);
    expect(loadConfig({ PI_WEB_TOOLS_RAW: "1" } as unknown as NodeJS.ProcessEnv).rawEnabled).toBe(true);
  });

  it("allow-local-networks blocked by default", () => {
    expect(loadConfig({} as unknown as NodeJS.ProcessEnv).allowLocalNetworks).toBe(false);
  });

  it("ssrf host allowlist is empty by default", () => {
    const cfg = loadConfig({} as unknown as NodeJS.ProcessEnv);
    expect(cfg.allowedHosts).toEqual([]);
  });

  it("parses PI_WEB_TOOLS_ALLOWED_HOSTS into normalized patterns", () => {
    const cfg = loadConfig({ PI_WEB_TOOLS_ALLOWED_HOSTS: "*.v7n.ch, Example.com" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.allowedHosts).toEqual([
      { pattern: "*.v7n.ch", wildcard: true, host: "v7n.ch" },
      { pattern: "example.com", wildcard: false, host: "example.com" },
    ]);
  });

  it("fails closed on malformed allowlist entries", () => {
    for (const bad of ["*", "*.v7n.ch,*", "10.0.0.1", "a.com:8080"]) {
      expect(() => loadConfig({ PI_WEB_TOOLS_ALLOWED_HOSTS: bad } as unknown as NodeJS.ProcessEnv)).toThrow(/PI_WEB_TOOLS_ALLOWED_HOSTS/);
    }
  });

  it("firecrawl base URL defaults to the cloud endpoint", () => {
    expect(loadConfig({} as unknown as NodeJS.ProcessEnv).firecrawlBaseUrl).toBe("https://api.firecrawl.dev");
    expect(parseFirecrawlBaseUrl(undefined)).toBe(FIRECRAWL_DEFAULT_BASE_URL);
    expect(parseFirecrawlBaseUrl("   ")).toBe(FIRECRAWL_DEFAULT_BASE_URL);
  });

  it("accepts a local Firecrawl base URL and normalizes it", () => {
    expect(parseFirecrawlBaseUrl("http://localhost:3002")).toBe("http://localhost:3002");
    expect(parseFirecrawlBaseUrl(" http://localhost:3002/ ")).toBe("http://localhost:3002");
    expect(parseFirecrawlBaseUrl("http://localhost:3002///")).toBe("http://localhost:3002");
    expect(parseFirecrawlBaseUrl("https://firecrawl.internal.example/v1-proxy/")).toBe("https://firecrawl.internal.example/v1-proxy");
    const cfg = loadConfig({ PI_WEB_TOOLS_FIRECRAWL_BASE_URL: "http://localhost:3002/" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.firecrawlBaseUrl).toBe("http://localhost:3002");
  });

  it("fails closed (E_CONFIG) on malformed/unsafe Firecrawl base URLs", () => {
    expect(() => parseFirecrawlBaseUrl("not a url")).toThrow(/PI_WEB_TOOLS_FIRECRAWL_BASE_URL/);
    expect(() => parseFirecrawlBaseUrl("ftp://localhost:3002")).toThrow(/scheme/);
    expect(() => parseFirecrawlBaseUrl("file:///etc")).toThrow(/scheme/);
    expect(() => parseFirecrawlBaseUrl("http://user:pass@localhost:3002")).toThrow(/credentials/);
    expect(() => parseFirecrawlBaseUrl("http://localhost:3002/?token=x")).toThrow(/query/);
    expect(() => parseFirecrawlBaseUrl("http://localhost:3002/#frag")).toThrow(/fragment/);
  });

  it("masks keys without revealing them", () => {
    expect(maskKey("sk-abcdef1234567890")).toBe("sk-…7890");
    expect(maskKey(undefined)).toBeUndefined();
    expect(maskKey("short")).toBe("*****");
  });

  it("redacts secrets from text", () => {
    const cfg = loadConfig({ SERPER_API_KEY: "supersecret" } as unknown as NodeJS.ProcessEnv);
    expect(redactSecrets("failed with key supersecret oh no", cfg)).not.toContain("supersecret");
  });
});
