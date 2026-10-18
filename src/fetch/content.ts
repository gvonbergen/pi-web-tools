export function capContent(content: string, maxChars: number) {
  const cap = Number.isNaN(maxChars) ? 0 : Math.max(0, Math.floor(maxChars));
  const chars = Array.from(content); // code points, so whole characters are preserved
  const truncated = chars.length > cap;
  const end = Math.min(chars.length, cap);
  return {
    markdown: truncated ? chars.slice(0, end).join("") : content,
    truncated,
    characters: chars.length,
    warning: truncated
      ? `Extracted content is ${chars.length} characters; returning the first ${end} characters (maxChars cap). Increase maxChars to retrieve more.`
      : undefined,
  };
}