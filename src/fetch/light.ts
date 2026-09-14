/**
 * Light fetch tier: native HTTP with SSRF-safe manual redirect handling,
 * transport and decompression size caps, MIME gating, and
 * Readability → DOMPurify → Turndown extraction to markdown.
 * No shell strings anywhere; PDFs are converted via pdftotext (poppler) when
 * available, else reported as unsupported.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { capContent } from "./content.ts";
import { spawn } from "node:child_process";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { WebToolsError } from "../errors.ts";
import type { FetchResult } from "../normalize.ts";
import { assertHostResolvesSafe, parseAndValidateUrl, type UrlGuardOptions } from "../security/urlguard.ts";

const MAX_REDIRECTS = 5;
const MIN_CONTENT_LENGTH = 300;

/**
 * Decompression-bomb ratio guard. A legit HTML/text payload rarely compresses
 * more than ~10-20x; anything expanding >100x while also exceeding 2 MiB
 * decompressed is treated as a bomb. Both conditions must hold — ratio alone
 * would false-positive on small highly-compressible pages, and the absolute
 * minimum alone would be indistinguishable from an ordinary large page.
 */
const BOMB_EXPANSION_RATIO = 100;
const BOMB_MIN_DECOMPRESSED_BYTES = 2 * 1024 * 1024;

// Binary/stream content types the light tier cannot convert to markdown.
const SKIP_CONTENT_TYPES = [
  "image/",
  "audio/",
  "video/",
  "font/",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/octet-stream",
  "application/wasm",
];

const SPA_INDICATORS = ['id="root"', 'id="app"', "__NEXT_DATA__", "window.__INITIAL_STATE__", "data-reactroot"];

