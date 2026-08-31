import { describe, expect, it } from "vitest";
import { loadConfig, maskKey, redactSecrets } from "../src/config.ts";

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
