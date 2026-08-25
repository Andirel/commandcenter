/**
 * Similarity primitives for task matching.
 *
 * Deterministic and cheap. The AI adjudicator is only consulted when these
 * land in the ambiguous band, which keeps the common case free.
 */

/** Tokens worth comparing: stopwords and punctuation removed. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'we', 'us',
  'our', 'they', 'them', 'their', 'it', 'this', 'that', 'these', 'those',
  'need', 'needs', 'needed', 'please', 'can', 'will', 'should', 'would',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Jaccard overlap of token sets. */
export function tokenSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Trigram similarity — catches wording changes that token overlap misses
 * ("reorder packaging" vs. "packaging reorder", typos, inflections).
 */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

function trigrams(text: string): Set<string> {
  const normalized = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < normalized.length - 2; i++) out.add(normalized.slice(i, i + 3));
  return out;
}

/** Overlap of two participant sets. */
export function participantOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const id of new Set(a)) if (setB.has(id)) shared++;
  return shared / Math.max(new Set(a).size, setB.size);
}

/**
 * Temporal proximity, decaying over a week.
 *
 * The same activity discussed in a meeting, then in Slack, then by email
 * usually lands within days. Two similarly-worded tasks a month apart are more
 * likely to be a genuine recurrence than a duplicate.
 */
export function temporalProximity(aIso: string, bIso: string, windowDays = 7): number {
  const days = Math.abs(Date.parse(aIso) - Date.parse(bIso)) / 86_400_000;
  if (!Number.isFinite(days)) return 0;
  return Math.max(0, 1 - days / windowDays);
}