const silentConsole = new VirtualConsole();
// Silence noisy JSDOM CSS/JS parse errors.
["error", "jsdomError", "warn"].forEach((ev) => silentConsole.on(ev as "error", () => {}));

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export interface LightFetchOptions extends UrlGuardOptions {
  /** Caller-facing content cap: applies to the extracted/cleaned markdown or text. */
  maxBytes: number;
  /**
   * Independent raw-response safety cap (raw, decompressed bytes), protecting
   * against decompression bombs and unbounded memory use. NOT derived from
   * maxBytes — oversized or suspiciously-expanding responses are rejected with
   * E_RAW_TOO_LARGE before extraction, while caller content over maxBytes is
   * simply truncated with truncated=true.
   */
  rawBodyMaxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LightFetchOutput {
  result: FetchResult;
  /** Raw sanitized HTML, used by the rendered tier to reuse extraction. */
  html: string;
}

export async function lightFetch(rawUrl: string, opts: LightFetchOptions): Promise<LightFetchOutput> {
  // The caller-supplied URL honors allowLocalNetworks and the explicit host
  // allowlist; redirect targets honor only the allowlist. Every hop is
  // re-validated with the FULL strict guard for allowLocalNetworks (scheme,
  // userinfo, private/loopback/link-local/ULA blocks, DNS resolution) so a
  // locally-allowed origin cannot be used as a trampoline into the internal
  // network. Two exceptions: a hop that stays on the exact host:port the
  // caller explicitly requested (no network-destination change), and hops to
  // hosts on the operator's PI_WEB_TOOLS_ALLOWED_HOSTS allowlist, which are
  // per-host opt-ins honored on every hop.
  const strictOpts: UrlGuardOptions = { allowLocalNetworks: false, allowedHosts: opts.allowedHosts };
  const entry = parseAndValidateUrl(rawUrl, opts);
  let current = entry;
  let finalUrl = current.toString();
  let response: Response | undefined;

  // Per-hop recheck: resolve DNS and verify every address is public.
  await assertHostResolvesSafe(current, opts);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await guardedFetch(current.toString(), opts);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        finalUrl = current.toString();
        break;
      }
      await response.body?.cancel();
      if (hop === MAX_REDIRECTS) {
        throw new WebToolsError("E_NETWORK", `Too many redirects (>${MAX_REDIRECTS})`);
      }
      const next = new URL(location, current);
      const exempt = opts.allowLocalNetworks && next.host === entry.host;
      const guard = exempt ? opts : strictOpts;
      // Re-validate the redirect target from scratch (scheme/userinfo/SSRF).
      current = parseAndValidateUrl(next.toString(), guard);
      if (!exempt) await assertHostResolvesSafe(current, guard);
      continue;
    }
    finalUrl = current.toString();
    break;
  }
  if (!response) throw new WebToolsError("E_NETWORK", "No response received");

  if (response.status >= 400) {
    await response.body?.cancel();
    throw new WebToolsError("E_UPSTREAM", `HTTP ${response.status} fetching ${finalUrl}`);
  }

  const contentType = (response.headers.get("content-type") ?? "application/octet-stream").toLowerCase();
  const mime = contentType.split(";")[0]!.trim();
  const charset = /charset=([\w-]+)/.exec(contentType)?.[1] ?? "utf-8";

  if (SKIP_CONTENT_TYPES.some((prefix) => mime.startsWith(prefix))) {
    await response.body?.cancel();
    throw new WebToolsError("E_UNSUPPORTED_TYPE", `Unsupported content type: ${mime}`, {
      hint: "Light fetch handles text/html, text/*, application/json, xml and PDFs.",
    });
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > opts.rawBodyMaxBytes) {
    await response.body?.cancel();
    throw new WebToolsError("E_RAW_TOO_LARGE", `Raw response body of ${contentLength} bytes exceeds the safety cap of ${opts.rawBodyMaxBytes} bytes`, {
      hint: "This safety cap bounds raw response size independently of the maxBytes content cap and cannot be raised per call (operator env: PI_WEB_TOOLS_RAW_BODY_MAX_BYTES).",
    });
  }

  const raw = await readBodyCapped(response, opts.rawBodyMaxBytes, opts.signal);
  const encoding = (response.headers.get("content-encoding") ?? "identity").toLowerCase();
  let body = raw;
  if (response.body !== null) {
    for (const layer of encoding.split(",").map((value) => value.trim()).reverse()) {
      body = decompress(body, layer, opts);
    }
    if (encoding !== "identity" && looksCompressed(body, encoding)) {
      body = decompress(body, encoding, opts);
    }
  }
  assertNotBomb(body.byteLength, raw.byteLength, opts);

  if (mime === "application/pdf") {
    return await fetchPdf(rawUrl, finalUrl, body, opts);
  }
  if (
    !(mime === "text/html" || mime === "application/xhtml+xml" || mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+xml") || mime === "application/xml" || mime === "application/javascript")
  ) {
    throw new WebToolsError("E_UNSUPPORTED_TYPE", `Unsupported content type: ${mime}`);
  }

  const text = new TextDecoder(charset, { fatal: false }).decode(body);
  if (mime === "application/json" || mime === "application/javascript") {
    return { result: finish(finalUrl, finalUrl, `JSON response (${body.length} bytes)`, body.length, text, "light", "node", {}, opts.maxBytes), html: "" };
  }
  if (!mime.includes("html") && mime.startsWith("text/")) {
    return { result: finish(finalUrl, finalUrl, undefined, body.length, "```text\n" + text + "\n```", "light", "node", {}, opts.maxBytes), html: "" };
  }

  // HTML: extract with Readability over a sanitized DOM. The caller-facing
  // maxBytes cap applies HERE — to the cleaned/extracted markdown — not to
  // the raw decompressed HTML (which is bounded by the independent safety cap).
  const { markdown, title, metadata, extractedLength } = extractHtml(text, finalUrl);
  const needsRendering = extractedLength < MIN_CONTENT_LENGTH || SPA_INDICATORS.some((i) => text.includes(i));
  const warning = needsRendering ? "Page appears to require JavaScript rendering (tier=rendered may extract more)." : undefined;
  return { result: finish(rawUrl, finalUrl, title, body.length, markdown, "light", "node", metadata, opts.maxBytes, warning, needsRendering), html: "" };
}

