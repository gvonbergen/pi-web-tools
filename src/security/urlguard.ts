/**
 * URL safety: http(s)-only, no userinfo, and SSRF blocking of private,
 * loopback, link-local, ULA, CGNAT and unspecified address ranges for both
 * IPv4 and IPv6 (including IPv4-mapped IPv6). DNS is resolved and every
 * resolved address is checked; callers must re-check after every redirect hop
 * and immediately before connecting (DNS rebinding mitigation). An explicit
 * operator allowlist (PI_WEB_TOOLS_ALLOWED_HOSTS, see ./hostpatterns.ts)
 * can exempt named hosts from the IP-range checks; it never relaxes scheme/
 * userinfo parsing and never applies to literal-IP URLs.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WebToolsError } from "../errors.ts";
import { hostMatchesAllowed, type ParsedHostPattern } from "./hostpatterns.ts";

export interface UrlGuardOptions {
  allowLocalNetworks: boolean;
  /**
   * Explicit operator allowlist (PI_WEB_TOOLS_ALLOWED_HOSTS): hostnames
   * exempt from the SSRF/private-address checks. Empty by default; matching
   * semantics in ./hostpatterns.ts. Does NOT relax scheme/userinfo parsing,
   * and is honored per-hop on redirects (unlike allowLocalNetworks, which
   * redirect re-validation always strips).
   */
  allowedHosts?: readonly ParsedHostPattern[];
}

/** Parse + validate the URL surface (scheme, userinfo). Does not resolve DNS. */
export function parseAndValidateUrl(raw: string, opts: UrlGuardOptions): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebToolsError("E_INJECTION_GUARD", `Invalid URL: ${truncate(raw, 200)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebToolsError("E_INJECTION_GUARD", `Only http(s) URLs are allowed, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new WebToolsError("E_INJECTION_GUARD", "URLs with embedded credentials (user:pass@) are not allowed");
  }
  if (!url.hostname) {
    throw new WebToolsError("E_INJECTION_GUARD", "URL has no hostname");
  }
  if (!opts.allowLocalNetworks) {
    const host = url.hostname.toLowerCase();
    const allowed = hostMatchesAllowed(host, opts.allowedHosts ?? []);
    if (!allowed) {
      // Reject obviously-local hostnames before DNS even happens.
      if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
        throw new WebToolsError("E_SSRF_BLOCKED", `Blocked local hostname: ${host}`);
      }
      // Literal IPs in the URL.
      const bare = host.replace(/^\[|\]$/g, "");
      if (isIP(bare)) {
        assertIpAllowed(bare, opts);
      }
    }
  }
  return url;
}

/** Resolve hostname and verify every resolved address is public.
 * Hosts on the explicit allowlist skip this check entirely (operator opt-in
 * for names whose DNS intentionally resolves into private space). */
export async function assertHostResolvesSafe(url: URL, opts: UrlGuardOptions): Promise<void> {
  if (opts.allowLocalNetworks) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (hostMatchesAllowed(host, opts.allowedHosts ?? [])) return;
  if (isIP(host)) {
    assertIpAllowed(host, opts);
    return;
  }
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new WebToolsError("E_NETWORK", `DNS resolution failed for ${host}: ${(err as Error).message}`);
  }
  if (records.length === 0) {
    throw new WebToolsError("E_NETWORK", `DNS resolution returned no addresses for ${host}`);
  }
  for (const record of records) {
    assertIpAllowed(record.address, opts);
  }
}

export function assertIpAllowed(ip: string, opts: UrlGuardOptions): void {
  if (opts.allowLocalNetworks) return;
  const reason = classifyBlockedIp(ip);
  if (reason) {
    throw new WebToolsError("E_SSRF_BLOCKED", `Blocked ${reason} address: ${ip}`);
  }
}

/** Returns a human reason if the IP is in a blocked range, else undefined. */
export function classifyBlockedIp(ipRaw: string): string | undefined {
  const ip = ipRaw.toLowerCase();
  if (ip.includes(":") && ip.includes(".")) {
    // IPv4-mapped or IPv4-compatible IPv6 (::ffff:10.0.0.1 etc.)
    const mapped = ip.split(":").pop();
    if (mapped && isIP(mapped) === 4) return classifyBlockedIpv4(mapped);
  }
  if (isIP(ip) === 4) return classifyBlockedIpv4(ip);

  // IPv6 checks (expand to 8 groups).
  const groups = expandIpv6(ip);
  if (!groups) return undefined;
  const g: number[] = (groups as string[]).map((x) => parseInt(x, 16));
  if (ip === "::" || g.every((x) => x === 0)) return "unspecified"; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback"; // ::1
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10 (fe80–febf)
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique-local"; // fc00::/7
  if ((g[0]! & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  if (g[0] === 0x0064 && g[1] === 0xff9b) return "nat64"; // 64:ff9b::/96
  // IPv4-embedded tail (::ffff:a.b.c.d and friends).
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${(g[6]! >> 8) & 0xff}.${g[6]! & 0xff}.${(g[7]! >> 8) & 0xff}.${g[7]! & 0xff}`;
    return classifyBlockedIpv4(v4) ?? (g[5] === 0xffff ? "ipv4-mapped-ipv6" : undefined);
  }
  return undefined;
}

function classifyBlockedIpv4(ip: string): string | undefined {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return "unspecified"; // 0.0.0.0/8
  if (a === 127) return "loopback"; // 127.0.0.0/8
  if (a === 10) return "private"; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
  if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
  if (a === 169 && b === 254) return "link-local"; // 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return "cgnat"; // 100.64.0.0/10
  if (a >= 224) return "multicast-reserved"; // 224.0.0.0/4 + reserved 240/4 + broadcast
  return undefined;
}

function expandIpv6(ip: string): string[] | undefined {
  if (!ip.includes(":")) return undefined;
  let head = ip;
  const pct = head.indexOf("%");
  if (pct !== -1) head = head.slice(0, pct);

  // Handle an embedded IPv4 tail (e.g. ::ffff:1.2.3.4 → two hex groups).
  let v4tail: string | undefined;
  const colonParts0 = head.split(":");
  const last = colonParts0[colonParts0.length - 1] ?? "";
  if (last.includes(".")) {
    if (isIP(last) !== 4) return undefined;
    v4tail = last;
    head = head.slice(0, head.length - last.length - 1); // strip ".x.x.x.x"
  }

  const doubleColon = head.includes("::");
  if ((head.match(/::/g) ?? []).length > 1) return undefined;
  const halves = head.split("::");
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = doubleColon && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  if (!doubleColon && halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length - (v4tail ? 2 : 0);
  if (missing < 0) return undefined;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (v4tail) {
    const [a, b] = v4tail.split(".");
    groups.push(((Number(a)! << 8) | Number(b)!).toString(16));
    groups.push("0");
  }
  if (groups.length !== 8) return undefined;
  if (groups.some((g2) => !/^[0-9a-f]{1,4}$/.test(g2))) return undefined;
  return groups.map((g2) => g2.padStart(4, "0"));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
