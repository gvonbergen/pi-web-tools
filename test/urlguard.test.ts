import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertHostResolvesSafe, classifyBlockedIp, parseAndValidateUrl } from "../src/security/urlguard.ts";

const GUARD = { allowLocalNetworks: false };

describe("urlguard: scheme + userinfo", () => {
  it("accepts http and https", () => {
    expect(parseAndValidateUrl("https://example.com/x", GUARD).protocol).toBe("https:");
    expect(parseAndValidateUrl("http://example.com/x", GUARD).protocol).toBe("http:");
  });

  it("rejects non-http schemes", () => {
    for (const url of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
      expect(() => parseAndValidateUrl(url, GUARD)).toThrow(/http\(s\)/);
    }
  });

  it("rejects embedded credentials", () => {
    expect(() => parseAndValidateUrl("https://user:pass@example.com", GUARD)).toThrow(/credentials/);
  });

  it("rejects local hostnames", () => {
    expect(() => parseAndValidateUrl("https://localhost/x", GUARD)).toThrow(/E_SSRF_BLOCKED|local hostname|Blocked/);
    expect(() => parseAndValidateUrl("https://db.internal/x", GUARD)).toThrow();
  });
});

describe("urlguard: SSRF IP matrix", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.8.8.8", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"],
    ["0.0.0.0", "unspecified"],
    ["100.64.0.1", "cgnat"],
    ["224.0.0.1", "multicast-reserved"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["ff02::1", "multicast"],
  ];
  for (const [ip, reason] of blocked) {
    it(`blocks ${ip} (${reason})`, () => {
      expect(classifyBlockedIp(ip)).toBe(reason);
    });
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "8.8.8.8-reverse.example"];
  for (const ip of allowed.slice(0, 5)) {
    it(`allows ${ip}`, () => {
      expect(classifyBlockedIp(ip)).toBeUndefined();
    });
  }

  it("blocks IPv4-mapped IPv6", () => {
    expect(classifyBlockedIp("::ffff:127.0.0.1")).toBeDefined();
    expect(classifyBlockedIp("::ffff:10.0.0.5")).toBeDefined();
    expect(classifyBlockedIp("::ffff:8.8.8.8")).toBeUndefined();
  });

  it("rejects literal IPs in URLs", () => {
    expect(() => parseAndValidateUrl("http://127.0.0.1:8080/", GUARD)).toThrow();
    expect(() => parseAndValidateUrl("http://[::1]:8080/", GUARD)).toThrow();
    expect(() => parseAndValidateUrl("http://169.254.169.254/latest/meta-data/", GUARD)).toThrow();
  });

  it("allowLocalNetworks bypasses checks (dev opt-in)", () => {
    expect(() => parseAndValidateUrl("http://127.0.0.1:8080/", { allowLocalNetworks: true })).not.toThrow();
  });
});

// ─── SSRF host allowlist exception (PI_WEB_TOOLS_ALLOWED_HOSTS) ──────────────
// DNS is mocked so the resolved addresses are deterministic.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import { lookup } from "node:dns/promises";
// vi.mocked resolves to the first overload's signature; normalize to a loose
// mock type so mockResolvedValue accepts the all-records shape we use.
const lookupMock = vi.mocked(lookup as unknown as (hostname: string, options: { all: boolean }) => Promise<unknown>);

describe("urlguard: host allowlist exception", () => {
  const allow = [{ pattern: "*.v7n.ch", wildcard: true, host: "v7n.ch" }];
  const GUARD_ALLOW = { allowLocalNetworks: false, allowedHosts: allow };

  beforeEach(() => {
    lookupMock.mockReset();
  });

  function resolveTo(...addresses: string[]) {
    lookupMock.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  }

  it("allows an explicitly allowlisted host whose DNS resolves into private space", async () => {
    resolveTo("10.8.0.2");
    const url = parseAndValidateUrl("https://intranet.v7n.ch/", GUARD_ALLOW);
    await expect(assertHostResolvesSafe(url, GUARD_ALLOW)).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled(); // exempted hosts skip DNS entirely
  });

  it("same host without the allowlist is still blocked (default behavior)", async () => {
    resolveTo("10.8.0.2");
    const url = parseAndValidateUrl("https://intranet.v7n.ch/", GUARD);
    await expect(assertHostResolvesSafe(url, GUARD)).rejects.toMatchObject({ code: "E_SSRF_BLOCKED" });
  });

  it("unrelated private targets remain protected even with an allowlist configured", async () => {
    resolveTo("192.168.1.10");
    const url = parseAndValidateUrl("https://nas.example/", GUARD_ALLOW);
    await expect(assertHostResolvesSafe(url, GUARD_ALLOW)).rejects.toMatchObject({ code: "E_SSRF_BLOCKED" });
  });

  it("the apex does not match *.v7n.ch and stays protected", async () => {
    resolveTo("10.8.0.2");
    const url = parseAndValidateUrl("https://v7n.ch/", GUARD_ALLOW);
    await expect(assertHostResolvesSafe(url, GUARD_ALLOW)).rejects.toMatchObject({ code: "E_SSRF_BLOCKED" });
  });

  it("exempt hosts are exempt at the URL-surface check too (local-suffix names), but scheme/userinfo parsing is untouched", () => {
    expect(() => parseAndValidateUrl("https://box.v7n.ch/", GUARD_ALLOW)).not.toThrow();
    expect(() => parseAndValidateUrl("https://user:pass@box.v7n.ch/", GUARD_ALLOW)).toThrow(/credentials/);
    expect(() => parseAndValidateUrl("ftp://box.v7n.ch/", GUARD_ALLOW)).toThrow(/http\(s\)/);
    expect(() => parseAndValidateUrl("http://127.0.0.1/", GUARD_ALLOW)).toThrow(); // literal IPs never match a name allowlist
    expect(() => parseAndValidateUrl("http://169.254.169.254/latest/meta-data/", GUARD_ALLOW)).toThrow();
    expect(() => parseAndValidateUrl("http://other.local/", GUARD_ALLOW)).toThrow(); // non-matching hostname still blocked
  });
});