async function guardedFetch(url: string, opts: LightFetchOptions): Promise<Response> {
  if (opts.signal?.aborted) throw new WebToolsError("E_CANCELLED", "Cancelled");
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    return await new Promise<Response>((resolve, reject) => {
      const request = (new URL(url).protocol === "https:" ? httpsRequest : httpRequest)(url, {
        signal,
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 pi-web-tools/0.1",
          accept: "text/html,application/xhtml+xml,text/plain,application/json,application/pdf;q=0.9,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br, zstd",
        },
      }, (incoming) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const status = incoming.statusCode ?? 200;
          if ([204, 205, 304].includes(status)) {
            incoming.resume();
            resolve(new Response(null, { status, headers }));
          } else {
            resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }));
          }
        } catch (err) {
          incoming.destroy();
          reject(err);
        }
      });
      request.on("error", reject);
      request.end();
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new WebToolsError("E_CANCELLED", "Cancelled");
    const e = err as Error;
    if (e.name === "TimeoutError" || e.message.includes("abort")) {
      throw new WebToolsError("E_TIMEOUT", `Request timed out after ${opts.timeoutMs}ms`);
    }
    throw new WebToolsError("E_NETWORK", `Network error: ${e.message}`);
  }
}

async function readBodyCapped(response: Response, capBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) throw new WebToolsError("E_CANCELLED", "Cancelled");
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel errors
      }
      throw new WebToolsError(
        "E_RAW_TOO_LARGE",
        `Raw decompressed body exceeds the safety cap of ${capBytes} bytes (decompression bomb protection)`,
        { hint: "This safety cap is independent of the per-call maxBytes content cap; it bounds raw response size before extraction (operator env: PI_WEB_TOOLS_RAW_BODY_MAX_BYTES)." },
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function looksCompressed(raw: Uint8Array, encoding: string): boolean {
  if (encoding === "gzip") return raw[0] === 0x1f && raw[1] === 0x8b;
  // zlib header: CMF 0x78 (deflate, 32K window) with an FCHECK-valid FLG and no preset dictionary.
  if (encoding === "deflate") return raw[0] === 0x78 && (raw[1] === 0x01 || raw[1] === 0x5e || raw[1] === 0x9c || raw[1] === 0xda);
  // Do not guess an extra br/zstd layer after decoding the declared encodings.
  return false;
}

/** Combined ratio + absolute-size bomb guard (never ratio-only). */
function assertNotBomb(decompressedBytes: number, compressedBytes: number, opts: LightFetchOptions): void {
  if (decompressedBytes > opts.rawBodyMaxBytes) {
    throw new WebToolsError("E_RAW_TOO_LARGE", `Raw decompressed body of ${decompressedBytes} bytes exceeds the safety cap of ${opts.rawBodyMaxBytes} bytes`, {
      hint: "This safety cap is independent of the per-call maxBytes content cap (operator env: PI_WEB_TOOLS_RAW_BODY_MAX_BYTES).",
    });
  }
  if (decompressedBytes <= BOMB_MIN_DECOMPRESSED_BYTES) return;
  if (compressedBytes > 0 && decompressedBytes > BOMB_EXPANSION_RATIO * compressedBytes) {
    throw new WebToolsError(
      "E_RAW_TOO_LARGE",
      `Response expands ${Math.round(decompressedBytes / compressedBytes)}x (${compressedBytes} -> ${decompressedBytes} bytes); rejected as a probable decompression bomb`,
      { hint: "Highly-compressible oversized payloads are rejected before extraction; this safety check is independent of the maxBytes content cap." },
    );
  }

}

function decompress(raw: Uint8Array, encoding: string, opts: LightFetchOptions): Uint8Array {
  switch (encoding) {
    case "identity":
      return raw;
    case "gzip":
      return cappedDecompress(() => gunzipSync(raw, { maxOutputLength: opts.rawBodyMaxBytes }), raw.byteLength, opts);
    case "deflate":
      return cappedDecompress(() => {
        try {
          return inflateSync(raw, { maxOutputLength: opts.rawBodyMaxBytes });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).message === "incorrect header check") {
            return inflateRawSync(raw, { maxOutputLength: opts.rawBodyMaxBytes });
          }
          throw err;
        }
      }, raw.byteLength, opts);
    case "br":
      return cappedDecompress(() => brotliDecompressSync(raw, { maxOutputLength: opts.rawBodyMaxBytes }), raw.byteLength, opts);
    case "zstd":
      return cappedDecompress(() => zstdDecompressSync(raw, { maxOutputLength: opts.rawBodyMaxBytes }), raw.byteLength, opts);
    default:
      throw new WebToolsError("E_UNSUPPORTED_TYPE", `Unsupported content-encoding: ${encoding}`);
  }
}

