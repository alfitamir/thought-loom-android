// «من أرشيفك» — the home screen's archive-resurfacing pick.
//
// Pure selection logic for the card that brings ONE old idea back each day.
// The component feeds it the VISIBLE ideas (pending-deletes.loadVisibleIdeas —
// the same source the library reads, so an idea inside its undo window can
// never resurface) and this module decides what is eligible and which one
// today gets. No storage, no AI, no schema: the only inputs are the ideas
// and the clock.
import type { Idea } from "./ideas";
import { arabicNumber } from "./format";

// The digit formatter moved to the shared formatting module (lib/format);
// re-exported here so existing imports from this module keep working.
export { arabicNumber } from "./format";

/** An idea counts as "archive" once it has been untouched for 30 days. */
export const ARCHIVE_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When the idea last changed hands: its last edit, or its creation when it
 *  was never edited (updatedAt is optional on Idea). */
export const archiveLastActivity = (idea: Idea): number => idea.updatedAt ?? idea.createdAt;

/**
 * The eligible pool, in a fixed order (least recently touched first, id as
 * the tiebreak) so the daily pick is the same whatever order the ideas were
 * loaded in:
 * - at least 30 days untouched;
 * - pinned ideas are OUT — the pin already surfaces them in the library;
 * - songs are OUT — a recording is not reading material;
 * - medical articles are OUT — home is the general surface; the medical
 *   section is opened deliberately, never resurfaced into by accident;
 * - liked articles are IN — re-reading them is their whole point.
 */
export function archivePool(ideas: Idea[], now = Date.now()): Idea[] {
  return ideas
    .filter(
      (i) =>
        !i.song && !i.pinned && !i.medical && now - archiveLastActivity(i) >= ARCHIVE_MIN_AGE_MS,
    )
    .sort((a, b) => archiveLastActivity(a) - archiveLastActivity(b) || a.id.localeCompare(b.id));
}

/** The local calendar day as YYYY-MM-DD — the unit the pick rotates on and
 *  the dismiss/cycle records are keyed by. */
export function archiveDayKey(now = Date.now()): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** A stable hash of the calendar day: same day → same seed, any day → a
 *  (practically) different one. Deliberately simple — it only has to spread
 *  picks across the pool, not be unpredictable. */
export function archiveDaySeed(now = Date.now()): number {
  const key = archiveDayKey(now);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Today's pick: the day's seed chooses the starting point in the pool and
 * `offset` steps forward from it («واحدة تانية»), wrapping around the end.
 * Deterministic for a given day — the same call all day long returns the
 * same idea (for the same offset), and tomorrow starts somewhere else.
 * Null when nothing is eligible.
 */
export function pickArchiveIdea(ideas: Idea[], now = Date.now(), offset = 0): Idea | null {
  const pool = archivePool(ideas, now);
  if (!pool.length) return null;
  const start = archiveDaySeed(now) % pool.length;
  const idx = (((start + offset) % pool.length) + pool.length) % pool.length;
  return pool[idx] ?? null;
}

/**
 * The warm age line on the card, e.g. «منذ ٣ شهور». Months are 30-day
 * blocks (the same unit as the eligibility threshold); Arabic plural rules
 * for the small numbers, so 1 is «شهر», 2 is «شهرين», 3–10 take the plural
 * noun and 11+ the singular accusative.
 */
export function archiveAgeLabel(idea: Idea, now = Date.now()): string {
  const days = Math.floor((now - archiveLastActivity(idea)) / DAY_MS);
  const months = Math.floor(days / 30);
  if (months <= 1) return "منذ شهر";
  if (months === 2) return "منذ شهرين";
  if (months < 12)
    return months <= 10 ? `منذ ${arabicNumber(months)} شهور` : `منذ ${arabicNumber(months)} شهرًا`;
  const years = Math.floor(months / 12);
  if (years === 1) return "منذ سنة";
  if (years === 2) return "منذ سنتين";
  return years <= 10 ? `منذ ${arabicNumber(years)} سنوات` : `منذ ${arabicNumber(years)} سنة`;
}

/** The dismiss record is just the day key of the day it was dismissed:
 *  hidden for the rest of that day, back tomorrow. */
export const isArchiveDismissed = (raw: string | null, now = Date.now()): boolean =>
  raw === archiveDayKey(now);

/**
 * The «واحدة تانية» offset is remembered for the day (a reload keeps the
 * user's place) and forgotten tomorrow: the stored record carries its day
 * key and parses to 0 for any other day, or for anything malformed.
 */
export function parseArchiveCycle(raw: string | null, now = Date.now()): number {
  if (!raw) return 0;
  try {
    const v = JSON.parse(raw) as { day?: unknown; offset?: unknown };
    if (v.day === archiveDayKey(now) && typeof v.offset === "number" && Number.isFinite(v.offset)) {
      return Math.max(0, Math.floor(v.offset));
    }
  } catch {
    /* fall through to 0 */
  }
  return 0;
}

export const serializeArchiveCycle = (offset: number, now = Date.now()): string =>
  JSON.stringify({ day: archiveDayKey(now), offset });
