/**
 * Environment-only configuration (no config files in v0.1).
 * Read once at module init; precedence: env var > compiled default.
 * Secret values are never logged; `maskKey` produces operator-safe previews.
 */

import { WebToolsError } from "./errors.ts";
import { parseAllowedHostsEnv, type ParsedHostPattern } from "./security/hostpatterns.ts";

/** Cloud Firecrawl endpoint; overridable via PI_WEB_TOOLS_FIRECRAWL_BASE_URL. */
export const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev";

export type SearchProviderId = "serper" | "brave";
export type RendererId = "camoufox" | "firecrawl";

export interface Config {
  serperApiKey?: string;
  braveApiKey?: string;
  firecrawlApiKey?: string;
  /** Firecrawl server base URL (no trailing slash); the /v2/scrape path is appended by the client. */
  firecrawlBaseUrl: string;
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
  /**
   * Independent raw-response safety cap (bytes of the raw, decompressed body),
   * protecting against decompression bombs and unbounded memory use. Deliberately
   * separate from `fetchMaxBytes`, which caps the extracted/cleaned content.
   */
  rawBodyMaxBytes: number;
  timeoutMs: number;
  python: string;
  providerConcurrency: number;
  cacheMaxEntries: number;
}

/**
 * Validate PI_WEB_TOOLS_FIRECRAWL_BASE_URL (operator-set Firecrawl server).
 * Empty/undefined → cloud default. Values are echoed only in redacted form:
 * a base URL can plausibly carry a key in its query or userinfo.
 * Throws E_CONFIG (fail closed) on anything that would corrupt the endpoint
 * join or leak credentials: non-http(s) schemes, userinfo, query, fragment.
 */
export function parseFirecrawlBaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return FIRECRAWL_DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebToolsError("E_CONFIG", "Invalid PI_WEB_TOOLS_FIRECRAWL_BASE_URL: not a valid URL", {
      hint: `Use an http(s) base URL, e.g. ${FIRECRAWL_DEFAULT_BASE_URL} or http://localhost:3002.`,
    });
  }
  if (parsed.username || parsed.password) {
    throw new WebToolsError("E_CONFIG", "Invalid PI_WEB_TOOLS_FIRECRAWL_BASE_URL: embedded credentials (user:pass@) are not supported", {
      hint: "Firecrawl authenticates via the Bearer key (FIRE_CRAWL_API_KEY), not URL userinfo.",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebToolsError("E_CONFIG", `Invalid PI_WEB_TOOLS_FIRECRAWL_BASE_URL: scheme must be http: or https:, got ${parsed.protocol}`, {
      hint: `Use an http(s) base URL, e.g. ${FIRECRAWL_DEFAULT_BASE_URL} or http://localhost:3002.`,
    });
  }
  if (parsed.search || parsed.hash) {
    throw new WebToolsError("E_CONFIG", "Invalid PI_WEB_TOOLS_FIRECRAWL_BASE_URL: query strings and fragments would corrupt the /v2/scrape endpoint join", {
      hint: "Use a bare base URL without ?query or #fragment.",
    });
  }
  // Strip trailing slashes so `${base}/v2/scrape` never produces `//v2/scrape`.
  return value.replace(/\/+$/, "");
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

  // Throws E_CONFIG on malformed values (fail closed, mirroring the allowlist).
  const firecrawlBaseUrl = parseFirecrawlBaseUrl(env.PI_WEB_TOOLS_FIRECRAWL_BASE_URL);

  return {
    serperApiKey,
    braveApiKey,
    firecrawlApiKey,
    firecrawlBaseUrl,
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
    // Decompression-bomb safety layer: independent of the caller-facing
    // content cap and never derived from it. Floor of 1 MiB (fail closed):
    // a lower value would neutralize bomb protection for real pages.
    rawBodyMaxBytes: (() => {
      const v = intEnv(env, "PI_WEB_TOOLS_RAW_BODY_MAX_BYTES", 32 * 1024 * 1024);
      if (v < 1024 * 1024) {
        throw new WebToolsError("E_CONFIG", "PI_WEB_TOOLS_RAW_BODY_MAX_BYTES must be at least 1048576 (1 MiB)", {
          hint: "This is the raw-response safety cap (decompression-bomb protection), independent of the per-call maxBytes content cap.",
        });
      }
      return v;
    })(),
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
