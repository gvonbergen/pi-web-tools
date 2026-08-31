/** Provider adapter surface shared by Serper and Brave. */

import type { PlaceResult, ProviderId, SearchResult } from "../normalize.ts";

export type SearchKind = "web" | "news" | "images" | "videos";

export interface SearchParams {
  kind?: SearchKind;
  query: string;
  num: number;
  page: number; // 0-based
  gl?: string; // country code
  hl?: string; // language code
  /** Time filter: Serper qdr letter (h/d/w/m/y) or Brave freshness. */
  tbs?: "h" | "d" | "w" | "m" | "y";
  safesearch: "off" | "moderate" | "strict";
  /** Optional lat,lng center for places (Serper). */
  ll?: string;
  /** Brave-only extra snippets passthrough (news/web). */
  extraSnippets?: boolean;
}

export interface CallOpts {
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface SearchOutcome {
  results: SearchResult[];
  /** Optional operator/LLM-facing cost note (e.g. Serper images >10 = 2 credits). */
  costNote?: string;
}

export interface SearchAdapter {
  id: ProviderId;
  enabled(): boolean;
  supports(kind: SearchKind | "places"): boolean;
  search(kind: SearchKind, params: SearchParams, opts: CallOpts): Promise<SearchOutcome>;
  places?(params: SearchParams, opts: CallOpts): Promise<PlaceResult[]>;
}
