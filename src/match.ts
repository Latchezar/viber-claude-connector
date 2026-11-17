// Text normalisation + fuzzy matching between what Viber renders (via AX) and what
// viber.db stores. Observed differences: the UI wraps runs in bidi isolates
// (U+2068/U+2069), renders "\n" as U+2028 LINE SEPARATOR, and drops mention markup.

const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function norm(s: unknown): string {
  return String(s ?? "")
    .replace(INVISIBLE, "")
    .replace(/[\u2028\u2029\r]/g, "\n")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/** 1 - normalised Levenshtein distance (strings capped at 600 chars for speed). */
export function ratio(a: string, b: string): number {
  if (a === b) return 1;
  const x = [...a.slice(0, 600)];
  const y = [...b.slice(0, 600)];
  if (!x.length || !y.length) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  let cur = new Array<number>(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

export function sameText(a: unknown, b: unknown, threshold = 0.9): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 4) return false;
  return ratio(x, y) >= threshold;
}

/** How many visible (UI) messages appear in the chat's recent DB history. */
export function feedMatch(visible: string[], history: string[]): { matched: number; total: number } {
  const V = visible.map(norm).filter(Boolean);
  const D = history.map(norm).filter(Boolean);
  let matched = 0;
  for (const v of V) if (D.some((d) => sameText(v, d))) matched++;
  return { matched, total: V.length };
}

/**
 * Decide whether the open conversation is the intended chat.
 * headerScore: OCR similarity of the conversation header to the chat name (0..1).
 */
export function isVerified(headerScore: number, feed: { matched: number; total: number }): boolean {
  if (headerScore < 0.85) return false;
  if (feed.total === 0) return headerScore >= 0.95; // nothing to compare: demand a near-exact title
  return feed.matched >= Math.min(2, feed.total) && feed.matched >= 0.6 * feed.total;
}
