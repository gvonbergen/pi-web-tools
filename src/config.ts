/**
 * Environment-only configuration (no config files in v0.1).
 * Read once at module init; precedence: env var > compiled default.
 * Secret values are never logged; `maskKey` produces operator-safe previews.
 */

import { parseAllowedHostsEnv, type ParsedHostPattern } from "./security/hostpatterns.ts";

export type SearchProviderId = "serper" | "brave";
export type RendererId = "camoufox" | "firecrawl";

export interface Config {
  serperApiKey?: string;
  braveApiKey?: string;
  firecrawlApiKey?: string;
  /** Operator-selected default search provider. */
  searchProvider?: SearchProviderId;
  /** Operator-selected rendered-fetch engine. */
  renderer?: RendererId;
  rawEnabled: boolean;
  cacheTtlMs: number;
  maxCallsPerSession: number; // 0 = unlimited
  allowLocalNetworks: boolean;
  /** Explicit SSRF-exception host allowlist (empty by default; see docs/security.md). */
  allowedHosts: ParsedHostPattern[];
  fetchMaxBytes: number;
  timeoutMs: number;
  python: string;
  providerConcurrency: number;
  cacheMaxEntries: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  return raw === "1" || raw === "true" || raw === "yes";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const serperApiKey = env.SERPER_API_KEY?.trim() || undefined;
  const braveApiKey = env.BRAVE_API_KEY?.trim() || undefined;
  const firecrawlApiKey = env.FIRE_CRAWL_API_KEY?.trim() || undefined;

  const requestedProvider = env.PI_WEB_TOOLS_SEARCH_PROVIDER?.trim().toLowerCase();
  let searchProvider: SearchProviderId | undefined;
  if (requestedProvider === "serper" || requestedProvider === "brave") {
    searchProvider = requestedProvider;
  } else if (requestedProvider) {
    searchProvider = undefined; // invalid values fall through to auto-detection
  }
  if (!searchProvider) {
    // Captain decision D1: default to serper when both keys exist.
    if (serperApiKey) searchProvider = "serper";
    else if (braveApiKey) searchProvider = "brave";
  }

  const requestedRenderer = env.PI_WEB_TOOLS_RENDERER?.trim().toLowerCase();
  let renderer: RendererId | undefined;
  if (requestedRenderer === "camoufox" || requestedRenderer === "firecrawl") renderer = requestedRenderer;

  return {
    serperApiKey,
    braveApiKey,
    firecrawlApiKey,
    searchProvider,
    renderer,
    rawEnabled: boolEnv(env, "PI_WEB_TOOLS_RAW"),
    cacheTtlMs: intEnv(env, "PI_WEB_TOOLS_CACHE_TTL_MS", 300_000),
    maxCallsPerSession: intEnv(env, "PI_WEB_TOOLS_MAX_CALLS_PER_SESSION", 0),
    allowLocalNetworks: boolEnv(env, "PI_WEB_TOOLS_ALLOW_LOCAL_NETWORKS"),
    // Throws E_CONFIG on malformed entries (fail closed — a silently-dropped
    // allowlist entry would either weaken or silently change protection).
    allowedHosts: parseAllowedHostsEnv(env.PI_WEB_TOOLS_ALLOWED_HOSTS),
    fetchMaxBytes: intEnv(env, "PI_WEB_TOOLS_FETCH_MAX_BYTES", 2 * 1024 * 1024),
    timeoutMs: intEnv(env, "PI_WEB_TOOLS_TIMEOUT_MS", 30_000),
    python: env.PI_WEB_TOOLS_PYTHON?.trim() || "python3",
    providerConcurrency: intEnv(env, "PI_WEB_TOOLS_PROVIDER_CONCURRENCY", 3),
    cacheMaxEntries: intEnv(env, "PI_WEB_TOOLS_CACHE_MAX_ENTRIES", 500),
  };
}

/** Mask a secret for display: keep at most first 3 and last 4 chars. */
export function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Redact any key-like values that might appear in an error/header object. */
export function redactSecrets(text: string, config: Config): string {
  let out = text;
  for (const key of [config.serperApiKey, config.braveApiKey, config.firecrawlApiKey]) {
    if (key && out.includes(key)) out = out.split(key).join("***REDACTED***");
  }
  return out;
}
