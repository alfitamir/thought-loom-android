import { beforeEach, describe, expect, it } from "vitest";
import {
  attributionsOf, getArticle, loadIdeas, mergeAttributions, mergeIdeas, needsPolish,
  saveArticleIdea, saveIdea, saveLikedArticle, type Idea,
} from "./ideas";

const own = (id: string, title = `مقالي ${id}`): Idea => ({
  id, text: `نص ${id}`, createdAt: 1, updatedAt: 1, articleTitle: title, articleBody: `نص ${id}`,
});
const likedIdea = (id: string, source?: string, title = `مقال خارجي ${id}`): Idea => ({
  ...own(id, title), liked: true, ...(source ? { source } : {}),
});

describe("liked articles: intake", () => {
  beforeEach(() => localStorage.clear());

  it("saves the pasted article verbatim, flagged liked, with its source", () => {
    const idea = saveLikedArticle("  عنوان خارجي ", " مجلة الفكر ", "نص المقال كما نُشر بالضبط.\n\nفقرة ثانية.");
    expect(idea).toMatchObject({ liked: true, source: "مجلة الفكر", articleTitle: "عنوان خارجي" });
    const saved = loadIdeas().find((i) => i.id === idea!.id)!;
    expect(getArticle(saved).body).toBe("نص المقال كما نُشر بالضبط.\n\nفقرة ثانية.");
    expect(saved.text).toBe("نص المقال كما نُشر بالضبط.\n\nفقرة ثانية.");
  });

  it("accepts a liked article without a source and refuses empty title/body", () => {
    expect(saveLikedArticle("بلا مصدر", "", "نص")?.source).toBeUndefined();
    expect(saveLikedArticle("  ", "", "نص")).toBeUndefined();
    expect(saveLikedArticle("عنوان", "", "  ")).toBeUndefined();
    expect(loadIdeas()).toHaveLength(1);
  });
});

describe("liked articles: the AI polish gate", () => {
  it("needsPolish is always false for a liked article, however stale", () => {
    const stale: Idea = { id: "l", text: "نص", createdAt: 1, updatedAt: 9, liked: true };
    expect(needsPolish(stale)).toBe(false);
    const { liked: _dropped, ...unliked } = stale;
    expect(needsPolish(unliked)).toBe(true);
    expect(needsPolish(own("o"))).toBe(true);
  });
});

describe("liked articles: attribution", () => {
  it("attributionsOf prefers the source, accumulates sources, and falls back to the title", () => {
    expect(attributionsOf(likedIdea("a", "المصدر الأول"))).toEqual(["المصدر الأول"]);
    expect(attributionsOf({ ...likedIdea("a", "س"), sources: ["ص", "س"] })).toEqual(["س", "ص"]);
    expect(attributionsOf(likedIdea("a", undefined, "عنوانه وحده"))).toEqual(["عنوانه وحده"]);
    expect(attributionsOf(own("o"))).toEqual([]);
  });

  it("own + liked: the result stays the author's, attribution kept in sources", () => {
    const out = mergeAttributions([own("o"), likedIdea("l", "مدونة س")]);
    expect(out).toEqual({ liked: false, sources: ["مدونة س"] });
  });

  it("liked + liked: the result stays liked, first source stays primary, the rest accumulate", () => {
    const out = mergeAttributions([likedIdea("a", "موقع أ"), likedIdea("b", "موقع ب")]);
    expect(out).toEqual({ liked: true, source: "موقع أ", sources: ["موقع ب"] });
  });

  it("a liked article without a source contributes its title; prior sources ride along", () => {
    const carrier: Idea = { ...likedIdea("a", "أ"), sources: ["قديم"] };
    const out = mergeAttributions([carrier, likedIdea("b", undefined, "مقال بلا مصدر")]);
    expect(out.liked).toBe(true);
    expect(out.source).toBe("أ");
    expect(out.sources).toEqual(expect.arrayContaining(["قديم", "مقال بلا مصدر"]));
    expect(out.sources).toHaveLength(2);
  });

  it("own + own: no attribution, not liked", () => {
    expect(mergeAttributions([own("a"), own("b")])).toEqual({ liked: false, sources: [] });
  });

  it("saveArticleIdea applies the merge outcome (liked flag, source, sources)", () => {
    localStorage.clear();
    const merged = saveArticleIdea("نصان", "مدمج", "نص مدمج", ["a", "b"], { liked: true, source: "موقع أ", sources: ["موقع ب"] });
    expect(merged).toMatchObject({ liked: true, source: "موقع أ", sources: ["موقع ب"], mergedFrom: ["a", "b"] });
    expect(loadIdeas()[0]).toMatchObject({ liked: true, source: "موقع أ" });
  });
});

describe("liked articles: cross-device merge adoption", () => {
  it("an edition without the flag does not un-like the winner; source and sources survive and union", () => {
    const local: Idea = { ...likedIdea("x", "مصدر محلي"), updatedAt: 3, sources: ["واحد"] };
    const remote: Idea = { id: "x", text: "نص أحدث", createdAt: 1, updatedAt: 5, articleBody: "أحدث", sources: ["اثنان"] };
    const [winner] = mergeIdeas([local], [remote], []);
    expect(winner).toMatchObject({ liked: true, source: "مصدر محلي", articleBody: "أحدث" });
    expect(winner?.sources).toEqual(expect.arrayContaining(["واحد", "اثنان"]));
  });

  it("a plain local article adopts liked + attribution from the remote edition", () => {
    const local = own("x");
    const remote: Idea = { ...likedIdea("x", "مصدر سحابي"), updatedAt: 0 };
    const [winner] = mergeIdeas([local], [remote], []);
    expect(winner).toMatchObject({ liked: true, source: "مصدر سحابي" });
  });

  it("saveIdea articles are never accidentally liked", () => {
    localStorage.clear();
    expect(saveIdea("فكرة عادية").liked).toBeUndefined();
  });
});
