/**
 * Rendered fetch tier: local-first Camoufox (free) via a thin Python bridge,
 * with Firecrawl as an operator-selected remote alternative. tier=auto
 * escalates from light at most once and degrades gracefully when no renderer
 * is available.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebToolsError } from "../errors.ts";
import { FIRECRAWL_DEFAULT_BASE_URL } from "../config.ts";
import { extractHtml, lightFetch } from "./light.ts";
import type { FetchResult } from "../normalize.ts";
import { assertHostResolvesSafe, parseAndValidateUrl, type UrlGuardOptions } from "../security/urlguard.ts";

export { lightFetch, extractHtml } from "./light.ts";

/** Build the scrape endpoint from a base URL (trailing-slash safe). */
export function firecrawlScrapeEndpoint(baseUrl?: string): string {
  const base = (baseUrl?.trim() || FIRECRAWL_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/v2/scrape`;
}

const FIRECRAWL_CONCURRENCY = 2;
let firecrawlInFlight = 0;

export interface RenderedFetchOptions extends UrlGuardOptions {
  renderer: "camoufox" | "firecrawl";
  firecrawlApiKey?: string;
  /** Firecrawl server base URL; defaults to the cloud endpoint. */
  firecrawlBaseUrl?: string;
  python: string;
  /** Test hook: override the bridge script path. */
  bridgeScript?: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RenderProbe {
  camoufoxAvailable: boolean;
}

/** Probe the local Camoufox capability once per session (cheap python import check). */
export async function probeCamoufox(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Arg-array only; "-c" code is a fixed literal, never user input.
    const child = spawn(python, ["-c", "import camoufox"], { stdio: "ignore" });
    const t = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 10_000);
    child.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

function bridgeScriptPath(opts?: { bridgeScript?: string }): string {
  if (opts?.bridgeScript) return opts.bridgeScript;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "python", "pi_web_tools_render.py");
}

export async function renderedFetch(rawUrl: string, opts: RenderedFetchOptions): Promise<FetchResult> {
  const url = parseAndValidateUrl(rawUrl, opts);
  await assertHostResolvesSafe(url, opts);

  if (opts.renderer === "firecrawl") {
    if (!opts.firecrawlApiKey) {
      throw new WebToolsError("E_RENDERER_UNAVAILABLE", "Firecrawl renderer selected but FIRE_CRAWL_API_KEY is not set", {
        hint: "Set FIRE_CRAWL_API_KEY or switch PI_WEB_TOOLS_RENDERER=camoufox.",
      });
    }
    return firecrawlFetch(rawUrl, opts);
  }
  return camoufoxFetch(rawUrl, opts);
}

// ─── Firecrawl (remote, paid) ────────────────────────────────────────────────

async function firecrawlFetch(rawUrl: string, opts: RenderedFetchOptions): Promise<FetchResult> {
  if (firecrawlInFlight >= FIRECRAWL_CONCURRENCY) {
    throw new WebToolsError("E_RATE_LIMIT", "Firecrawl concurrency limit reached (2 in flight)");
  }
  firecrawlInFlight++;
  try {
    if (opts.signal?.aborted) throw new WebToolsError("E_CANCELLED", "Cancelled");
    const timeout = AbortSignal.timeout(opts.timeoutMs * 4); // remote rendering is slower
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(firecrawlScrapeEndpoint(opts.firecrawlBaseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.firecrawlApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: rawUrl, formats: ["markdown"] }),
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new WebToolsError("E_CANCELLED", "Cancelled");
      const e = err as Error;
      if (e.name === "TimeoutError" || e.message.includes("abort")) {
        throw new WebToolsError("E_TIMEOUT", `Firecrawl request timed out`);
      }
      throw new WebToolsError("E_NETWORK", `Firecrawl network error: ${e.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new WebToolsError("E_INVALID_KEY", "Firecrawl rejected the API key");
      }
      if (res.status === 402) {
        throw new WebToolsError("E_QUOTA_EXHAUSTED", "Firecrawl credits exhausted (HTTP 402)");
      }
      if (res.status === 429) {
        throw new WebToolsError("E_RATE_LIMIT", "Firecrawl rate limit (HTTP 429)");
      }
      throw new WebToolsError("E_UPSTREAM", `Firecrawl returned HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const payload = (await res.json()) as { data?: { markdown?: string; metadata?: Record<string, unknown> } };
    const markdown = payload.data?.markdown ?? "";
    const meta = payload.data?.metadata ?? {};
    return {
      url: rawUrl,
      finalUrl: typeof meta.sourceURL === "string" ? meta.sourceURL : rawUrl,
      title: typeof meta.title === "string" ? meta.title : undefined,
      markdown: markdown.slice(0, opts.maxBytes),
      metadata: {
        description: typeof meta.description === "string" ? meta.description : undefined,
        language: typeof meta.language === "string" ? meta.language : undefined,
      },
      tier: "rendered",
      provider: "firecrawl",
      fetchedAt: new Date().toISOString(),
      truncated: markdown.length > opts.maxBytes,
      bytes: markdown.length,
      warning: "Rendered remotely via Firecrawl: page content was fetched by a third-party service (egress).",
    };
  } finally {
    firecrawlInFlight--;
  }
}

// ─── Camoufox (local, free) ──────────────────────────────────────────────────

export interface CamoufoxBridgeOutput {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  title?: string;
  error?: string;
}

/** Run the Python bridge with a JSON request on stdin and parse the JSON reply. */
export async function runCamoufoxBridge(url: string, opts: RenderedFetchOptions): Promise<CamoufoxBridgeOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.python, [bridgeScriptPath(opts)], {
      stdio: ["pipe", "pipe", "pipe"],
    }); // shell-safe arg array; no shell string
    let out = "";
    let err = "";
    let settled = false;

    const onAbort = () => {
      // Cancellation must kill the whole browser process tree.
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => finish(() => reject(new WebToolsError("E_RENDERER_UNAVAILABLE", `Camoufox bridge failed to start: ${e.message}`, { hint: `Install: ${opts.python} -m pip install "camoufox[geoip]" && ${opts.python} -m camoufox fetch` }))));
    child.on("close", (code) => {
      finish(() => {
        if (opts.signal?.aborted) {
          reject(new WebToolsError("E_CANCELLED", "Cancelled"));
          return;
        }
        let parsed: CamoufoxBridgeOutput | undefined;
        try {
          parsed = JSON.parse(out) as CamoufoxBridgeOutput;
        } catch {
          parsed = undefined;
        }
        if (parsed && parsed.ok) resolve(parsed);
        else reject(new WebToolsError("E_RENDERER_UNAVAILABLE", parsed?.error ?? `Camoufox bridge exited ${code}: ${err.slice(0, 300)}`));
      });
    });

    child.stdin.end(JSON.stringify({ url, timeoutMs: opts.timeoutMs * 3 }));
  });
}

async function camoufoxFetch(rawUrl: string, opts: RenderedFetchOptions): Promise<FetchResult> {
  const bridge = await runCamoufoxBridge(rawUrl, opts);
  if (!bridge.html) {
    throw new WebToolsError("E_RENDERER_UNAVAILABLE", bridge.error ?? "Camoufox returned no content");
  }
  const extracted = extractHtml(bridge.html, bridge.finalUrl ?? rawUrl);
  const markdown = extracted.markdown || (bridge.html.length < 2000 ? "```html\n" + bridge.html.slice(0, opts.maxBytes) + "\n```" : "");
  return {
    url: rawUrl,
    finalUrl: bridge.finalUrl ?? rawUrl,
    title: extracted.title ?? bridge.title,
    markdown: markdown.slice(0, opts.maxBytes),
    metadata: extracted.metadata,
    tier: "rendered",
    provider: "camoufox",
    fetchedAt: new Date().toISOString(),
    truncated: markdown.length > opts.maxBytes,
    bytes: bridge.html.length,
  };
}

// ─── auto escalation ─────────────────────────────────────────────────────────

export interface AutoFetchOptions extends UrlGuardOptions {
  renderer: "camoufox" | "firecrawl";
  firecrawlApiKey?: string;
  firecrawlBaseUrl?: string;
  python: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called when the light tier is unavailable and escalation would be needed. */
}

/**
 * tier=auto: run the light tier; if it signals needsRendering, escalate to the
 * rendered tier at most once. If the rendered tier is unavailable, return the
 * light result with renderingUnavailable=true instead of failing.
 */
export async function autoFetch(rawUrl: string, opts: AutoFetchOptions): Promise<FetchResult> {
  let lightResult;
  try {
    const light = await import("./light.ts").then((m) => m.lightFetch(rawUrl, opts));
    if (!light.result.needsRendering) return light.result;
    lightResult = light.result;
  } catch (err) {
    if (err instanceof WebToolsError && (err.code === "E_CANCELLED" || err.code === "E_SSRF_BLOCKED" || err.code === "E_INJECTION_GUARD" || err.code === "E_UNSUPPORTED_TYPE" || err.code === "E_CONTENT_TOO_LARGE")) {
      throw err; // safety/unsupported errors must not trigger rendering
    }
    lightResult = undefined; // light failed entirely; try rendered
  }

  try {
    return await renderedFetch(rawUrl, opts);
  } catch (err) {
    if (lightResult) {
      return { ...lightResult, renderingUnavailable: true, warning: appendWarning(lightResult.warning, "Rendered tier unavailable; returning light result.") };
    }
    throw err;
  }
}

function appendWarning(warning: string | undefined, extra: string): string {
  return warning ? `${warning} ${extra}` : extra;
}
