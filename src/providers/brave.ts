/**
 * Brave Search API adapter (independent index).
 * Auth: `X-Subscription-Token` header. GET with query params against
 * https://api.search.brave.com/res/v1. Places use the two-step flow:
 * web-search `locations` ids (expire ~8h) + /local/pois + /local/descriptions.
 */

import { WebToolsError } from "../errors.ts";
import {
  normalizeBraveImages,
  normalizeBraveLocations,
  normalizeBraveNews,
  normalizeBraveVideos,
  normalizeBraveWeb,
  type PlaceResult,
} from "../normalize.ts";
import { providerRequest } from "./http.ts";
import type { CallOpts, SearchAdapter, SearchKind, SearchOutcome, SearchParams } from "./types.ts";

const BASE_URL = "https://api.search.brave.com/res/v1";

const KIND_PATH: Record<SearchKind, string> = {
  web: "/web/search",
  news: "/news/search",
  images: "/images/search",
  videos: "/videos/search",
};

/** Per-vertical count caps from Brave's API docs. */
const COUNT_CAP: Record<SearchKind, number> = { web: 20, news: 50, images: 200, videos: 50 };
const OFFSET_CAP: Record<SearchKind, number> = { web: 9, news: 9, images: 9, videos: 9 };

const QDR_TO_FRESHNESS: Record<string, string> = { h: "pd", d: "pd", w: "pw", m: "pm", y: "py" };

export class BraveAdapter implements SearchAdapter {
  readonly id = "brave" as const;

  constructor(private readonly apiKey: string | undefined) {}

  enabled(): boolean {
    return Boolean(this.apiKey);
  }

  supports(kind: SearchKind | "places"): boolean {
    return true; // places via two-step flow
  }

  async search(kind: SearchKind, params: SearchParams, opts: CallOpts): Promise<SearchOutcome> {
    if (!this.apiKey) throw new WebToolsError("E_NO_PROVIDER", "Brave is not configured", { hint: "Set BRAVE_API_KEY" });

    const count = Math.min(Math.max(1, Math.round(params.num)), COUNT_CAP[kind]);
    // Brave paginates with count+offset; offset is hard-capped per endpoint.
    const offset = Math.min(params.page * count, OFFSET_CAP[kind]);
    const q = new URLSearchParams({
      q: params.query,
      count: String(count),
      offset: String(offset),
      safesearch: kind === "images" ? (params.safesearch === "off" ? "off" : "strict") : params.safesearch,
      spellcheck: "true",
    });
    if (params.gl) q.set("country", params.gl.toUpperCase());
    if (params.hl) q.set("search_lang", params.hl.toLowerCase());
    if (params.tbs) q.set("freshness", QDR_TO_FRESHNESS[params.tbs] ?? params.tbs);
    if (params.extraSnippets && (kind === "web" || kind === "news")) q.set("extra_snippets", "true");

    const res = await providerRequest(
      `${BASE_URL}${KIND_PATH[kind]}?${q.toString()}`,
      { method: "GET" },
      { provider: "brave", apiSecret: this.apiKey, timeoutMs: opts.timeoutMs, signal: opts.signal },
    );
    const payload = JSON.parse(res.bodyText) as unknown;

    const results =
      kind === "web"
        ? normalizeBraveWeb(payload, count)
        : kind === "news"
          ? normalizeBraveNews(payload, count)
          : kind === "images"
            ? normalizeBraveImages(payload, count)
            : normalizeBraveVideos(payload, count);
    return { results };
  }

  async places(params: SearchParams, opts: CallOpts): Promise<PlaceResult[]> {
    if (!this.apiKey) throw new WebToolsError("E_NO_PROVIDER", "Brave is not configured", { hint: "Set BRAVE_API_KEY" });

    // Step 1: web search surfaces locations with temporary POI ids.
    const q = new URLSearchParams({
      q: params.query,
      count: String(Math.min(Math.max(1, params.num), 20)),
      offset: "0",
      country: params.gl?.toUpperCase() ?? "ALL",
      search_lang: params.hl?.toLowerCase() ?? "en",
      result_filter: "locations",
    });
    const webRes = await providerRequest(
      `${BASE_URL}/web/search?${q.toString()}`,
      { method: "GET" },
      { provider: "brave", apiSecret: this.apiKey, timeoutMs: opts.timeoutMs, signal: opts.signal },
    );
    const payload = JSON.parse(webRes.bodyText) as unknown;
    const named = normalizeBraveLocations(payload, params.num);

    if (named.length === 0) return [];

    // Step 2: enrich with /local/pois (≤20 ids) + /local/descriptions.
    const ids = named.slice(0, 20).map((p) => p.placeId);
    const [pois, descriptions] = await Promise.all([
      this.fetchLocal(`${BASE_URL}/local/pois`, ids, params, opts),
      this.fetchLocal(`${BASE_URL}/local/descriptions`, ids, params, opts),
    ]);

    return named.map((place) => {
      const poi = pois[place.placeId] ?? {};
      const desc = descriptions[place.placeId] ?? {};
      const coords = readObj(poi, "coordinates");
      const rating = readObj(poi, "rating");
      return {
        ...place,
        address: strOf(readObj(readObj(poi, "postal_address"), "displayAddress")) ?? place.address,
        lat: numOf(coords?.latitude),
        lng: numOf(coords?.longitude),
        rating: numOf(rating?.ratingValue),
        ratingCount: numOf(rating?.reviewCount),
        phone: strOf(poi.phone),
        website: strOf(poi.url) || place.website,
        category: strOf(desc.description) ?? strOf(desc.title) ?? place.category,
        placeIdTtl: "8h" as const,
      } satisfies PlaceResult;
    });
  }

  private async fetchLocal(
    base: string,
    ids: string[],
    params: SearchParams,
    opts: CallOpts,
  ): Promise<Record<string, Record<string, unknown>>> {
    const q = new URLSearchParams({ ids: ids.join(",") });
    if (base.endsWith("/pois")) {
      q.set("search_lang", params.hl?.toLowerCase() ?? "en");
      q.set("ui_lang", params.hl?.toLowerCase() ?? "en");
    }
    try {
      const res = await providerRequest(
        `${base}?${q.toString()}`,
        { method: "GET" },
        { provider: "brave", apiSecret: this.apiKey ?? "", timeoutMs: opts.timeoutMs, signal: opts.signal },
      );
      const payload = JSON.parse(res.bodyText) as unknown;
      // /local/pois returns an array of POI objects with `id`;
      // /local/descriptions returns [{id, description}].
      if (Array.isArray(payload)) {
        const map: Record<string, Record<string, unknown>> = {};
        for (const item of payload) {
          if (item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
            map[(item as Record<string, unknown>).id as string] = item as Record<string, unknown>;
          }
        }
        return map;
      }
      return {};
    } catch (err) {
      // Enrichment is best-effort: named locations are still useful.
      if (err instanceof WebToolsError && (err.code === "E_TIMEOUT" || err.code === "E_NETWORK" || err.code === "E_RATE_LIMIT")) {
        return {};
      }
      throw err;
    }
  }
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readObj(v: unknown, key: string): Record<string, unknown> | undefined {
  if (v && typeof v === "object") {
    const inner = (v as Record<string, unknown>)[key];
    return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : undefined;
  }
  return undefined;
}
