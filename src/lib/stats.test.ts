import { beforeEach, describe, expect, it } from "vitest";
import type { Idea } from "./ideas";
import { loadVisibleIdeas } from "./pending-deletes";
import { computeStats, countWords } from "./stats";

// A fixed local "now": noon on 2026-06-15 (local calendar — the same
// calendar computeStats reads createdAt against).
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 10, min = 0) => new Date(y, m, d, h, min).getTime();

let seq = 0;
const mk = (over: Partial<Idea> = {}): Idea => {
  seq += 1;
  return { id: `idea-${seq}`, text: `نص الفكرة ${seq}`, createdAt: at(2026, 5, 10), ...over };
};
/** An own article whose body has an exact word count (body is what the
 *  editor counts, so fixtures pin it directly). */
const article = (createdAt: number, words: number, over: Partial<Idea> = {}): Idea =>
  mk({ createdAt, articleBody: Array.from({ length: words }, (_, i) => `كلمة${i + 1}`).join(" "), ...over });
const pinned = (topic: string, over: Partial<Idea> = {}): Idea => mk({ topic, topicManual: true, ...over });

beforeEach(() => { seq = 0; localStorage.clear(); });

describe("countWords", () => {
  it("counts whitespace-separated tokens the editor's way", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  ")).toBe(0);
    expect(countWords("واحد")).toBe(1);
    expect(countWords("واحد  اثنان\nثلاثة\tأربعة")).toBe(4);
  });
});

describe("this month", () => {
  it("includes the month's first and last local moments, excludes the neighbours", () => {
    const ideas = [
      article(at(2026, 4, 31, 23, 59), 5), // May 31 — out
      article(at(2026, 5, 1, 0, 0), 5), // Jun 1 00:00 — in
      article(at(2026, 5, 30, 23, 59), 5), // Jun 30 — in
      article(at(2026, 6, 1, 0, 0), 5), // Jul 1 — out
      article(at(2025, 5, 15), 5), // same month, last year — out
    ];
    const s = computeStats(ideas, NOW);
    expect(s.monthArticles).toBe(2);
    expect(s.monthWords).toBe(10);
  });

  it("sums the bodies' words, and reads a raw idea's text through the article body", () => {
    const edited = article(at(2026, 5, 3), 7);
    const raw = mk({ createdAt: at(2026, 5, 4), text: "أهلا بالعالم اليوم." });
    const old = article(at(2026, 3, 4), 100); // April — not this month
    const s = computeStats([edited, raw, old], NOW);
    expect(s.monthArticles).toBe(2);
    expect(s.monthWords).toBe(10); // 7 + 3
  });

  it("songs and liked pieces created this month are not his month's articles or words", () => {
    const ideas = [
      article(at(2026, 5, 2), 4),
      mk({ createdAt: at(2026, 5, 2), song: true, text: "كلمات أغنية طويلة هنا" }),
      mk({ createdAt: at(2026, 5, 2), liked: true, articleBody: "نص طويل لكاتب آخر فيه كلمات كثيرة جدا" }),
    ];
    const s = computeStats(ideas, NOW);
    expect(s.monthArticles).toBe(1);
    expect(s.monthWords).toBe(4);
  });
});

describe("totals", () => {
  it("separates own articles, songs, liked and medical", () => {
    const ideas = [
      mk(), mk(), // two plain articles
      mk({ medical: true }), // medical article: counts as an article AND as medical
      mk({ song: true, text: "غنا" }),
      mk({ liked: true }),
      mk({ pinned: true }), // pinning changes nothing
    ];
    const s = computeStats(ideas, NOW);
    expect(s.articles).toBe(4);
    expect(s.songs).toBe(1);
    expect(s.liked).toBe(1);
    expect(s.medical).toBe(1);
  });
});

