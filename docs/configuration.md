# Configuration

All configuration is environment-only (no config files in v0.1). Precedence: env var > compiled default. Secrets are read from the environment only and are never stored in repo files, logs, or tool output.

| Variable | Meaning | Default |
|---|---|---|
| `SERPER_API_KEY` | Serper.dev key (`X-API-KEY`) | unset → Serper disabled |
| `BRAVE_API_KEY` | Brave Search API key (`X-Subscription-Token`) | unset → Brave disabled |
| `FIRE_CRAWL_API_KEY` | Firecrawl key | unset → Firecrawl disabled on the cloud endpoint; optional when `PI_WEB_TOOLS_FIRECRAWL_BASE_URL` points at a self-hosted server |
| `PI_WEB_TOOLS_FIRECRAWL_BASE_URL` | Firecrawl server base URL (self-hosted/local server); `/v2/scrape` is appended | `https://api.firecrawl.dev` |
| `PI_WEB_TOOLS_SEARCH_PROVIDER` | `serper` \| `brave` — default provider | `serper` if its key is present, else `brave` |
| `PI_WEB_TOOLS_RENDERER` | `camoufox` \| `firecrawl` — rendered-tier engine | `camoufox` (local-first); falls to `firecrawl` only when explicitly selected |
| `PI_WEB_TOOLS_RAW` | `1` enables the `provider_raw` escape hatch | `0` |
| `PI_WEB_TOOLS_CACHE_TTL_MS` | search cache TTL | `300000` (5 min) |
| `PI_WEB_TOOLS_CACHE_MAX_ENTRIES` | cache capacity (LRU) | `500` |
| `PI_WEB_TOOLS_MAX_CALLS_PER_SESSION` | per-session call budget across providers (`0` = unlimited) | `0` |
| `PI_WEB_TOOLS_ALLOW_LOCAL_NETWORKS` | `1` allows private/loopback/link-local targets (dev only; disables SSRF blocking) | `0` |
| `PI_WEB_TOOLS_ALLOWED_HOSTS` | comma-separated host allowlist exempt from SSRF/private-address checks (e.g. `*.v7n.ch,v7n.ch`) | empty (no exceptions) |
| `PI_WEB_TOOLS_FETCH_MAX_CHARS` | default for per-call [`maxChars`](../README.md#web_fetch) (characters of returned content; `PI_WEB_TOOLS_FETCH_MAX_BYTES` is a deprecated alias) | `2097152` |
| `PI_WEB_TOOLS_RAW_BODY_MAX_BYTES` | [raw-response safety cap](security.md#resource-limits); minimum 1 MiB (lower values fail startup with `E_CONFIG`) | `33554432` (32 MiB) |
| `PI_WEB_TOOLS_TIMEOUT_MS` | per-request timeout | `30000` |
| `PI_WEB_TOOLS_PYTHON` | python3 executable for the Camoufox bridge | `python3` |
| `PI_WEB_TOOLS_PROVIDER_CONCURRENCY` | in-process provider-call semaphore | `3` |

## Behavior notes

- **No silent fallbacks.** If the selected provider's key is missing, tools throw `E_NO_PROVIDER` / `E_PROVIDER_MISSING` with setup guidance; they never silently switch providers.
- **Firecrawl server URL.** `PI_WEB_TOOLS_FIRECRAWL_BASE_URL` points the Firecrawl renderer at a self-hosted/local server (e.g. `http://localhost:3002`); the client always appends `/v2/scrape`, so give the bare base URL only. Trailing slashes are stripped automatically. The value must be a bare http(s) URL — schemes other than http/https, embedded `user:pass@` credentials, and query strings/fragments fail extension load with `E_CONFIG` (fail closed).
- **Firecrawl authentication.** The cloud host (`api.firecrawl.dev`, including scheme/case variants) requires `FIRE_CRAWL_API_KEY` and sends it as a Bearer token; requests without it fail with `E_RENDERER_UNAVAILABLE`. A self-hosted server configured via `PI_WEB_TOOLS_FIRECRAWL_BASE_URL` can run keyless: with no key configured, no Authorization header is sent at all — no empty or placeholder header. If a key is set, it is still sent as a Bearer token, so the same configuration works for authenticated self-hosted instances too.
- Tools are registered dynamically: only configured providers are advertised; with no keys, search tools still register but every call fails with an actionable error.
- `PI_WEB_TOOLS_ALLOW_LOCAL_NETWORKS=1` is a developer convenience that disables all SSRF blocking; do not enable it in environments that touch untrusted URLs.
- `PI_WEB_TOOLS_ALLOWED_HOSTS` is a narrow per-host SSRF exception (see [security.md](security.md)): exact hostnames (`v7n.ch`) or wildcard subdomains (`*.v7n.ch`, matches subdomains at any depth but **not** the apex — list the apex explicitly too). IP literals, bare `*`, schemes/ports/paths, and any other malformed pattern make the extension fail to load with `E_CONFIG` (fail closed). Matched hosts skip only the private-address/DNS checks; everything else — including redirects to non-allowlisted hosts — behaves exactly as before.

## Example: settings.json env hooks

```json
{
  "env": {
    "SERPER_API_KEY": "...",
    "PI_WEB_TOOLS_SEARCH_PROVIDER": "serper",
    "PI_WEB_TOOLS_ALLOWED_HOSTS": "*.v7n.ch,v7n.ch"
  }
}
```

## Example: local Firecrawl server

```bash
export PI_WEB_TOOLS_FIRECRAWL_BASE_URL=http://localhost:3002   # self-hosted server
export PI_WEB_TOOLS_RENDERER=firecrawl                          # opt in to the remote renderer
# FIRE_CRAWL_API_KEY is optional here: a keyless self-hosted server is used without an Authorization header.
```

The scrape endpoint becomes `http://localhost:3002/v2/scrape`. Without the base-URL override the cloud endpoint (`https://api.firecrawl.dev/v2/scrape`) is used, unchanged.
