import { describe, it, expect, beforeEach } from "vitest";
import { classify, toArticle, OTHER, getArticle, matchesArticle, saveIdea, updateArticle, loadIdeas, mergeIdeas } from "./ideas";

describe("ideas", () => {
  it("classifies by topic keywords", () => {
    expect(classify("فكرة عن النجاح في العمل")).toBe("العمل والنجاح");
    expect(classify("كلام عام بلا موضوع")).toBe(OTHER);
  });
  it("removes fillers and ends with punctuation", () => {
    const a = toArticle("امم الصبر مفتاح الفرج");
    expect(a.paragraphs[0]).toBe("الصبر مفتاح الفرج.");
  });
});

describe("article tools", () => {
  beforeEach(() => localStorage.clear());
  it("keeps the original wording intact after manual edits", () => {
    const idea = saveIdea("انا شايف ان الشغل محتاج صبر");
    updateArticle(idea.id, "الصبر في العمل", "أنا شايف إن الشغل محتاج صبر.");
    const saved = loadIdeas()[0];
    expect(saved.text).toBe("انا شايف ان الشغل محتاج صبر");
    expect(getArticle(saved)).toEqual({ title: "الصبر في العمل", body: "أنا شايف إن الشغل محتاج صبر." });
  });
  it("searches words inside edited article body", () => {
    const idea = saveIdea("فكرة قصيرة");
    const edited = updateArticle(idea.id, "عنوان", "التعاون أساس النجاح") ?? idea;
    expect(matchesArticle(edited, "التعاون")).toBe(true);
    expect(matchesArticle(edited, "الرياضة")).toBe(false);
  });
  it("searches Arabic without requiring matching diacritics or alef form", () => {
    expect(matchesArticle({ id: "1", text: "أَفكار", createdAt: 1 }, "افكار")).toBe(true);
  });
  it("still formats old ideas without edited article fields", () => {
    expect(getArticle({ id: "1", text: "الصبر مفتاح الفرج", createdAt: 1 }).body).toBe("الصبر مفتاح الفرج.");
  });
  it("restores the newer cloud edition", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 2, articleBody: "محلي" };
    expect(mergeIdeas([local], [{ ...local, updatedAt: 3, articleBody: "سحابي" }], [])[0].articleBody).toBe("سحابي");
  });
  it("keeps a newer offline edit instead of an older cloud edition", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 3, articleBody: "تعديل دون اتصال" };
    expect(mergeIdeas([local], [{ ...local, updatedAt: 2, articleBody: "قديم" }], [])[0].articleBody).toBe("تعديل دون اتصال");
  });
  it("never restores an offline-deleted article", () => {
    expect(mergeIdeas([], [{ id: "1", text: "محذوف", createdAt: 1 }], ["1"])).toEqual([]);
  });
});
