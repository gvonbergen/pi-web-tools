# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## pi-web-tools notes

- Pi extension (pi package): entry point `extensions/index.ts`; core logic in `src/` is intentionally independent of the Pi API so it is unit-testable. Pi core packages (`@earendil-works/pi-*`, `typebox`) are peerDependencies with `"*"` — never add them to `dependencies`.
- `StringEnum` is replicated locally in `src/stringenum.ts` (identical output to `@earendil-works/pi-ai`'s helper) so tests/typecheck don't need the pi runtime.
- Tests: `npm test` (vitest, deterministic, no paid API calls). `test/integration.live.test.ts` is skip-gated on env keys.
- Verify loading with: `cd /tmp && pi -ne -e <repo-path> --no-builtin-tools -p "..."` (the `-ne` avoids a tool-name collision with the locally installed `~/.pi/agent/extensions/web-fetch`, which also registers `web_fetch`).
- Captain decisions live in `/Users/gregor/Agents/firstmate/data/pi-web-tools-plan-e1/report.md` §13: D1 serper default, D2 camoufox local-first, D3 single `web_fetch` + tier, D4 `place_details` deferred to v0.2, D5 no ddgs.
- Redirect hops in `src/fetch/light.ts` are re-validated with the strict URL guard (`allowLocalNetworks: false`) regardless of the caller's override; the only exemptions are a hop staying on the original host:port and hops to hosts on the `PI_WEB_TOOLS_ALLOWED_HOSTS` allowlist (per-host opt-in, parsed by `src/security/hostpatterns.ts`, empty by default — never broadened to IP literals or a bare `*`). Do not relax this: CI runners answer link-local addresses (Azure IMDS 404 at 169.254.169.254), so guard-relaxed hops make SSRF tests environment-dependent. Malformed allowlist entries throw `E_CONFIG` at `loadConfig` (fail closed).
- web_fetch has two independent size caps (do not conflate): caller `maxBytes` bounds the extracted/cleaned markdown/text (over-cap content is truncated with `truncated: true` + warning, never an error); raw/decompressed response size is bounded by `rawBodyMaxBytes` (`PI_WEB_TOOLS_RAW_BODY_MAX_BYTES`, default 32 MiB, floor 1 MiB, `E_CONFIG` below) plus a bomb guard (expansion >100x AND decompressed >2 MiB — never ratio-only). Raw-safety overflow throws `E_RAW_TOO_LARGE` and must not trigger tier=auto escalation. Pre-2025 semantics (cap on raw body) are obsolete.
