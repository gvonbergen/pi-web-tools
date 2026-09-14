import { describe, expect, it } from "vitest";
import { capContent } from "../src/fetch/content.ts";

describe("UTF-8 content cap", () => {
  it.each([0, 0.5, 2.9, 3, 4.5, 6.9, 7, 7.5])("preserves characters with a %s byte cap", (cap) => {
    const result = capContent("界😀", cap);
    const expected = cap < 3 ? "" : cap < 7 ? "界" : "界😀";
    expect(result.markdown).toBe(expected);
    expect(Buffer.byteLength(result.markdown)).toBeLessThanOrEqual(cap);
    expect(result.truncated).toBe(cap < 7);
    expect(result.bytes).toBe(7);
    if (result.truncated) {
      expect(result.warning).toContain(`returning the first ${Buffer.byteLength(expected)} bytes`);
    } else {
      expect(result.warning).toBeUndefined();
    }
  });

  it.each([-1, -0.5, Number.NaN])("normalizes invalid lower bounds (%s) to zero", (cap) => {
    expect(capContent("界😀", cap)).toMatchObject({ markdown: "", truncated: true });
  });
});
