import { describe, expect, it } from "vitest";
import { hashKey, LruTtlCache, Semaphore } from "../src/limits.ts";

describe("Semaphore", () => {
  it("limits concurrency", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all(Array.from({ length: 8 }, () => sem.run(task)));
    expect(maxActive).toBe(2);
  });
});

describe("LruTtlCache", () => {
  it("expires entries past the TTL", () => {
    let now = 1000;
    const cache = new LruTtlCache<number>(500, 10, () => now);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    now += 600;
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts least recently used beyond capacity", () => {
    let now = 1000;
    const cache = new LruTtlCache<number>(10_000, 2, () => now);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // refresh a
    cache.set("c", 3); // evicts b
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });
});

describe("hashKey", () => {
  it("is stable and differs for different inputs", () => {
    expect(hashKey("hello")).toBe(hashKey("hello"));
    expect(hashKey("hello")).not.toBe(hashKey("world"));
  });
});