describe("top topics", () => {
  it("ranks own articles by their topic, top 3, ties broken by topic name", () => {
    const ideas = [
      pinned("جراحة"), pinned("جراحة"), pinned("جراحة", { medical: true }), // medical counts too
      pinned("خواطر"), pinned("خواطر"),
      pinned("سفر"), pinned("سفر"),
      pinned("طب"),
      pinned("جراحة", { liked: true }), // someone else's — out
      pinned("جراحة", { song: true }), // a recording — out
    ];
    expect(computeStats(ideas, NOW).topTopics).toEqual([
      { topic: "جراحة", count: 3 },
      { topic: "خواطر", count: 2 },
      { topic: "سفر", count: 2 },
    ]);
  });

  it("returns fewer than three when the library has fewer topics, and none when empty", () => {
    expect(computeStats([pinned("سفر"), pinned("سفر")], NOW).topTopics).toEqual([{ topic: "سفر", count: 2 }]);
    expect(computeStats([], NOW).topTopics).toEqual([]);
  });
});

describe("streaks", () => {
  const on = (y: number, m: number, d: number) => mk({ createdAt: at(y, m, d) });

  it("counts consecutive days ending today, and the longest run ever", () => {
    const ideas = [
      on(2026, 5, 15), on(2026, 5, 14), on(2026, 5, 13), // current run: 3
      on(2026, 5, 5), on(2026, 5, 4), on(2026, 5, 3), on(2026, 5, 2), on(2026, 5, 1), // older run: 5
      on(2026, 4, 20), // a lone day in May
    ];
    const s = computeStats(ideas, NOW);
    expect(s.currentStreak).toBe(3);
    expect(s.longestStreak).toBe(5);
  });

  it("anchors on yesterday when nothing was created yet today", () => {
    const s = computeStats([on(2026, 5, 14), on(2026, 5, 13), on(2026, 5, 12)], NOW);
    expect(s.currentStreak).toBe(3);
    expect(s.longestStreak).toBe(3);
  });

  it("reads 0 once a full day has been missed", () => {
    const s = computeStats([on(2026, 5, 12), on(2026, 5, 11)], NOW);
    expect(s.currentStreak).toBe(0);
    expect(s.longestStreak).toBe(2);
  });

  it("a single creation day is a streak of one; several ideas that day still count once", () => {
    const s = computeStats([on(2026, 5, 15), on(2026, 5, 15), on(2026, 5, 15)], NOW);
    expect(s.currentStreak).toBe(1);
    expect(s.longestStreak).toBe(1);
  });

  it("runs across a month boundary", () => {
    const feb2 = new Date(2026, 1, 2, 12, 0, 0).getTime();
    const s = computeStats([on(2026, 0, 30), on(2026, 0, 31), on(2026, 1, 1), on(2026, 1, 2)], feb2);
    expect(s.currentStreak).toBe(4);
    expect(s.longestStreak).toBe(4);
  });

  it("any creation marks the day — a song recorded yesterday keeps the streak alive", () => {
    const ideas = [on(2026, 5, 15), mk({ createdAt: at(2026, 5, 14), song: true, text: "غنا" })];
    expect(computeStats(ideas, NOW).currentStreak).toBe(2);
  });
});

describe("empty and pending-delete handling", () => {
  it("an empty library is all zeros", () => {
    expect(computeStats([], NOW)).toEqual({
      monthArticles: 0, monthWords: 0, articles: 0, songs: 0, liked: 0, medical: 0,
      topTopics: [], currentStreak: 0, longestStreak: 0,
    });
  });

  it("ideas inside their undo window are excluded when fed through loadVisibleIdeas", () => {
    const kept = article(at(2026, 5, 10), 3);
    const pending = article(at(2026, 5, 10), 50);
    localStorage.setItem("afkari.ideas", JSON.stringify([kept, pending]));
    localStorage.setItem("afkari.pendingDeletes", JSON.stringify([{ id: pending.id, deadline: NOW + 60_000 }]));
    const s = computeStats(loadVisibleIdeas(), NOW);
    expect(s.articles).toBe(1);
    expect(s.monthWords).toBe(3);
  });
});