function cappedDecompress(fn: () => Uint8Array, compressedBytes: number, opts: LightFetchOptions): Uint8Array {
  let out: Uint8Array;
  try {
    out = fn();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new WebToolsError("E_RAW_TOO_LARGE", "Decompressed response exceeds the raw-response safety cap");
    }
    throw new WebToolsError("E_UPSTREAM", `decompression failed: ${(err as Error).message}`);
  }
  assertNotBomb(out.byteLength, compressedBytes, opts);
  return out;
}

export interface ExtractedHtml {
  markdown: string;
  title?: string;
  metadata: NonNullable<FetchResult["metadata"]>;
  extractedLength: number;
}

/** Readability + DOMPurify + Turndown extraction pipeline (shared with rendered tier). */
export function extractHtml(html: string, baseUrl: string): ExtractedHtml {
  const dom = new JSDOM(html, { url: baseUrl, virtualConsole: silentConsole });
  // Sanitize before Readability: strip scripts/iframes/event handlers.
  const window = dom.window;
  const purify = DOMPurify(window);
  const doc = window.document;
  const clean = purify.sanitize(doc.documentElement.outerHTML, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "style", "form", "noscript"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    WHOLE_DOCUMENT: true,
  }) as unknown as string;
  const cleanDom = new JSDOM(clean, { url: baseUrl, virtualConsole: silentConsole });
  const article = new Readability(cleanDom.window.document).parse();

  const markdown = article?.content ? turndown.turndown(article.content) : "";
  const metadata = {
    description: article?.excerpt || undefined,
    author: article?.byline || undefined,
    publishedDate: article?.publishedTime || undefined,
    siteName: article?.siteName || undefined,
    language: article?.lang || undefined,
  };
  return {
    markdown,
    title: article?.title || undefined,
    metadata,
    extractedLength: markdown.length,
  };
}

async function fetchPdf(rawUrl: string, finalUrl: string, body: Uint8Array, opts: LightFetchOptions): Promise<LightFetchOutput> {
  const pdftotext = await probePdfTool();
  if (!pdftotext) {
    throw new WebToolsError("E_UNSUPPORTED_TYPE", "PDF fetched but pdftotext (poppler) is not installed", {
      hint: "Install poppler (brew install poppler) or fetch the rendered tier.",
    });
  }
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn("pdftotext", ["-", "-"], { stdio: ["pipe", "pipe", "pipe"] }); // shell-safe arg array
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(new WebToolsError("E_UPSTREAM", `pdftotext failed: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new WebToolsError("E_UPSTREAM", `pdftotext exited ${code}: ${err.slice(0, 200)}`))));
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.end(body);
  });
  return { result: finish(rawUrl, finalUrl, undefined, body.length, "```text\n" + text + "\n```", "light", "node", {}, opts.maxBytes), html: "" };
}

async function probePdfTool(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("pdftotext", ["-v"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  });
}

function finish(
  url: string,
  finalUrl: string,
  title: string | undefined,
  bytes: number,
  fullMarkdown: string,
  tier: "light" | "rendered",
  provider: FetchResult["provider"],
  metadata: NonNullable<FetchResult["metadata"]>,
  maxBytes: number,
  warning?: string,
  needsRendering?: boolean,
): FetchResult {
  // The caller-facing maxBytes cap applies to the extracted/cleaned content
  // returned to the agent — never to the raw response (safety-capped
  // separately, see readBodyCapped/assertNotBomb). Content over the cap is
  // truncated with an actionable warning, not an error.
  const { markdown, truncated, warning: note } = capContent(fullMarkdown, maxBytes);
  if (note) warning = warning ? `${warning} ${note}` : note;
  return {
    url,
    finalUrl,
    title,
    markdown,
    metadata,
    tier,
    provider,
    fetchedAt: new Date().toISOString(),
    truncated,
    bytes,
    warning,
    needsRendering,
  };
}
