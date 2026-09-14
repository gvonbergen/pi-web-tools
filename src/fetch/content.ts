export function capContent(content: string, maxBytes: number) {
  const encoded = Buffer.from(content, "utf8");
  const cap = Number.isNaN(maxBytes) ? 0 : Math.max(0, Math.floor(maxBytes));
  const truncated = encoded.length > cap;
  let end = Math.min(encoded.length, cap);
  if (truncated) {
    while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  }
  return {
    markdown: truncated ? encoded.subarray(0, end).toString("utf8") : content,
    truncated,
    bytes: encoded.length,
    warning: truncated
      ? `Extracted content is ${encoded.length} bytes; returning the first ${end} bytes (maxBytes cap). Increase maxBytes to retrieve more.`
      : undefined,
  };
}
