/**
 * Search highlighting helpers for the library search.
 *
 * Matching mirrors `matchesArticle` in ideas.ts so highlights line up with
 * filtering: the same normalization is applied to both the text and the
 * query — Arabic diacritics (ً–ْ) are dropped, أ/إ/آ fold to ا, and Latin
 * letters compare case-insensitively. Occurrences are located in the
 * normalized string, then mapped back to slices of the ORIGINAL text, so
 * the rendered segments always reproduce the article exactly as written.
 */

export type TextSegment = { text: string; match: boolean };

const DIACRITIC = /[\u064B-\u0652]/;
const ALEF_FORMS = /[أإآ]/;

/** Normalize one string the way matchesArticle does, remembering for every
 *  normalized character the index of the original character it came from. */
function normalizeWithMap(text: string): { normalized: string; orig: number[] } {
  let normalized = "";
  const orig: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (DIACRITIC.test(ch)) continue;
    const folded = ALEF_FORMS.test(ch) ? "ا" : ch;
    for (const lc of folded.toLowerCase()) {
      normalized += lc;
      orig.push(i);
    }
  }
  return { normalized, orig };
}

const normalizedQuery = (query: string) => normalizeWithMap(query).normalized.trim();

/**
 * Split `text` into segments around every (non-overlapping) occurrence of
 * `query`. With no usable query the whole text is one non-match segment.
 */
export function splitByQuery(text: string, query: string): TextSegment[] {
  if (!text) return [];
  const q = normalizedQuery(query);
  if (!q) return [{ text, match: false }];
  const { normalized, orig } = normalizeWithMap(text);
  const segments: TextSegment[] = [];
  const push = (slice: string, match: boolean) => {
    if (!slice) return;
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += slice;
    else segments.push({ text: slice, match });
  };
  let cursor = 0;
  let origCursor = 0;
  for (;;) {
    const at = normalized.indexOf(q, cursor);
    if (at === -1) break;
    // at and at + q.length - 1 are valid normalized indices by construction.
    const startOrig = orig[at]!;
    const endOrig = orig[at + q.length - 1]! + 1;
    push(text.slice(origCursor, startOrig), false);
    push(text.slice(startOrig, endOrig), true);
    origCursor = endOrig;
    cursor = at + q.length;
  }
  push(text.slice(origCursor), false);
  return segments.length ? segments : [{ text, match: false }];
}

/** Count non-overlapping occurrences of `query` in `text` (same semantics as splitByQuery). */
export function countOccurrences(text: string, query: string): number {
  const q = normalizedQuery(query);
  if (!q || !text) return 0;
  const { normalized } = normalizeWithMap(text);
  let count = 0;
  let from = 0;
  for (;;) {
    const at = normalized.indexOf(q, from);
    if (at === -1) return count;
    count++;
    from = at + q.length;
  }
}
