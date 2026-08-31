/**
 * Shared provider HTTP plumbing: bounded retries with jittered exponential
 * backoff, Retry-After handling, typed error mapping, and timeout/cancellation.
 * Never logs or surfaces API keys.
 */

import { WebToolsError } from "../errors.ts";

export interface ProviderHttpOptions {
  /** Provider name for error messages only (never secrets). */
  provider: string;
  apiSecret: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxTries?: number;
  /** Test hook: base backoff delay in ms (default 1000). */
  backoffBaseMs?: number;
  /** Extra headers (values are constant, not secrets). */
  headers?: Record<string, string>;
}

export interface ProviderHttpResponse {
  status: number;
  headers: Headers;
  bodyText: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WebToolsError("E_CANCELLED", "Cancelled"));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new WebToolsError("E_CANCELLED", "Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Jittered backoff: base * 2^attempt ±20%. */
export function backoffDelay(attempt: number, baseMs = 1000): number {
  const raw = baseMs * 2 ** attempt;
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Perform a single provider HTTP call with retries. Retries only on 429/5xx
 * and network errors; 4xx other than 429 map to typed errors immediately.
 */
export async function providerRequest(
  url: string,
  init: { method: "GET" | "POST"; body?: string },
  opts: ProviderHttpOptions,
): Promise<ProviderHttpResponse> {
  const maxTries = opts.maxTries ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxTries; attempt++) {
    if (opts.signal?.aborted) throw new WebToolsError("E_CANCELLED", "Cancelled");
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: {
          accept: "application/json",
          "X-API-KEY": opts.provider === "serper" ? opts.apiSecret : undefined,
          "X-Subscription-Token": opts.provider === "brave" ? opts.apiSecret : undefined,
          ...opts.headers,
        } as Record<string, string>,
        body: init.body,
        signal,
        redirect: "error",
      });

      if (res.ok) {
        const bodyText = await res.text();
        return { status: res.status, headers: res.headers, bodyText };
      }

      const retryAfter = retryAfterSeconds(res.headers);
      const bodyText = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new WebToolsError("E_INVALID_KEY", `${opts.provider} rejected the API key (HTTP ${res.status})`, {
          hint: `Check the provider dashboard and the corresponding environment variable.`,
        });
      }
      if (res.status === 400 || res.status === 422) {
        throw new WebToolsError("E_BAD_REQUEST", `${opts.provider} rejected the request (HTTP ${res.status}): ${truncate(bodyText, 200)}`);
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new WebToolsError(
          res.status === 429 ? "E_RATE_LIMIT" : "E_UPSTREAM",
          `${opts.provider} returned HTTP ${res.status}${attempt + 1 < maxTries ? ", retrying" : ""}`,
          { retryAfterSeconds: retryAfter },
        );
        if (attempt + 1 < maxTries) {
          await sleep(retryAfter ? Math.min(retryAfter * 1000, 15_000) : backoffDelay(attempt, opts.backoffBaseMs ?? 1000), opts.signal);
          continue;
        }
        throw lastError;
      }
      throw new WebToolsError("E_UPSTREAM", `${opts.provider} returned unexpected HTTP ${res.status}`);
    } catch (err) {
      if (err instanceof WebToolsError) throw err;
      if (opts.signal?.aborted) throw new WebToolsError("E_CANCELLED", "Cancelled");
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("TimeoutError") || err instanceof Error && err.name === "TimeoutError") {
        throw new WebToolsError("E_TIMEOUT", `${opts.provider} request timed out after ${opts.timeoutMs}ms`);
      }
      // Network-level failure: retry.
      lastError = new WebToolsError("E_NETWORK", `${opts.provider} network error: ${msg}`);
      if (attempt + 1 < maxTries) {
        await sleep(backoffDelay(attempt, opts.backoffBaseMs ?? 1000), opts.signal);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError instanceof Error ? lastError : new WebToolsError("E_UPSTREAM", `${opts.provider} request failed`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
