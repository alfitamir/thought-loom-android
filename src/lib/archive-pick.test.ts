import { beforeEach, describe, expect, it } from "vitest";
import type { Idea } from "./ideas";
import { loadVisibleIdeas } from "./pending-deletes";
import {
  archiveAgeLabel, archiveDayKey, archivePool, isArchiveDismissed,
  parseArchiveCycle, pickArchiveIdea, serializeArchiveCycle,
} from "./archive-pick";

const DAY = 24 * 60 * 60 * 1000;
// A fixed "now" so day keys and ages are exact: midday UTC on 2026-06-15.
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

let seq = 0;
const mk = (over: Partial<Idea> = {}): Idea => {
  seq += 1;
  return {
    id: `idea-${seq}`,
    text: `نص الفكرة ${seq}`,
    createdAt: NOW - 90 * DAY,
    updatedAt: NOW - 90 * DAY,
    ...over,
  };
};
const daysAgo = (n: number) => NOW - n * DAY;

beforeEach(() => { seq = 0; localStorage.clear(); });

describe("archivePool eligibility", () => {
  it("includes ideas untouched for at least 30 days, boundary included", () => {
    const exact = mk({ updatedAt: daysAgo(30) });
    const older = mk({ updatedAt: daysAgo(45) });
    const fresh = mk({ updatedAt: daysAgo(29) });
    const pool = archivePool([fresh, older, exact], NOW);
    expect(pool.map((i) => i.id)).toEqual([older.id, exact.id]); // oldest first
  });

  it("falls back to createdAt when the idea was never edited", () => {
    const neverEdited = mk({ createdAt: daysAgo(60) });
    delete neverEdited.updatedAt;
    const editedRecently = mk({ createdAt: daysAgo(90), updatedAt: daysAgo(3) });
    expect(archivePool([neverEdited, editedRecently], NOW).map((i) => i.id)).toEqual([neverEdited.id]);
  });

  it("excludes pinned ideas — the pin already surfaces them", () => {
    const pinned = mk({ pinned: true });
    const plain = mk();
    expect(archivePool([pinned, plain], NOW).map((i) => i.id)).toEqual([plain.id]);
  });

  it("excludes songs — a recording is not reading material", () => {
    const song = mk({ song: true });
    const plain = mk();
    expect(archivePool([song, plain], NOW).map((i) => i.id)).toEqual([plain.id]);
  });

  it("includes liked articles — re-reading is their point", () => {
    const liked = mk({ liked: true, source: "مدونة ما" });
    expect(archivePool([liked], NOW).map((i) => i.id)).toEqual([liked.id]);
  });

  it("respects the pending-delete exclusion through the visible-ideas source", () => {
    const a = mk({ id: "a" });
    const b = mk({ id: "b" });
    localStorage.setItem("afkari.ideas", JSON.stringify([a, b]));
    localStorage.setItem("afkari.pendingDeletes", JSON.stringify([{ id: "a", deadline: NOW + 60_000 }]));
    const visible = loadVisibleIdeas();
    expect(archivePool(visible, NOW).map((i) => i.id)).toEqual(["b"]);
    expect(pickArchiveIdea(visible, NOW)?.id).toBe("b");
  });

  it("orders the pool independently of the input order", () => {
    const a = mk({ id: "a", updatedAt: daysAgo(40) });
    const b = mk({ id: "b", updatedAt: daysAgo(80) });
    const c = mk({ id: "c", updatedAt: daysAgo(80) });
    expect(archivePool([a, c, b], NOW).map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(archivePool([c, b, a], NOW).map((i) => i.id)).toEqual(["b", "c", "a"]);
  });
});

describe("pickArchiveIdea", () => {
  it("returns null when nothing is eligible", () => {
    expect(pickArchiveIdea([], NOW)).toBeNull();
    expect(pickArchiveIdea([mk({ updatedAt: daysAgo(2) })], NOW)).toBeNull();
    expect(pickArchiveIdea([mk({ song: true }), mk({ pinned: true })], NOW)).toBeNull();
  });

  it("is deterministic within a calendar day, whatever the input order", () => {
    const ideas = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" }), mk({ id: "d" })];
    const first = pickArchiveIdea(ideas, NOW);
    expect(pickArchiveIdea(ideas, NOW + 3 * 60 * 60 * 1000)?.id).toBe(first?.id); // later the same day
    expect(pickArchiveIdea([...ideas].reverse(), NOW)?.id).toBe(first?.id);
  });

  it("rotates across days over the pool", () => {
    const ideas = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })];
    const seen = new Set<string>();
    for (let d = 0; d < 60; d++) {
      const pick = pickArchiveIdea(ideas, NOW + d * DAY);
      if (pick) seen.add(pick.id);
    }
    expect(seen.size).toBeGreaterThan(1);
    for (const id of seen) expect(["a", "b", "c"]).toContain(id);
  });

  it("cycles with the offset and wraps around the pool", () => {
    const ideas = [mk({ id: "a" }), mk({ id: "b" })];
    const first = pickArchiveIdea(ideas, NOW, 0);
    const second = pickArchiveIdea(ideas, NOW, 1);
    expect(second?.id).not.toBe(first?.id);
    expect(pickArchiveIdea(ideas, NOW, 2)?.id).toBe(first?.id); // wrapped
    expect(pickArchiveIdea(ideas, NOW, 3)?.id).toBe(second?.id);
  });
});

describe("archiveAgeLabel", () => {
  const label = (days: number) => archiveAgeLabel(mk({ updatedAt: daysAgo(days) }), NOW);
  it("phrases months warmly in Arabic", () => {
    expect(label(30)).toBe("منذ شهر");
    expect(label(59)).toBe("منذ شهر");
    expect(label(65)).toBe("منذ شهرين");
    expect(label(100)).toBe("منذ ٣ شهور");
    expect(label(200)).toBe("منذ ٦ شهور");
    expect(label(340)).toBe("منذ ١١ شهرًا");
  });
  it("phrases years once past a year", () => {
    expect(label(400)).toBe("منذ سنة");
    expect(label(800)).toBe("منذ سنتين");
    expect(label(1200)).toBe("منذ ٣ سنوات");
  });
});

describe("day-keyed records (dismiss + cycle)", () => {
  it("dismiss hides only for the rest of that calendar day", () => {
    expect(isArchiveDismissed(archiveDayKey(NOW), NOW)).toBe(true);
    expect(isArchiveDismissed(archiveDayKey(NOW), NOW + DAY)).toBe(false);
    expect(isArchiveDismissed(null, NOW)).toBe(false);
    expect(isArchiveDismissed("junk", NOW)).toBe(false);
  });

  it("cycle offset round-trips within the day and resets on other days or junk", () => {
    expect(parseArchiveCycle(serializeArchiveCycle(3, NOW), NOW)).toBe(3);
    expect(parseArchiveCycle(serializeArchiveCycle(3, NOW), NOW + DAY)).toBe(0);
    expect(parseArchiveCycle(null, NOW)).toBe(0);
    expect(parseArchiveCycle("{not json", NOW)).toBe(0);
    expect(parseArchiveCycle(JSON.stringify({ day: archiveDayKey(NOW), offset: -2 }), NOW)).toBe(0);
  });
});
