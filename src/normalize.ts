/**
 * Normalized result types + tolerant provider-response normalizers.
 * Normalizers never throw on unexpected provider fields; they skip entries
 * they cannot make sense of (schema drift resilience).
 */

export type ProviderId = "serper" | "brave";

export interface SearchResult {
  rank: number;
  title: string;
  url: string;
  snippet?: string;
  date?: string;
  source?: string;
  image?: string;
  duration?: string;
  channel?: string;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  pageUrl?: string;
  provider: ProviderId;
}

export interface PlaceResult {
  rank: number;
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  rating?: number;
  ratingCount?: number;
  phone?: string;
  website?: string;
  category?: string;
  placeId: string;
  /** Present when the provider's place id is short-lived (Brave POI ids ~8h). */
  placeIdTtl?: "8h";
  provider: ProviderId;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  title?: string;
  markdown: string;
  metadata?: {
    description?: string;
    author?: string;
    publishedDate?: string;
    siteName?: string;
    language?: string;
  };
  tier: "light" | "rendered";
  provider: "node" | "firecrawl" | "camoufox";
  fetchedAt: string;
  truncated: boolean;
  bytes: number;
  needsRendering?: boolean;
  renderingUnavailable?: boolean;
  warning?: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Collapse duplicate normalized URLs within one result set (keep first). */
export function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    let key = item.url;
    try {
      const u = new URL(item.url);
      u.hash = "";
      u.search = "";
      key = u.toString().replace(/\/$/, "");
    } catch {
      // keep raw url as key
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ─── Serper ──────────────────────────────────────────────────────────────────

type SerperEntry = Record<string, unknown>;

export function normalizeSerperWeb(payload: unknown, limit: number): SearchResult[] {
  const organic = readArray(payload, "organic");
  return dedupeByUrl(
    organic.map((e, i) => ({
      rank: num(e.position) ?? i + 1,
      title: str(e.title) ?? "(untitled)",
      url: str(e.link) ?? "",
      snippet: str(e.snippet),
      date: str(e.date),
      provider: "serper" as const,
    })),
  )
    .filter((r) => r.url)
    .slice(0, limit);
}

export function normalizeSerperNews(payload: unknown, limit: number): SearchResult[] {
  const news = readArray(payload, "news");
  return dedupeByUrl(
    news.map((e, i) => ({
      rank: num(e.position) ?? i + 1,
      title: str(e.title) ?? "(untitled)",
      url: str(e.link) ?? "",
      snippet: str(e.snippet),
      date: str(e.date),
      source: str(e.source),
      image: str(e.imageUrl),
      provider: "serper" as const,
    })),
  )
    .filter((r) => r.url)
    .slice(0, limit);
}

export function normalizeSerperImages(payload: unknown, limit: number): SearchResult[] {
  const images = readArray(payload, "images");
  return dedupeByUrl(
    images.map((e, i) => ({
      rank: num(e.position) ?? i + 1,
      title: str(e.title) ?? "(untitled)",
      url: str(e.imageUrl) ?? "",
      thumbnailUrl: str(e.thumbnailUrl),
      width: num(e.imageWidth),
      height: num(e.imageHeight),
      source: str(e.source),
      pageUrl: str(e.link),
      provider: "serper" as const,
    })),
  )
    .filter((r) => r.url)
    .slice(0, limit);
}

export function normalizeSerperVideos(payload: unknown, limit: number): SearchResult[] {
  const videos = readArray(payload, "videos");
  return dedupeByUrl(
    videos.map((e, i) => ({
      rank: num(e.position) ?? i + 1,
      title: str(e.title) ?? "(untitled)",
      url: str(e.link) ?? "",
      snippet: str(e.snippet),
      date: str(e.date),
      duration: str(e.duration),
      source: str(e.source),
      channel: str(e.channel),
      image: str(e.imageUrl),
      provider: "serper" as const,
    })),
  )
    .filter((r) => r.url)
    .slice(0, limit);
}

export function normalizeSerperPlaces(payload: unknown, limit: number): PlaceResult[] {
  const places = readArray(payload, "places");
  return places
    .flatMap((e, i): PlaceResult[] => {
      const placeId = str(e.cid) ?? str(e.fid) ?? str(e.placeId);
      if (!placeId) return [];
      return [
        {
          rank: num(e.position) ?? i + 1,
          name: str(e.title) ?? "(unnamed place)",
          address: str(e.address),
          lat: num(e.latitude),
          lng: num(e.longitude),
          rating: num(e.rating),
          ratingCount: num(e.ratingCount),
          phone: str(e.phoneNumber),
          website: str(e.website),
          category: str(e.type) ?? str(e.category),
          placeId,
          provider: "serper" as const,
        },
      ];
    })
    .slice(0, limit);
}

// ─── Brave ───────────────────────────────────────────────────────────────────

export function normalizeBraveWeb(payload: unknown, limit: number): SearchResult[] {
  const web = readObject(payload, "web");
  const results = readArray(web, "results");
  return dedupeByUrl(
    results.map((e, i) => ({
      rank: i + 1,
      title: str(e.title) ?? "(untitled)",
      url: str(e.url) ?? "",
      snippet: str(e.description),
      date: str(e.age) ?? str(extractMetaDate(e)),
      provider: "brave" as const,
    })),
  )
    .filter((r) => r.url)
    .slice(0, limit);
}

export function normalizeBraveNews(payload: unknown, limit: number): SearchResult[] {
  const news = readObject(payload, "news");
  const results = readArray(news, "results");
  return dedupeByUrl(
    results.map((e, i) => ({
      rank: i + 1,
      title: str(e.title) ?? "(untitled)",
      url: str(e.url) ?? "",
      snippet: str(e.description),
      date: str(e.age),
      source: hostOf(readObject(e, "meta_url")?.url),
      provider: "brave" as const,
    })),
  )
    .filter((r) => r.url)
    .slice(0, limit);
}

export function normalizeBraveImages(payload: unknown, limit: number): SearchResult[] {
  const images = readObject(payload, "images");
  const results = readArray(images, "results");
  return dedupeByUrl(
    results.map((e, i) => {
      const props = readObject(e, "properties");
      return {
        rank: i + 1,
        title: str(e.title) ?? "(untitled)",
        url: str(props?.url) ?? str(e.url) ?? "",
        thumbnailUrl: str(props?.thumbnail) ?? strField(readObject(e, "thumbnail"), "src"),
        width: num(props?.width),
        height: num(props?.height),
        pageUrl: str(e.url),
        source: hostOf(readObject(e, "source")?.url),
        provider: "brave" as const,
      } satisfies SearchResult;
    }),
  )
    .filter((r) => r.url)
    .slice(0, limit);
}

export function normalizeBraveVideos(payload: unknown, limit: number): SearchResult[] {
  const videos = readObject(payload, "videos");
  const results = readArray(videos, "results");
  return dedupeByUrl(
    results.map((e, i) => {
      const video = readObject(e, "video");
      return {
        rank: i + 1,
        title: str(e.title) ?? "(untitled)",
        url: str(e.url) ?? "",
        snippet: str(e.description),
        date: str(e.age),
        duration: str(video?.duration),
        channel: str(video?.creator),
        image: strField(readObject(e, "thumbnail"), "src"),
        provider: "brave" as const,
      } satisfies SearchResult;
    }),
  )
    .filter((r) => r.url)
    .slice(0, limit);
}

/**
 * Brave has no standalone places endpoint: web-search `locations.results[]`
 * carry temporary POI ids (expire ~8h) that a later /local/pois call can use.
 */
export function normalizeBraveLocations(payload: unknown, limit: number): PlaceResult[] {
  const locations = readObject(payload, "locations");
  const results = readArray(locations, "results");
  return results
    .flatMap((e, i): PlaceResult[] => {
      const id = str(e.id);
      if (!id) return [];
      return [
        {
          rank: i + 1,
          name: str(e.title) ?? "(unnamed place)",
          address: str(readObject(e, "postal_address")?.postOfficeBox) ?? str(e.address),
          website: str(e.url),
          placeId: id,
          placeIdTtl: "8h" as const,
          provider: "brave" as const,
        },
      ];
    })
    .slice(0, limit);
}

// ─── utilities ───────────────────────────────────────────────────────────────

function readArray(payload: unknown, key: string): SerperEntry[] {
  if (payload === null || typeof payload !== "object") return [];
  const arr = (payload as Record<string, unknown>)[key];
  return Array.isArray(arr) ? (arr.filter((e) => e !== null && typeof e === "object") as SerperEntry[]) : [];
}

function readObject(payload: unknown, key: string): SerperEntry | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return v !== null && typeof v === "object" ? (v as SerperEntry) : undefined;
}

function extractMetaDate(entry: SerperEntry): string | undefined {
  const meta = readObject(entry, "meta_url");
  return str(meta?.["age"]) ?? undefined;
}

function strField(obj: SerperEntry | undefined, key: string): string | undefined {
  return str(obj?.[key]);
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
