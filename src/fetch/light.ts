/**
 * Light fetch tier: native HTTP with SSRF-safe manual redirect handling,
 * streaming size caps (compressed + decompressed), MIME gating, and
 * Readability → DOMPurify → Turndown extraction to markdown.
 * No shell strings anywhere; PDFs are converted via pdftotext (poppler) when
 * available, else reported as unsupported.
 */

import { spawn } from "node:child_process";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { WebToolsError } from "../errors.ts";
import type { FetchResult } from "../normalize.ts";
import { assertHostResolvesSafe, parseAndValidateUrl, type UrlGuardOptions } from "../security/urlguard.ts";

const MAX_REDIRECTS = 5;
const MIN_CONTENT_LENGTH = 300;
/** Compressed bytes are capped at fetchMaxBytes; decompressed at the same cap. */
const COMPRESS_MULTIPLIER = 1;

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
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LightFetchOutput {
  result: FetchResult;
  /** Raw sanitized HTML, used by the rendered tier to reuse extraction. */
  html: string;
}

export async function lightFetch(rawUrl: string, opts: LightFetchOptions): Promise<LightFetchOutput> {
  // The caller-supplied URL honors allowLocalNetworks; redirect targets do
  // not. Every hop is re-validated with the FULL strict guard (scheme,
  // userinfo, private/loopback/link-local/ULA blocks, DNS resolution) so a
  // locally-allowed origin cannot be used as a trampoline into the internal
  // network. The one exception is a hop that stays on the exact host:port the
  // caller explicitly requested — that changes no network destination, so the
  // override still applies there.
  const strictOpts: UrlGuardOptions = { allowLocalNetworks: false };
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
      if (!location) break;
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
    throw new WebToolsError("E_UPSTREAM", `HTTP ${response.status} fetching ${finalUrl}`);
  }

  const contentType = (response.headers.get("content-type") ?? "application/octet-stream").toLowerCase();
  const mime = contentType.split(";")[0]!.trim();
  const charset = /charset=([\w-]+)/.exec(contentType)?.[1] ?? "utf-8";

  if (SKIP_CONTENT_TYPES.some((prefix) => mime.startsWith(prefix))) {
    throw new WebToolsError("E_UNSUPPORTED_TYPE", `Unsupported content type: ${mime}`, {
      hint: "Light fetch handles text/html, text/*, application/json, xml and PDFs.",
    });
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > opts.maxBytes) {
    throw new WebToolsError("E_CONTENT_TOO_LARGE", `Body of ${contentLength} bytes exceeds cap of ${opts.maxBytes}`);
  }

  const raw = await readBodyCapped(response, opts.maxBytes * COMPRESS_MULTIPLIER, opts.signal);
  // NOTE: undici (node fetch) transparently decompresses gzip/deflate/br/zstd
  // response bodies; the byte cap applied in readBodyCapped therefore bounds
  // the DECOMPRESSED stream, which is what protects against decompression
  // bombs. If an older runtime did not strip the encoding, decompress
  // manually with the same cap enforced.
  const encoding = (response.headers.get("content-encoding") ?? "identity").toLowerCase();
  const body = encoding !== "identity" && looksCompressed(raw, encoding) ? decompress(raw, encoding, opts.maxBytes) : raw;

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
    return { result: finish(finalUrl, finalUrl, `JSON response (${body.length} bytes)`, body.length, text.slice(0, opts.maxBytes), "light", "node", {}, opts.maxBytes, false), html: "" };
  }
  if (!mime.includes("html") && mime.startsWith("text/")) {
    return { result: finish(finalUrl, finalUrl, undefined, body.length, "```text\n" + text.slice(0, opts.maxBytes) + "\n```", "light", "node", {}, opts.maxBytes, false), html: "" };
  }

  // HTML: extract with Readability over a sanitized DOM.
  const { markdown, title, metadata, extractedLength } = extractHtml(text, finalUrl);
  const truncated = body.length > opts.maxBytes;
  const needsRendering = extractedLength < MIN_CONTENT_LENGTH || SPA_INDICATORS.some((i) => text.includes(i));
  const warning = needsRendering ? "Page appears to require JavaScript rendering (tier=rendered may extract more)." : undefined;
  return { result: finish(rawUrl, finalUrl, title, body.length, markdown, "light", "node", metadata, opts.maxBytes, truncated, warning, needsRendering), html: "" };
}

async function guardedFetch(url: string, opts: LightFetchOptions): Promise<Response> {
  if (opts.signal?.aborted) throw new WebToolsError("E_CANCELLED", "Cancelled");
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    return await fetch(url, {
      redirect: "manual", // every hop re-checked by the caller
      signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 pi-web-tools/0.1",
        accept: "text/html,application/xhtml+xml,text/plain,application/json,application/pdf;q=0.9,*/*;q=0.1",
        "accept-encoding": "gzip, deflate, br, zstd",
      },
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
      throw new WebToolsError("E_CONTENT_TOO_LARGE", `Body exceeds cap of ${capBytes} bytes (decompression bomb protection)`);
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
  if (encoding === "deflate") return raw[0] === 0x78; // zlib header
  // br/zstd have no reliable magic; assume already decompressed by undici.
  return false;
}

function decompress(raw: Uint8Array, encoding: string, maxBytes: number): Uint8Array {
  switch (encoding) {
    case "identity":
      return raw;
    case "gzip":
      return cappedDecompress(() => gunzipSync(raw), maxBytes, "gzip");
    case "deflate":
      return cappedDecompress(() => inflateSync(raw), maxBytes, "deflate");
    case "br":
      return cappedDecompress(() => brotliDecompressSync(raw), maxBytes, "brotli");
    case "zstd":
      return cappedDecompress(() => zstdDecompressSync(raw), maxBytes, "zstd");
    default:
      throw new WebToolsError("E_UNSUPPORTED_TYPE", `Unsupported content-encoding: ${encoding}`);
  }
}

function cappedDecompress(fn: () => Uint8Array, maxBytes: number, algo: string): Uint8Array {
  let out: Uint8Array;
  try {
    out = fn();
  } catch (err) {
    throw new WebToolsError("E_UPSTREAM", `${algo} decompression failed: ${(err as Error).message}`);
  }
  if (out.byteLength > maxBytes) {
    throw new WebToolsError("E_CONTENT_TOO_LARGE", `Decompressed body of ${out.byteLength} bytes exceeds cap of ${maxBytes}`);
  }
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
  const markdown = "```text\n" + text.slice(0, opts.maxBytes) + "\n```";
  return { result: finish(rawUrl, finalUrl, undefined, body.length, markdown, "light", "node", {}, opts.maxBytes, false), html: "" };
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
  markdown: string,
  tier: "light" | "rendered",
  provider: FetchResult["provider"],
  metadata: NonNullable<FetchResult["metadata"]>,
  maxBytes: number,
  truncated: boolean,
  warning?: string,
  needsRendering?: boolean,
): FetchResult {
  const capped = markdown.length > maxBytes ? markdown.slice(0, maxBytes) : markdown;
  return {
    url,
    finalUrl,
    title,
    markdown: capped,
    metadata,
    tier,
    provider,
    fetchedAt: new Date().toISOString(),
    truncated: truncated || markdown.length > maxBytes,
    bytes,
    warning,
    needsRendering,
  };
}
