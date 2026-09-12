/**
 * Host allowlist for the SSRF/private-address exception.
 *
 * Operators can explicitly opt specific hostnames out of the IP-range safety
 * check via PI_WEB_TOOLS_ALLOWED_HOSTS (comma-separated). This exists for
 * hosts whose DNS deliberately resolves into private space (e.g. an internal
 * site published as `*.v7n.ch` behind a VPN gateway at 10.8.0.2).
 *
 * Matching semantics (deliberately strict):
 * - Patterns are exact hostnames (`v7n.ch`) or wildcard subdomains
 *   (`*.v7n.ch`). A single leading `*.` is the only wildcard allowed; a bare
 *   `*` is rejected so the list can never act as a global disable switch.
 * - `*.example.com` matches subdomains at ANY depth (`a.example.com`,
 *   `a.b.example.com`) but NOT the apex `example.com` — mirror TLS wildcard
 *   semantics and list the apex explicitly when it must be allowed too.
 * - Matching is case-insensitive and ignores a trailing dot in the URL
 *   hostname; a hostname that is a literal IP can never match (patterns
 *   themselves must be names, not IPs), so arbitrary-IP allowlisting is
 *   impossible by construction.
 *
 * What the exception lifts for a matched host (and only for it): the
 * local-hostname rejection in the URL guard and the "every resolved address
 * is public" DNS check. Scheme/userinfo parsing, redirect handling, MIME
 * gating, size caps, and all checks for non-matching hosts are untouched.
 */

import { isIP } from "node:net";
import { WebToolsError } from "../errors.ts";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ParsedHostPattern {
  /** Normalized lowercase pattern as configured, e.g. `*.v7n.ch`. */
  pattern: string;
  /** True for `*.suffix` patterns. */
  wildcard: boolean;
  /** The non-wild part: full host for exact patterns, suffix for wildcards. */
  host: string;
}

/**
 * Validate and normalize one allowlist pattern. Throws E_CONFIG on anything
 * that is not an exact hostname or a `*.`-prefixed hostname (fail closed:
 * malformed operator config must be fixed, not silently ignored).
 */
export function parseAllowedHostPattern(rawPattern: string): ParsedHostPattern {
  const pattern = rawPattern.trim().toLowerCase();
  const fail = (why: string): never => {
    throw new WebToolsError(
      "E_CONFIG",
      `Invalid PI_WEB_TOOLS_ALLOWED_HOSTS entry "${rawPattern.trim()}": ${why}`,
      { hint: "Use exact hostnames (v7n.ch) or wildcard subdomains (*.v7n.ch); no schemes, ports, paths, or IP literals." },
    );
  };
  if (!pattern) fail("empty entry");
  let wildcard = false;
  let host = pattern;
  if (pattern.startsWith("*.")) {
    wildcard = true;
    host = pattern.slice(2);
  } else if (pattern.includes("*")) {
    fail("wildcards are only allowed as a leading '*.' prefix");
  }
  if (!host) fail("empty hostname");
  if (host.endsWith(".")) fail("trailing dot");
  if (isIP(host)) fail("IP literals cannot be allowlisted (the exception is name-based only)");
  const labels = host.split(".");
  if (labels.some((l) => !LABEL.test(l))) fail("hostname contains invalid characters or malformed labels");
  if (host.length > 253) fail("hostname too long");
  return { pattern, wildcard, host };
}

/** Parse the comma-separated env value; empty/undefined yields an empty list. */
export function parseAllowedHostsEnv(raw: string | undefined): ParsedHostPattern[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseAllowedHostPattern);
}

/**
 * Does this URL hostname match any configured allowlist pattern?
 * Case-insensitive; trailing dot on the hostname is ignored. A literal-IP
 * hostname never matches (patterns are names only). Empty pattern list
 * always returns false — the default behavior is unchanged protection.
 */
export function hostMatchesAllowed(hostnameRaw: string, patterns: readonly ParsedHostPattern[]): boolean {
  if (patterns.length === 0) return false;
  const hostname = hostnameRaw.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(hostname)) return false;
  for (const p of patterns) {
    if (p.wildcard) {
      // Any-depth subdomain: must END with "." + suffix and be longer,
      // so the apex itself does not match (documented semantics).
      if (hostname.length > p.host.length + 1 && hostname.endsWith(`.${p.host}`)) return true;
    } else if (hostname === p.host) {
      return true;
    }
  }
  return false;
}