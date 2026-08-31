import { describe, expect, it } from "vitest";
import { classifyBlockedIp, parseAndValidateUrl } from "../src/security/urlguard.ts";

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
