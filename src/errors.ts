/**
 * Error taxonomy for pi-web-tools. All tool-visible failures are WebToolsError
 * instances carrying a stable `code` so the LLM (and operators) can react
 * programmatically. Errors never echo API keys or raw provider payloads.
 */

export type ErrorCode =
  | "E_NO_PROVIDER"
  | "E_PROVIDER_MISSING"
  | "E_INVALID_KEY"
  | "E_RATE_LIMIT"
  | "E_QUOTA_EXHAUSTED"
  | "E_COST_CAP"
  | "E_BAD_REQUEST"
  | "E_CONFIG"
  | "E_NETWORK"
  | "E_TIMEOUT"
  | "E_CANCELLED"
  | "E_SSRF_BLOCKED"
  | "E_CONTENT_TOO_LARGE"
  | "E_UNSUPPORTED_TYPE"
  | "E_RENDERER_UNAVAILABLE"
  | "E_INJECTION_GUARD"
  | "E_UPSTREAM";

export class WebToolsError extends Error {
  readonly code: ErrorCode;
  /** Optional operator-facing hint (e.g. which env var to set). */
  readonly hint?: string;
  /** Optional retry-after seconds learned from the provider. */
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message: string, opts?: { hint?: string; retryAfterSeconds?: number }) {
    super(message);
    this.name = "WebToolsError";
    this.code = code;
    this.hint = opts?.hint;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
  }
}

export function isWebToolsError(err: unknown): err is WebToolsError {
  return err instanceof WebToolsError;
}

/** Render an error for a tool result: code + message (+ hint), secrets already excluded. */
export function describeError(err: unknown): string {
  if (err instanceof WebToolsError) {
    const parts = [`[${err.code}] ${err.message}`];
    if (err.retryAfterSeconds) parts.push(`(retry after ~${err.retryAfterSeconds}s)`);
    if (err.hint) parts.push(`Hint: ${err.hint}`);
    return parts.join(" ");
  }
  if (err instanceof Error) return `[E_UPSTREAM] ${err.message}`;
  return `[E_UPSTREAM] ${String(err)}`;
}
