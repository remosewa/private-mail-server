/**
 * Split text into overlapping word windows for embedding.
 *
 * @param text            Raw body text
 * @param chunkWords      Target words per chunk (default 256)
 * @param overlapFraction Fraction of chunk to overlap with next (default 0.2 → 20%)
 * @returns               Array of chunk strings (empty array for empty/whitespace text)
 */
export function chunkText(
  text: string,
  chunkWords = 256,
  overlapFraction = 0.2,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const step = Math.max(1, Math.floor(chunkWords * (1 - overlapFraction)));
  const chunks: string[] = [];

  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + chunkWords).join(' '));
    if (start + chunkWords >= words.length) break;
  }

  return chunks;
}
