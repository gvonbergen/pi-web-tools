/**
 * Optional credentialed integration tests. SKIPPED BY DEFAULT — they consume
 * paid provider credits and only run when the corresponding env keys are set.
 * CI never sets these; run locally at your own cost.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { BraveAdapter } from "../src/providers/brave.ts";
import { SerperAdapter } from "../src/providers/serper.ts";

const config = loadConfig();
const opts = { timeoutMs: 15_000 };
const has = (u: NodeJS.ProcessEnv, k: string) => Boolean(u[k]);

describe.skipIf(!has(process.env, "SERPER_API_KEY"))("serper live", () => {
  const adapter = new SerperAdapter(config.serperApiKey);
  it("web search returns normalized results", async () => {
    const out = await adapter.search("web", { query: "pi coding agent", num: 5, page: 0, safesearch: "moderate" }, opts);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0]).toMatchObject({ provider: "serper" });
  }, 30_000);
});

describe.skipIf(!has(process.env, "BRAVE_API_KEY"))("brave live", () => {
  const adapter = new BraveAdapter(config.braveApiKey);
  it("web search returns normalized results", async () => {
    const out = await adapter.search("web", { query: "pi coding agent", num: 5, page: 0, safesearch: "moderate" }, opts);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0]).toMatchObject({ provider: "brave" });
  }, 30_000);
});
