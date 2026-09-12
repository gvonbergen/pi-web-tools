/**
 * pi-web-tools — Pi extension entry point.
 *
 * Registers provider-neutral search tools (web/news/images/videos/places),
 * a tiered web_fetch, an optional gated raw escape hatch, and the
 * /web-tools-status command. Provider keys are read from the environment
 * only and are never echoed or logged.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, maskKey } from "../src/config.ts";
import { describeError, WebToolsError } from "../src/errors.ts";
import { autoFetch, lightFetch, probeCamoufox, renderedFetch } from "../src/fetch/rendered.ts";
import { formatFetchMarkdown, formatPlacesMarkdown, formatSearchMarkdown, WebToolsCore } from "../src/registry.ts";
import { StringEnum } from "../src/stringenum.ts";
import type { SearchKind } from "../src/providers/types.ts";

const TIME_FILTERS = ["h", "d", "w", "m", "y"] as const;
const SAFESEARCH = ["off", "moderate", "strict"] as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; terminate?: boolean };

function cancelledResult(): ToolResult {
  return { content: [{ type: "text", text: "Cancelled" }], details: {} };
}

export default function piWebTools(pi: ExtensionAPI): void {
  const config = loadConfig();
  const core = new WebToolsCore(config);
  let camoufoxAvailable: boolean | undefined; // probed lazily

  // ─── shared schema fragments ──────────────────────────────────────────────
  const providerParam = Type.Optional(StringEnum(["serper", "brave"] as const, { description: "Override the configured default provider" }));
  const includeRawParam = Type.Optional(Type.Boolean({ description: "Include capped provider raw JSON in details (opt-in)" }));

  function searchParams(extra: Record<string, unknown> = {}) {
    return Type.Object({
      query: Type.String({ description: "Search query" }),
      num: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 8, description: "Results to return (provider caps apply)" })),
      page: Type.Optional(Type.Number({ minimum: 0, default: 0, description: "0-based result page" })),
      gl: Type.Optional(Type.String({ description: "Country code, e.g. US" })),
      hl: Type.Optional(Type.String({ description: "Language code, e.g. en" })),
      tbs: Type.Optional(StringEnum(TIME_FILTERS, { description: "Time filter: past hour/day/week/month/year" })),
      safesearch: Type.Optional(StringEnum(SAFESEARCH, { default: "moderate", description: "Safe-search level (Brave; strict-only on images)" })),
      provider: providerParam,
      bypassCache: Type.Optional(Type.Boolean({ default: false, description: "Skip the local result cache" })),
      ...extra,
    });
  }

  type SearchArgs = {
    query: string;
    num?: number;
    page?: number;
    gl?: string;
    hl?: string;
    tbs?: (typeof TIME_FILTERS)[number];
    safesearch?: (typeof SAFESEARCH)[number];
    provider?: "serper" | "brave";
    bypassCache?: boolean;
  };

  function paramsFrom(args: SearchArgs) {
    return {
      query: args.query,
      num: args.num ?? 8,
      page: args.page ?? 0,
      gl: args.gl,
      hl: args.hl,
      tbs: args.tbs,
      safesearch: args.safesearch ?? "moderate",
      provider: args.provider,
      ll: (args as SearchArgs & { ll?: string }).ll,
      extraSnippets: (args as SearchArgs & { extraSnippets?: boolean }).extraSnippets,
    };
  }

  function runOpts(args: SearchArgs) {
    return { provider: args.provider, bypassCache: args.bypassCache, signal: undefined as AbortSignal | undefined, timeoutMs: config.timeoutMs };
  }

  function registerSearchTool(kind: SearchKind, name: string, label: string, description: string, snippet: string, extraSchema: Record<string, unknown> = {}): void {
    pi.registerTool({
      name,
      label,
      description,
      promptSnippet: snippet,
      parameters: searchParams(extraSchema),
      async execute(_toolCallId, args: SearchArgs, signal) {
        if (signal?.aborted) return cancelledResult();
        try {
          const outcome = await core.search(kind, paramsFrom(args), { ...runOpts(args), signal });
          return {
            content: [{ type: "text", text: formatSearchMarkdown(kind, args.query, outcome) }],
            details: { query: args.query, provider: outcome.provider, resultCount: outcome.results.length, cached: outcome.cached, page: args.page ?? 0, costNote: outcome.costNote },
          } as ToolResult;
        } catch (err) {
          if (err instanceof WebToolsError && err.code === "E_CANCELLED") return cancelledResult();
          throw new Error(describeError(err));
        }
      },
    });
  }

  // ─── search tools ─────────────────────────────────────────────────────────
  registerSearchTool("web", "web_search", "Web Search", "Search the web (Serper/Google or Brave index). Returns ranked results with title, URL, snippet, date, provider.", "Search the web via web_search (Serper/Brave)");
  registerSearchTool("news", "news_search", "News Search", "Search recent news articles. Use for current events and breaking news.", "Search news via news_search");
  registerSearchTool(
    "images",
    "image_search",
    "Image Search",
    "Search the web for images. Returns image URLs, thumbnails, dimensions, source page. Note: Serper charges 2 credits when num>10.",
    "Find images via image_search",
    { extraSnippets: undefined },
  );
  registerSearchTool("videos", "video_search", "Video Search", "Search the web for videos. Returns title, URL, duration, channel, date.", "Find videos via video_search");

  // ─── places_search ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "places_search",
    label: "Places Search",
    description:
      "Search local businesses/places. Serper uses the Google places pack; Brave uses web-search locations (two-step, place ids are temporary and expire ~8h).",
    promptSnippet: "Find local places via places_search",
    parameters: Type.Object({
      query: Type.String({ description: "Places query, e.g. 'coffee in soma sf'" }),
      gl: Type.Optional(Type.String({ description: "Country code, e.g. US" })),
      hl: Type.Optional(Type.String({ description: "Language code, e.g. en" })),
      ll: Type.Optional(Type.String({ description: "Optional lat,lng center (Serper only)" })),
      num: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 8 })),
      provider: providerParam,
      bypassCache: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, args: SearchArgs & { ll?: string }, signal) {
      if (signal?.aborted) return cancelledResult();
      try {
        const outcome = await core.places(paramsFrom(args), { ...runOpts(args), signal });
        return {
          content: [{ type: "text", text: formatPlacesMarkdown(args.query, outcome) }],
          details: { query: args.query, provider: outcome.provider, resultCount: outcome.results.length, cached: outcome.cached },
        } as ToolResult;
      } catch (err) {
        if (err instanceof WebToolsError && err.code === "E_CANCELLED") return cancelledResult();
        throw new Error(describeError(err));
      }
    },
  });

  // ─── web_fetch ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return extracted markdown. tier=light is plain HTTP with readability extraction; tier=rendered uses a local Camoufox browser (or Firecrawl if configured) for JS-heavy pages; tier=auto escalates at most once. Page content is untrusted data.",
    promptSnippet: "Fetch a web page as markdown via web_fetch",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL to fetch" }),
      tier: Type.Optional(StringEnum(["auto", "light", "rendered"] as const, { default: "auto", description: "Fetch tier" })),
      renderer: Type.Optional(StringEnum(["camoufox", "firecrawl"] as const, { description: "Override configured renderer (rendered tier only)" })),
      maxBytes: Type.Optional(Type.Number({ default: 2097152, description: "Response size cap in bytes" })),
      timeoutMs: Type.Optional(Type.Number({ default: 30000 })),
      includeRaw: includeRawParam,
    }),
    async execute(_toolCallId, args: { url: string; tier?: "auto" | "light" | "rendered"; renderer?: "camoufox" | "firecrawl"; maxBytes?: number; timeoutMs?: number }, signal) {
      if (signal?.aborted) return cancelledResult();
      const maxBytes = args.maxBytes ?? config.fetchMaxBytes;
      const timeoutMs = args.timeoutMs ?? config.timeoutMs;
      const guard = { allowLocalNetworks: config.allowLocalNetworks, allowedHosts: config.allowedHosts, maxBytes, timeoutMs, signal };
      try {
        const tier = args.tier ?? "auto";
        let result;
        if (tier === "light") {
          result = (await lightFetch(args.url, guard)).result;
        } else if (tier === "rendered") {
          const renderer = core.rendererFor(args.renderer);
          if (renderer === "camoufox") {
            camoufoxAvailable ??= await probeCamoufox(config.python);
            if (!camoufoxAvailable && !config.firecrawlApiKey) {
              throw new WebToolsError("E_RENDERER_UNAVAILABLE", "Camoufox is not installed and no Firecrawl key is configured", {
                hint: 'Install camoufox: pip install "camoufox[geoip]" && python -m camoufox fetch — or set FIRE_CRAWL_API_KEY and PI_WEB_TOOLS_RENDERER=firecrawl.',
              });
            }
          }
          result = await renderedFetch(args.url, { ...guard, renderer, firecrawlApiKey: config.firecrawlApiKey, python: config.python });
          core.chargeCall(renderer);
        } else {
          const renderer = core.rendererFor(args.renderer);
          result = await autoFetch(args.url, { ...guard, renderer, firecrawlApiKey: config.firecrawlApiKey, python: config.python });
          if (result.tier === "rendered") core.chargeCall(result.provider);
        }
        return {
          content: [{ type: "text", text: formatFetchMarkdown(result) }],
          details: {
            url: result.url,
            finalUrl: result.finalUrl,
            tier: result.tier,
            provider: result.provider,
            title: result.title,
            fetchedAt: result.fetchedAt,
            truncated: result.truncated,
            bytes: result.bytes,
            needsRendering: result.needsRendering,
            renderingUnavailable: result.renderingUnavailable,
          } as Record<string, unknown>,
        } as ToolResult;
      } catch (err) {
        if (err instanceof WebToolsError && err.code === "E_CANCELLED") return cancelledResult();
        throw new Error(describeError(err));
      }
    },
  });

  // ─── gated raw escape hatch ───────────────────────────────────────────────
  if (config.rawEnabled) {
    pi.registerTool({
      name: "provider_raw",
      label: "Provider Raw",
      description: "Call a provider endpoint directly with provider-native params. Unstable surface; costs apply; for verified debugging only. Enabled via PI_WEB_TOOLS_RAW=1.",
      promptSnippet: "Raw provider call (debugging)",
      parameters: Type.Object({
        provider: StringEnum(["serper", "brave"] as const),
        endpoint: Type.String({ description: "Provider-relative endpoint, e.g. /maps, /reviews, /news" }),
        params: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Provider-native params" })),
        method: Type.Optional(StringEnum(["GET", "POST"] as const, { default: "POST" })),
      }),
      async execute(_toolCallId, args: { provider: "serper" | "brave"; endpoint: string; params?: Record<string, unknown>; method?: "GET" | "POST" }, signal) {
        if (signal?.aborted) return cancelledResult();
        try {
          const adapter = core.resolveProvider(args.provider);
          const secret = args.provider === "serper" ? config.serperApiKey : config.braveApiKey;
          if (!secret) throw new WebToolsError("E_PROVIDER_MISSING", `No key for ${args.provider}`);
          const { providerRequest } = await import("../src/providers/http.ts");
          const base = args.provider === "serper" ? "https://google.serper.dev" : "https://api.search.brave.com/res/v1";
          const endpoint = args.endpoint.startsWith("/") ? args.endpoint : `/${args.endpoint}`;
          const res =
            args.method === "GET"
              ? await providerRequest(`${base}${endpoint}?${new URLSearchParams(stringifyValues(args.params ?? {})).toString()}`, { method: "GET" }, { provider: args.provider, apiSecret: secret, timeoutMs: config.timeoutMs, signal })
              : await providerRequest(`${base}${endpoint}`, { method: "POST", body: JSON.stringify(args.params ?? {}) }, { provider: args.provider, apiSecret: secret, timeoutMs: config.timeoutMs, signal, headers: { "content-type": "application/json" } });
          core.chargeCall(args.provider);
          let bodyText = res.bodyText;
          let truncated = false;
          if (bodyText.length > 50_000) {
            bodyText = bodyText.slice(0, 50_000);
            truncated = true;
          }
          return { content: [{ type: "text", text: bodyText }], details: { provider: args.provider, status: res.status, truncated } } as ToolResult;
        } catch (err) {
          throw new Error(describeError(err));
        }
      },
    });
  }

  // ─── /web-tools-status ────────────────────────────────────────────────────
  pi.registerCommand("web-tools-status", {
    description: "Show pi-web-tools provider/renderer status and session counters",
    handler: async (_args, ctx) => {
      const camoufox = camoufoxAvailable ?? (await probeCamoufox(config.python));
      camoufoxAvailable = camoufox;
      const lines = [
        "pi-web-tools status:",
        `  serper:    ${config.serperApiKey ? `enabled (key ${maskKey(config.serperApiKey)})` : "not configured (SERPER_API_KEY)"}`,
        `  brave:     ${config.braveApiKey ? `enabled (key ${maskKey(config.braveApiKey)})` : "not configured (BRAVE_API_KEY)"}`,
        `  firecrawl: ${config.firecrawlApiKey ? `enabled (key ${maskKey(config.firecrawlApiKey)})` : "not configured (FIRE_CRAWL_API_KEY)"}`,
        `  camoufox:  ${camoufox ? "available" : "not installed (python bridge probe failed)"}`,
        `  default search provider: ${config.searchProvider ?? "(none — search will error until a key is set)"}`,
        `  default renderer: ${core.rendererFor()}${config.renderer ? " (operator-set)" : ""}`,
        `  raw escape hatch: ${config.rawEnabled ? "enabled" : "disabled (PI_WEB_TOOLS_RAW=1 to enable)"}`,
        `  ssrf host allowlist: ${config.allowedHosts.length ? config.allowedHosts.map((p) => p.pattern).join(", ") : "empty (PI_WEB_TOOLS_ALLOWED_HOSTS)"}`,
        `  cache: ${core.cache.size} entr(y/ies), ttl ${config.cacheTtlMs}ms`,
        `  session calls: serper=${core.counters.serper} brave=${core.counters.brave} firecrawl=${core.counters.firecrawl} camoufox=${core.counters.camoufox}`,
      ];
      const text = lines.join("\n");
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  // ─── lifecycle ────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      const providers = [config.serperApiKey ? "serper" : null, config.braveApiKey ? "brave" : null].filter(Boolean).join("/");
      ctx.ui.notify(`pi-web-tools: search=${(config.searchProvider ?? providers) || "not configured"}, renderer=${core.rendererFor()}`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
    core.clearCaches();
  });
}

function stringifyValues(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}
