import { describe, expect, it } from "vitest";
import { hostMatchesAllowed, parseAllowedHostPattern, parseAllowedHostsEnv } from "../src/security/hostpatterns.ts";
import { WebToolsError } from "../src/errors.ts";

const pats = (...raw: string[]) => raw.map(parseAllowedHostPattern);

describe("hostpatterns: pattern validation", () => {
  it("accepts exact hostnames and wildcard subdomains, normalized to lowercase", () => {
    expect(parseAllowedHostPattern("v7n.ch")).toEqual({ pattern: "v7n.ch", wildcard: false, host: "v7n.ch" });
    expect(parseAllowedHostPattern("*.V7N.ch")).toEqual({ pattern: "*.v7n.ch", wildcard: true, host: "v7n.ch" });
    expect(parseAllowedHostPattern("  internal.corp.example.com ")).toEqual({
      pattern: "internal.corp.example.com",
      wildcard: false,
      host: "internal.corp.example.com",
    });
  });

  it("rejects malformed patterns with E_CONFIG", () => {
    const bad = [
      "*", // global disable switch — must never be expressible
      "*.",
      "**",
      "foo.*",
      "foo.*.com",
      "*.foo.*",
      "",
      "   ",
      "a..com",
      ".a.com",
      "a.com.",
      "http://a.com",
      "a.com:8080",
      "a.com/path",
      "user:pass@a.com",
      "10.0.0.1", // IP literals can never be allowlisted
      "127.0.0.1",
      "::1",
      "a b.com",
      "-a.com",
      "a-.com",
      "a_.com",
      "*.a..b",
    ];
    for (const entry of bad) {
      try {
        parseAllowedHostPattern(entry);
        expect.unreachable(`expected "${entry}" to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(WebToolsError);
        expect((err as WebToolsError).code).toBe("E_CONFIG");
      }
    }
  });

  it("parseAllowedHostsEnv splits on commas, trims, drops empty entries", () => {
    expect(parseAllowedHostsEnv(undefined)).toEqual([]);
    expect(parseAllowedHostsEnv("")).toEqual([]);
    expect(parseAllowedHostsEnv("  ")).toEqual([]);
    expect(parseAllowedHostsEnv("*.v7n.ch, example.com")).toEqual(pats("*.v7n.ch", "example.com"));
    expect(parseAllowedHostsEnv(" *.v7n.ch ,, example.com, ")).toEqual(pats("*.v7n.ch", "example.com"));
  });

  it("parseAllowedHostsEnv rejects any malformed entry (fail closed)", () => {
    expect(() => parseAllowedHostsEnv("*.v7n.ch,*")).toThrow(WebToolsError);
    expect(() => parseAllowedHostsEnv("ok.com, 10.0.0.1")).toThrow(WebToolsError);
  });
});

describe("hostpatterns: matching semantics", () => {
  const allow = pats("v7n.ch", "*.v7n.ch");

  it("matches exact hosts case-insensitively", () => {
    expect(hostMatchesAllowed("v7n.ch", allow)).toBe(true);
    expect(hostMatchesAllowed("V7N.CH", allow)).toBe(true);
  });

  it("matches wildcard subdomains at any depth", () => {
    expect(hostMatchesAllowed("www.v7n.ch", allow)).toBe(true);
    expect(hostMatchesAllowed("a.b.v7n.ch", allow)).toBe(true);
  });

  it("the apex does NOT match a wildcard pattern — list it explicitly", () => {
    const onlyWildcard = pats("*.v7n.ch");
    expect(hostMatchesAllowed("v7n.ch", onlyWildcard)).toBe(false);
    expect(hostMatchesAllowed("www.v7n.ch", onlyWildcard)).toBe(true);
    // Both together allow both apex and subdomains.
    expect(hostMatchesAllowed("v7n.ch", allow)).toBe(true);
  });

  it("never matches lookalikes that merely contain the suffix", () => {
    expect(hostMatchesAllowed("notv7n.ch", allow)).toBe(false);
    expect(hostMatchesAllowed("xv7n.ch", allow)).toBe(false);
    expect(hostMatchesAllowed("v7n.ch.evil.example", allow)).toBe(false);
    expect(hostMatchesAllowed("v7n.ch.example", allow)).toBe(false);
    expect(hostMatchesAllowed("v7n.company", allow)).toBe(false);
  });

  it("ignores a trailing dot in the URL hostname", () => {
    expect(hostMatchesAllowed("www.v7n.ch.", allow)).toBe(true);
    expect(hostMatchesAllowed("v7n.ch.", allow)).toBe(true);
  });

  it("literal-IP hostnames never match a name-based allowlist", () => {
    expect(hostMatchesAllowed("10.8.0.2", allow)).toBe(false);
    expect(hostMatchesAllowed("169.254.169.254", allow)).toBe(false);
  });

  it("an empty allowlist never matches (default protection unchanged)", () => {
    expect(hostMatchesAllowed("anything.example", [])).toBe(false);
    expect(hostMatchesAllowed("v7n.ch", [])).toBe(false);
  });
});