/**
 * Serper.dev adapter (Google SERP proxy).
 * Auth: `X-API-KEY` header. POST JSON to https://google.serper.dev/{endpoint}.
 * 1 credit per search/news/videos/places call; images cost 2 credits when
 * num > 10 (surfaced as a costNote, never silently).
 */

import { WebToolsError } from "../errors.ts";
import { normalizeSerperImages, normalizeSerperNews, normalizeSerperPlaces, normalizeSerperVideos, normalizeSerperWeb, type PlaceResult } from "../normalize.ts";
import { providerRequest } from "./http.ts";
import type { CallOpts, SearchAdapter, SearchKind, SearchOutcome, SearchParams } from "./types.ts";

const BASE_URL = "https://google.serper.dev";

const KIND_ENDPOINT: Record<SearchKind, string> = {
  web: "/search",
  news: "/news",
  images: "/images",
  videos: "/videos",
};

const QDR_TO_TBS: Record<string, string> = {
  h: "qdr:h",
  d: "qdr:d",
  w: "qdr:w",
  m: "qdr:m",
  y: "qdr:y",
};

export class SerperAdapter implements SearchAdapter {
  readonly id = "serper" as const;

  constructor(private readonly apiKey: string | undefined) {}

  enabled(): boolean {
    return Boolean(this.apiKey);
  }

  supports(kind: SearchKind | "places"): boolean {
    return true; // serper covers all v0.1 verticals
  }

  async search(kind: SearchKind, params: SearchParams, opts: CallOpts): Promise<SearchOutcome> {
    if (!this.apiKey) throw new WebToolsError("E_NO_PROVIDER", "Serper is not configured", { hint: "Set SERPER_API_KEY" });
    const body: Record<string, unknown> = {
      q: params.query,
      num: clamp(params.num, 1, 100),
      page: params.page + 1, // Serper pages are 1-based
      autocorrect: false,
    };
    if (params.gl) body.gl = params.gl.toLowerCase();
    if (params.hl) body.hl = params.hl.toLowerCase();
    if (params.tbs) body.tbs = QDR_TO_TBS[params.tbs] ?? params.tbs;

    let payload: unknown;
    try {
      const res = await providerRequest(
        `${BASE_URL}${KIND_ENDPOINT[kind]}`,
        { method: "POST", body: JSON.stringify(body) },
        {
          provider: "serper",
          apiSecret: this.apiKey,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
          headers: { "content-type": "application/json" },
        },
      );
      payload = JSON.parse(res.bodyText) as unknown;
    } catch (err) {
      if (err instanceof WebToolsError && err.code === "E_RATE_LIMIT") {
        // Serper 429 doubles as "credits exhausted" and carries no Retry-After
        // or balance header; after bounded retries surface quota guidance.
        throw new WebToolsError("E_QUOTA_EXHAUSTED", "Serper rate limit persisted after retries (rate limit or credits exhausted)", {
          hint: "Check your credit balance in the Serper dashboard; credits are not queryable via API.",
        });
      }
      throw err;
    }

    const limit = clamp(params.num, 1, 100);
    const results =
      kind === "web"
        ? normalizeSerperWeb(payload, limit)
        : kind === "news"
          ? normalizeSerperNews(payload, limit)
          : kind === "images"
            ? normalizeSerperImages(payload, limit)
            : normalizeSerperVideos(payload, limit);

    const costNote = kind === "images" && params.num > 10 ? "Serper images with num>10 consume 2 credits per call." : undefined;
    return { results, costNote };
  }

  async places(params: SearchParams, opts: CallOpts): Promise<PlaceResult[]> {
    if (!this.apiKey) throw new WebToolsError("E_NO_PROVIDER", "Serper is not configured", { hint: "Set SERPER_API_KEY" });
    const body: Record<string, unknown> = {
      q: params.query,
      gl: params.gl?.toLowerCase(),
      hl: params.hl?.toLowerCase(),
      page: params.page + 1,
    };
    if (params.ll) body.ll = params.ll;
    const res = await providerRequest(
      `${BASE_URL}/places`,
      { method: "POST", body: JSON.stringify(clean(body)) },
      {
        provider: "serper",
        apiSecret: this.apiKey,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        headers: { "content-type": "application/json" },
      },
    );
    return normalizeSerperPlaces(JSON.parse(res.bodyText) as unknown, clamp(params.num, 1, 20));
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clean(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}
