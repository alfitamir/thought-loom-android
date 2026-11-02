import { describe, it, expect, beforeEach } from "vitest";
import { classify, toArticle, OTHER, getArticle, matchesArticle, saveIdea, updateArticle, loadIdeas, mergeIdeas, articleTopic, setArticleTopic, clearArticleTopic, topicOptions } from "./ideas";

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
    if (!saved) throw new Error("Edited article was not saved");
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
    expect(mergeIdeas([local], [{ ...local, updatedAt: 3, articleBody: "سحابي" }], [])[0]?.articleBody).toBe("سحابي");
  });
  it("keeps a newer offline edit instead of an older cloud edition", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 3, articleBody: "تعديل دون اتصال" };
    expect(mergeIdeas([local], [{ ...local, updatedAt: 2, articleBody: "قديم" }], [])[0]?.articleBody).toBe("تعديل دون اتصال");
  });
  it("never restores an offline-deleted article", () => {
    expect(mergeIdeas([], [{ id: "1", text: "محذوف", createdAt: 1 }], ["1"])).toEqual([]);
  });
});

describe("local formatting keeps the ending", () => {
  it("keeps a final sentence without punctuation", () => {
    const a = toArticle("الصبر مهم. وفي الآخر لازم نكمل الطريق");
    expect(a.paragraphs.join(" ")).toContain("وفي الآخر لازم نكمل الطريق");
  });
});

describe("manual topics", () => {
  beforeEach(() => localStorage.clear());
  it("derives the topic from the article body while nothing is pinned", () => {
    const idea = saveIdea("فكرة عن النجاح في العمل");
    expect(articleTopic(idea)).toBe("العمل والنجاح");
  });
  it("pins a topic by hand and persists it without touching the edition timestamp", () => {
    const idea = saveIdea("فكرة عن النجاح في العمل");
    const updated = setArticleTopic(idea.id, "  موضوعي الخاص  ");
    expect(updated).toMatchObject({ topic: "موضوعي الخاص", topicManual: true });
    expect(updated?.updatedAt).toBe(idea.updatedAt);
    const saved = loadIdeas()[0];
    if (!saved) throw new Error("idea missing");
    expect(articleTopic(saved)).toBe("موضوعي الخاص");
  });
  it("pinning a brand-new topic name files the article under it", () => {
    const idea = saveIdea("كلام عام بلا موضوع");
    setArticleTopic(idea.id, "تصنيف لم يوجد من قبل");
    expect(articleTopic(loadIdeas()[0]!)).toBe("تصنيف لم يوجد من قبل");
  });
  it("choosing the topic the article already sits under is a no-op and sets no pin", () => {
    const idea = saveIdea("فكرة عن النجاح في العمل");
    const result = setArticleTopic(idea.id, "العمل والنجاح");
    expect(result?.topicManual).toBeUndefined();
    expect(loadIdeas()[0]?.topicManual).toBeUndefined();
  });
  it("rejects an empty topic name", () => {
    const idea = saveIdea("فكرة");
    expect(setArticleTopic(idea.id, "   ")).toBeUndefined();
    expect(loadIdeas()[0]?.topicManual).toBeUndefined();
  });
  it("unlocking removes the pin and the topic is derived again", () => {
    const idea = saveIdea("فكرة عن النجاح في العمل");
    setArticleTopic(idea.id, "موضوعي الخاص");
    const cleared = clearArticleTopic(idea.id);
    expect(cleared?.topic).toBeUndefined();
    expect(cleared?.topicManual).toBeUndefined();
    expect(articleTopic(loadIdeas()[0]!)).toBe("العمل والنجاح");
    expect(clearArticleTopic(idea.id)?.topicManual).toBeUndefined();
  });
  it("lists topics in use with counts, busiest first, pins counted where they file the article", () => {
    const a = saveIdea("فكرة عن النجاح في العمل");
    saveIdea("حديث آخر عن النجاح في العمل");
    saveIdea("كلام عن الصحة والنوم");
    setArticleTopic(a.id, "الصحة");
    const options = topicOptions(loadIdeas());
    expect(options[0]).toEqual({ topic: "الصحة", count: 2 });
    expect(options).toContainEqual({ topic: "العمل والنجاح", count: 1 });
  });
  it("a newer edition without a pin does not erase a hand-pinned topic", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 2, articleBody: "محلي", topic: "موضوعي", topicManual: true };
    const { topic: _droppedTopic, topicManual: _droppedPin, ...unpinned } = local;
    const [winner] = mergeIdeas([local], [{ ...unpinned, updatedAt: 3, articleBody: "سحابي" }], []);
    expect(winner?.articleBody).toBe("سحابي");
    expect(winner).toMatchObject({ topic: "موضوعي", topicManual: true });
  });
  it("an unpinned winner adopts the pin of the other edition", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 3, articleBody: "محلي" };
    const [winner] = mergeIdeas([local], [{ ...local, updatedAt: 2, topic: "موضوعي", topicManual: true }], []);
    expect(winner?.articleBody).toBe("محلي");
    expect(winner).toMatchObject({ topic: "موضوعي", topicManual: true });
  });
  it("the winning edition's own pin beats the other edition's pin", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 3, topic: "أ", topicManual: true };
    const [winner] = mergeIdeas([local], [{ ...local, updatedAt: 2, topic: "ب", topicManual: true }], []);
    expect(winner?.topic).toBe("أ");
  });
});
