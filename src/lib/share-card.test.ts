import { describe, expect, it } from "vitest";
import type { Idea } from "./ideas";
import { cardExcerpt, clampLines, shareCardFileName, shareCardModel, wrapLines } from "./share-card";

const base: Idea = { id: "1", text: "نص الفكرة", createdAt: 0 };
const fixed = (s: string) => s.length * 10; // 10px per char

describe("shareCardModel", () => {
  it("composes a plain article card: kind, topic, excerpt, no attribution", () => {
    const m = shareCardModel({ ...base, articleTitle: "عنواني", articleBody: "سطر أول\n\nسطر ثانٍ" }, "الصحة");
    expect(m.kind).toBe("article");
    expect(m.kindLabel).toBe("مقال");
    expect(m.title).toBe("عنواني");
    expect(m.excerpt).toBe("سطر أول سطر ثانٍ");
    expect(m.topic).toBe("الصحة");
    expect(m.attribution).toBeUndefined();
    expect(m.authorLine).toBe("د. تامر رشدي الألفي");
    expect(m.appLine).toBe("أفكاري");
  });

  it("marks songs with the «أغنية» chip and takes the excerpt from the lyrics", () => {
    const m = shareCardModel({ ...base, song: true, text: "كلمات الأغنية\nسطر ثانٍ من الغنا", songDuration: 42 }, "متفرقات");
    expect(m.kind).toBe("song");
    expect(m.kindLabel).toBe("أغنية");
    expect(m.excerpt).toContain("كلمات الأغنية");
    expect(m.attribution).toBeUndefined();
  });

  it("REQUIRES the source line on a liked card (explicit source)", () => {
    const m = shareCardModel({ ...base, liked: true, source: "مدونة فلان", articleTitle: "مقال جميل", articleBody: "نص" }, "المجتمع");
    expect(m.kind).toBe("liked");
    expect(m.kindLabel).toBe("مقال أعجبني");
    expect(m.attribution).toBe("المصدر: مدونة فلان");
  });

  it("falls back to accumulated merge attributions, then to a generic source line", () => {
    const withSources = shareCardModel({ ...base, liked: true, sources: ["موقع أ", "كاتب ب"], articleBody: "نص" }, "متفرقات");
    expect(withSources.attribution).toBe("المصدر: موقع أ، كاتب ب");
    const bare = shareCardModel({ ...base, liked: true, articleBody: "نص" }, "متفرقات");
    expect(bare.attribution).toBe("مقال من مصدر خارجي");
  });

  it("carries «يتضمن مقالًا من» on his own article that merged a liked one", () => {
    const m = shareCardModel({ ...base, sources: ["مدونة فلان"], articleBody: "نصي" }, "الصحة");
    expect(m.kind).toBe("article");
    expect(m.attribution).toBe("يتضمن مقالًا من: مدونة فلان");
  });
});

describe("cardExcerpt", () => {
  it("flattens whitespace and keeps short bodies whole", () => {
    expect(cardExcerpt("أ  ب\n\nج")).toBe("أ ب ج");
    expect(cardExcerpt("   ")).toBe("");
  });

  it("cuts long bodies at a word boundary with an ellipsis", () => {
    const body = Array.from({ length: 60 }, () => "كلمة").join(" ");
    const out = cardExcerpt(body, 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("كلم…");
  });
});

describe("wrapLines / clampLines", () => {
  it("wraps greedily by measured width", () => {
    expect(wrapLines("aa bb cc dd", 50, fixed)).toEqual(["aa bb", "cc dd"]);
  });

  it("hard-splits a single over-wide word", () => {
    expect(wrapLines("abcdefghij", 30, fixed)).toEqual(["abc", "def", "ghi", "j"]);
  });

  it("clamps to N lines with a fitting ellipsis", () => {
    const lines = wrapLines("aa bb cc dd ee ff gg hh", 50, fixed);
    const out = clampLines(lines, 2, 50, fixed);
    expect(out).toHaveLength(2);
    const last = out[1] ?? "";
    expect(last.endsWith("…")).toBe(true);
    expect(fixed(last)).toBeLessThanOrEqual(50);
  });

  it("leaves short-enough line sets untouched", () => {
    expect(clampLines(["واحد", "اثنان"], 3, 500, fixed)).toEqual(["واحد", "اثنان"]);
  });
});

describe("shareCardFileName", () => {
  it("strips path-hostile characters and adds .png", () => {
    expect(shareCardFileName('مقال: الصحة/الجسم؟')).toBe("مقال الصحة الجسم؟.png");
    expect(shareCardFileName("   ")).toBe("مقال.png");
  });
});
