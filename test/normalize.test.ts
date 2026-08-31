import { describe, expect, it } from "vitest";
import {
  dedupeByUrl,
  normalizeBraveImages,
  normalizeBraveLocations,
  normalizeBraveNews,
  normalizeBraveVideos,
  normalizeBraveWeb,
  normalizeSerperImages,
  normalizeSerperNews,
  normalizeSerperPlaces,
  normalizeSerperVideos,
  normalizeSerperWeb,
} from "../src/normalize.ts";

// Fixtures mirror the documented provider response shapes (report §3).

const serperWeb = {
  organic: [
    { title: "Pi agent", link: "https://pi.dev", snippet: "A coding agent", position: 1, date: "Aug 30, 2026" },
    { title: "Other", link: "https://other.example", position: 2 },
  ],
  knowledgeGraph: { title: "ignored" },
};

const braveWeb = {
  web: {
    results: [
      { title: "Pi agent", url: "https://pi.dev", description: "A coding agent", age: "2 days ago" },
      { title: "Other", url: "https://other.example" },
    ],
  },
};

describe("serper normalizers", () => {
  it("normalizes web results", () => {
    const out = normalizeSerperWeb(serperWeb, 8);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ rank: 1, url: "https://pi.dev", provider: "serper", date: "Aug 30, 2026" });
  });

  it("normalizes news", () => {
    const out = normalizeSerperNews({ news: [{ title: "t", link: "https://n.example", source: "CNN", imageUrl: "https://i.example/x.jpg", position: 1 }] }, 8);
    expect(out[0]).toMatchObject({ source: "CNN", image: "https://i.example/x.jpg" });
  });

  it("normalizes images with dimensions", () => {
    const out = normalizeSerperImages({ images: [{ title: "img", imageUrl: "https://i.example/1.jpg", imageWidth: 640, imageHeight: 480, thumbnailUrl: "https://t.example/1.jpg", link: "https://page.example" }] }, 8);
    expect(out[0]).toMatchObject({ width: 640, height: 480, pageUrl: "https://page.example" });
  });

  it("normalizes videos", () => {
    const out = normalizeSerperVideos({ videos: [{ title: "v", link: "https://v.example", duration: "10:00", channel: "ch" }] }, 8);
    expect(out[0]).toMatchObject({ duration: "10:00", channel: "ch" });
  });

  it("normalizes places and requires a place id", () => {
    const out = normalizeSerperPlaces(
      { places: [{ title: "Coffee", cid: "abc", latitude: 37.7, longitude: -122.4, rating: 4.5, ratingCount: 120, phoneNumber: "+1 555", website: "https://c.example", type: "Cafe", address: "1 Main St" }, { title: "no id" }] },
      8,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ placeId: "abc", rating: 4.5 });
  });

  it("is tolerant of schema drift (unknown/missing fields)", () => {
    expect(normalizeSerperWeb({ organic: [{ nonsense: true }, null, { title: "x", link: "https://ok.example" }] }, 8)).toHaveLength(1);
    expect(normalizeSerperWeb(null, 8)).toEqual([]);
    expect(normalizeSerperWeb({}, 8)).toEqual([]);
  });
});

describe("brave normalizers", () => {
  it("normalizes web results", () => {
    const out = normalizeBraveWeb(braveWeb, 8);
    expect(out[0]).toMatchObject({ url: "https://pi.dev", provider: "brave" });
  });

  it("normalizes news with source host", () => {
    const out = normalizeBraveNews({ news: { results: [{ title: "t", url: "https://n.example/a", meta_url: { url: "https://cnn.com/x" } }] } }, 8);
    expect(out[0]?.source).toBe("cnn.com");
  });

  it("normalizes images via properties.url", () => {
    const out = normalizeBraveImages({ images: { results: [{ title: "i", url: "https://page.example", properties: { url: "https://i.example/1.jpg", width: 800, height: 600 } }] } }, 8);
    expect(out[0]).toMatchObject({ url: "https://i.example/1.jpg", pageUrl: "https://page.example", width: 800 });
  });

  it("normalizes videos", () => {
    const out = normalizeBraveVideos({ videos: { results: [{ title: "v", url: "https://v.example", video: { duration: "PT10M", creator: "ch" }, thumbnail: { src: "https://t.example/x" } }] } }, 8);
    expect(out[0]).toMatchObject({ duration: "PT10M", channel: "ch", image: "https://t.example/x" });
  });

  it("marks brave location ids as temporary (8h TTL)", () => {
    const out = normalizeBraveLocations({ locations: { results: [{ id: "poi_1", title: "Place", postal_address: { postOfficeBox: "2 Side St" } }] } }, 8);
    expect(out[0]).toMatchObject({ placeId: "poi_1", placeIdTtl: "8h", address: "2 Side St" });
  });
});

describe("dedupeByUrl", () => {
  it("collapses duplicate normalized URLs", () => {
    const out = dedupeByUrl([
      { url: "https://example.com/a?utm_source=x#frag", rank: 1 },
      { url: "https://example.com/a", rank: 2 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.rank).toBe(1);
  });
});
