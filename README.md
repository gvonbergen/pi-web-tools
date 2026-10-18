# pi-web-tools

A standalone [Pi](https://pi.dev) extension that gives your agent a unified web toolkit:

- **Search** — `web_search`, `news_search`, `image_search`, `video_search`, `places_search`
- **Fetch** — `web_fetch` with `tier=auto|light|rendered`

Two independent search providers are supported behind one provider-neutral surface:

| Provider | Index | Auth | Notes |
|---|---|---|---|
| [Serper.dev](https://serper.dev) | Google SERP | `SERPER_API_KEY` | covers all verticals incl. dedicated places; 1 credit/call (images `num>10` = 2 credits) |
| [Brave Search API](https://brave.com/search/api/) | Brave's own index | `BRAVE_API_KEY` | places via a two-step flow with short-lived (~8 h) POI ids |

**Default provider:** Serper when both keys are set (captain decision D1); override with `PI_WEB_TOOLS_SEARCH_PROVIDER=serper|brave`. There is **no silent cross-provider fallback** — a missing key is a loud, typed error.

## Installation

```bash
# from a git ref (recommended)
pi install git:github.com/gvonbergen/pi-web-tools@v0.2.0

# or temporarily for one run
pi -e git:github.com/gvonbergen/pi-web-tools
```

Set your keys in the environment (e.g. via `~/.pi/agent/settings.json` env hooks or your shell profile) — never in files committed to a repo.

## Tools

### web_search / news_search / image_search / video_search

Shared parameters: `query`, `num` (1–20), `page` (0-based), `gl` (country), `hl` (language), `tbs` (time filter `h|d|w|m|y`), `safesearch` (`off|moderate|strict`), `provider` (override), `bypassCache`.

Every result carries a provider badge (`[Serper]` / `[Brave]`) in the markdown output and a `provider` field in `details`. Duplicate URLs in one result set are collapsed. Results are cached in memory for 5 minutes (configurable).

> ⚠️ Cost note: Serper images with `num>10` consume 2 credits per call; the tool surfaces this in its output.

### places_search

Serper uses the Google places pack (stable `cid` ids). Brave uses web-search locations enriched via `/local/pois` + `/local/descriptions`; its `placeId`s are **temporary and expire after ~8 hours** — the tool annotates them accordingly. `place_details` is planned for v0.2.

### web_fetch

```jsonc
{ "url": "https://example.com", "tier": "auto", "renderer": "camoufox", "maxChars": 2097152, "timeoutMs": 30000 }
```

- **`maxChars` (content cap)** — bounds the **extracted/cleaned** markdown or text returned to the agent, not the raw response. Raw responses that exceed the caller cap but extract to a smaller cleaned result succeed normally (e.g. a markup-heavy HTML page extracting to a short markdown). Content over the cap is truncated with `truncated: true` plus a warning telling you to raise `maxChars` — it is **not** an error. Units are characters of the returned markdown/text (whole characters are preserved; there is no token-based limit). See [configuration](docs/configuration.md) for the default.
  - *Deprecated alias:* `maxBytes` still works with the same value semantics for backward compatibility, but it caps characters, not bytes; using it adds a one-time deprecation note to the result. Prefer `maxChars`.
- **Raw-response safety cap (independent)** — see [resource limits](docs/security.md#resource-limits) for protection before extraction and renderer-specific scope; it is never derived from `maxChars`.

- **`tier=light`** — plain HTTP: SSRF guard, ≤5 redirects with per-hop re-check, MIME gating, Readability → DOMPurify → Turndown extraction to markdown. Optional pdftotext (poppler) for PDFs. Named hosts whose DNS deliberately resolves into private space can be exempted via `PI_WEB_TOOLS_ALLOWED_HOSTS` (per-host opt-in, empty by default — see [docs/security.md](docs/security.md)).
  - *Migration note:* previously the caller cap applied to the raw decompressed body; it now applies to the extracted markdown. Calls that previously failed with `E_CONTENT_TOO_LARGE` on markup-heavy pages now succeed; raw-response protection moved to the independent safety cap (`E_RAW_TOO_LARGE`).
- **`tier=rendered`** — JavaScript-heavy pages. Default renderer: **Camoufox** (local, free; captain decision D2). Firecrawl (remote) is available via `PI_WEB_TOOLS_RENDERER=firecrawl` or per-call `renderer` override: point it at a self-hosted server with `PI_WEB_TOOLS_FIRECRAWL_BASE_URL` (e.g. `http://localhost:3002`, no API key needed), or use the paid cloud host `api.firecrawl.dev` with `FIRE_CRAWL_API_KEY`. Cloud-host variants still require a key. Firecrawl is **never** used as a silent fallback.
- **`tier=auto`** — runs light; if the page looks like a JS shell it escalates to rendered **at most once**. If no renderer is available, the light result is returned with `renderingUnavailable: true` instead of failing.

Fetched page content is always wrapped with an explicit *untrusted data* label so the model treats it as data, not instructions.

## Setup

```bash
# search (at least one required for search tools)
export SERPER_API_KEY=...        # https://serper.dev (2,500 free credits)
export BRAVE_API_KEY=...         # https://brave.com/search/api

# rendered fetch (optional)
pip install "camoufox[geoip]" && python -m camoufox fetch   # local renderer
export PI_WEB_TOOLS_FIRECRAWL_BASE_URL=http://localhost:3002   # or the remote renderer (self-hosted; no key needed)
export FIRE_CRAWL_API_KEY=...                                  # only for the paid cloud host (api.firecrawl.dev)
```

## Status command

`/web-tools-status` shows which providers/renderers are enabled (keys masked), the default provider/renderer, cache size, and per-session call counters. For Firecrawl, it reports `enabled keyless (self-hosted endpoint ...)` when a non-cloud base URL is configured without `FIRE_CRAWL_API_KEY`, `enabled (key ..., endpoint ...)` when a key is configured, and `not configured (FIRE_CRAWL_API_KEY; endpoint ...)` when the cloud host is selected without a key.

## Configuration

All configuration is environment-only — see [docs/configuration.md](docs/configuration.md). Security posture: [docs/security.md](docs/security.md).

## Optional raw escape hatch

Set `PI_WEB_TOOLS_RAW=1` to register `provider_raw`, a debugging-only tool that calls provider endpoints with provider-native params. Disabled by default.

## Costs and terms of service

- Serper and Brave are paid APIs with free tiers; every search consumes credits. Camoufox is local and free; Firecrawl charges per scrape and sends page URLs to a third-party service.
- Serper serves Google SERP data and Brave serves its own index; using them means accepting their respective terms. Respect target-site terms and robots directives, especially for the rendered tier.
- The operators of this extension are responsible for key management; keys are read from the environment only and are never logged or echoed.

## Development

```bash
npm install
npm run typecheck
npm test        # deterministic; no paid API calls
```

Tests cover normalizers (provider fixtures), mocked HTTP (401/429/5xx, retries, backoff), adversarial local HTTP fixtures (SSRF redirects, redirect loops, size caps, gzip bombs, MIME gating, SPA shells), caching/concurrency, cancellation, and Camoufox process cleanup. Credentialed integration tests are gated behind env keys and skipped by default.

## Versioning

Semver. Releases are git tags: `pi install git:github.com/gvonbergen/pi-web-tools@v0.2.0`. npm publishing may follow later.
