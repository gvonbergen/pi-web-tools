import { describe, expect, it } from "vitest";
import { capContent } from "../src/fetch/content.ts";

describe("character content cap", () => {
  it.each([0, 0.5, 1, 1.9, 2, 2.5, 3])("preserves whole characters with a %s char cap", (cap) => {
    const result = capContent("界😀", cap);
    const expected = cap < 1 ? "" : cap < 2 ? "界" : "界😀";
    expect(result.markdown).toBe(expected);
    expect(Array.from(result.markdown).length).toBeLessThanOrEqual(Math.floor(cap));
    expect(result.truncated).toBe(cap < 2);
    expect(result.characters).toBe(2);
    if (result.truncated) {
      expect(result.warning).toContain(`returning the first ${expected.length} characters`);
    } else {
      expect(result.warning).toBeUndefined();
    }
  });

  it("never splits a surrogate pair (UTF-16 whole-character boundary)", () => {
    expect(capContent("a😀b", 2)).toMatchObject({ markdown: "a😀", truncated: true });
  });

  it.each([-1, -0.5, Number.NaN])("normalizes invalid lower bounds (%s) to zero", (cap) => {
    expect(capContent("界😀", cap)).toMatchObject({ markdown: "", truncated: true });
  });
});