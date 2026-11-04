import { describe, it, expect, beforeEach } from "vitest";
import { classify, toArticle, OTHER, getArticle, matchesArticle, saveIdea, updateArticle, loadIdeas, replaceIdeas, mergeIdeas, articleTopic, setArticleTopic, clearArticleTopic, topicOptions, setPinned, sortWithPinnedFirst, setMedical, partitionIdeas, buildSongIdea, saveArticleIdea } from "./ideas";

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

describe("library pinning", () => {
  beforeEach(() => localStorage.clear());
  it("pins and unpins without ever bumping updatedAt", () => {
    const idea = saveIdea("فكرة للتثبيت");
    const edited = updateArticle(idea.id, "عنوان", "نص المقال") ?? idea;
    const stamp = edited.updatedAt;
    const pinned = setPinned(idea.id, true);
    expect(pinned?.pinned).toBe(true);
    expect(pinned?.updatedAt).toBe(stamp);
    expect(loadIdeas().find((i) => i.id === idea.id)?.pinned).toBe(true);
    const unpinned = setPinned(idea.id, false);
    expect(unpinned).not.toHaveProperty("pinned");
    expect(unpinned?.updatedAt).toBe(stamp);
  });
  it("setting the pin state the article already has is a no-op", () => {
    const idea = saveIdea("فكرة عادية");
    expect(setPinned(idea.id, false)).not.toHaveProperty("pinned");
    setPinned(idea.id, true);
    const again = setPinned(idea.id, true);
    expect(again?.pinned).toBe(true);
    expect(setPinned("missing-id", true)).toBeUndefined();
  });
  it("sorts pinned articles first and keeps the rest in their order", () => {
    const a = { id: "a", text: "أ", createdAt: 3 };
    const b = { id: "b", text: "ب", createdAt: 2, pinned: true };
    const c = { id: "c", text: "ج", createdAt: 1 };
    const d = { id: "d", text: "د", createdAt: 0, pinned: true };
    expect(sortWithPinnedFirst([a, b, c, d]).map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
    // The input list is not mutated.
    expect([a, b, c, d].map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("a newer edition without the pin does not unpin the winner", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 2, articleBody: "محلي", pinned: true };
    const [winner] = mergeIdeas([local], [{ id: "1", text: "الأصل", createdAt: 1, updatedAt: 3, articleBody: "سحابي" }], []);
    expect(winner?.articleBody).toBe("سحابي");
    expect(winner?.pinned).toBe(true);
  });
  it("an unpinned winner adopts the other edition's pin", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 3, articleBody: "محلي" };
    const [winner] = mergeIdeas([local], [{ ...local, updatedAt: 2, pinned: true }], []);
    expect(winner?.articleBody).toBe("محلي");
    expect(winner?.pinned).toBe(true);
  });
});

describe("medical section", () => {
  beforeEach(() => localStorage.clear());
  it("moves an article in and out without ever bumping updatedAt", () => {
    const idea = saveIdea("فكرة طبية");
    const edited = updateArticle(idea.id, "عنوان", "نص المقال") ?? idea;
    const stamp = edited.updatedAt;
    const moved = setMedical(idea.id, true);
    expect(moved?.medical).toBe(true);
    expect(moved?.updatedAt).toBe(stamp);
    expect(loadIdeas().find((i) => i.id === idea.id)?.medical).toBe(true);
    const back = setMedical(idea.id, false);
    expect(back).not.toHaveProperty("medical");
    expect(back?.updatedAt).toBe(stamp);
  });
  it("setting the section state the article already has is a no-op", () => {
    const idea = saveIdea("فكرة عادية");
    expect(setMedical(idea.id, false)).not.toHaveProperty("medical");
    setMedical(idea.id, true);
    expect(setMedical(idea.id, true)?.medical).toBe(true);
    expect(setMedical("missing-id", true)).toBeUndefined();
  });
  it("a song can never become a medical article", () => {
    const song = buildSongIdea({ title: "أغنية" });
    expect(song).not.toHaveProperty("medical");
    replaceIdeas([song]);
    expect(setMedical(song.id, true)).not.toHaveProperty("medical");
    expect(loadIdeas().find((i) => i.id === song.id)).not.toHaveProperty("medical");
  });
  it("an idea saved in medical context is born medical; a plain one is not", () => {
    expect(saveIdea("نص طبي", { medical: true }).medical).toBe(true);
    expect(saveIdea("نص عام")).not.toHaveProperty("medical");
    expect(saveIdea("نص عام آخر", {})).not.toHaveProperty("medical");
    expect(saveIdea("نص عام ثالث", { medical: false })).not.toHaveProperty("medical");
  });
  it("a newer edition without the flag does not pull the winner out of the section", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 2, articleBody: "محلي", medical: true };
    const [winner] = mergeIdeas([local], [{ id: "1", text: "الأصل", createdAt: 1, updatedAt: 3, articleBody: "سحابي" }], []);
    expect(winner?.articleBody).toBe("سحابي");
    expect(winner?.medical).toBe(true);
  });
  it("a general winner adopts the other edition's medical flag", () => {
    const local = { id: "1", text: "الأصل", createdAt: 1, updatedAt: 3, articleBody: "محلي" };
    const [winner] = mergeIdeas([local], [{ ...local, updatedAt: 2, medical: true }], []);
    expect(winner?.articleBody).toBe("محلي");
    expect(winner?.medical).toBe(true);
  });
  it("partitionIdeas splits the two sections without overlap or loss", () => {
    const list = [
      { id: "a", text: "أ", createdAt: 3 },
      { id: "b", text: "ب", createdAt: 2, medical: true },
      { id: "c", text: "ج", createdAt: 1 },
      { id: "d", text: "د", createdAt: 0, medical: true, song: true },
    ];
    const { main, medical } = partitionIdeas(list);
    expect(main.map((i) => i.id)).toEqual(["a", "c"]);
    expect(medical.map((i) => i.id)).toEqual(["b", "d"]);
  });
  it("partitionIdeas gives songs a section of their own, out of the main library", () => {
    const list = [
      { id: "a", text: "أ", createdAt: 4 },
      { id: "s1", text: "كلمات", createdAt: 3, song: true },
      { id: "b", text: "ب", createdAt: 2, medical: true },
      { id: "s2", text: "", createdAt: 1, song: true },
      { id: "c", text: "ج", createdAt: 0 },
    ];
    const { main, medical, songs } = partitionIdeas(list);
    expect(main.map((i) => i.id)).toEqual(["a", "c"]);
    expect(medical.map((i) => i.id)).toEqual(["b"]);
    expect(songs.map((i) => i.id)).toEqual(["s1", "s2"]);
    // No loss, no overlap: every idea lands in exactly one partition.
    expect(main.length + medical.length + songs.length).toBe(list.length);
  });
  it("a merged article can stay in the medical section", () => {
    const merged = saveArticleIdea("نص مدمج", "عنوان", "متن", undefined, { medical: true });
    expect(merged.medical).toBe(true);
    const general = saveArticleIdea("نص مدمج", "عنوان", "متن");
    expect(general).not.toHaveProperty("medical");
  });
});
