import { describe, it, expect, beforeEach } from "vitest";
import {
  addVersion, capVersions, loadIdeas, mergeIdeas, mergeSourceVersions, parseVersions,
  restoreVersion, saveArticleIdea, saveIdea, updateArticle,
  type Idea, type IdeaVersion,
} from "./ideas";

const v = (at: number, text: string, source: IdeaVersion["source"] = "improve", title?: string): IdeaVersion =>
  ({ at, text, source, ...(title ? { title } : {}) });

describe("version entries", () => {
  it("stores newest first and caps at five, dropping the oldest", () => {
    let list: IdeaVersion[] = [];
    for (let at = 1; at <= 7; at++) list = addVersion(list, v(at, `نص ${at}`));
    expect(list.map((e) => e.at)).toEqual([7, 6, 5, 4, 3]);
  });

  it("skips a snapshot identical to the newest existing one", () => {
    const list = [v(5, "نفس النص", "improve", "نفس العنوان")];
    expect(addVersion(list, v(9, "نفس النص", "clean", "نفس العنوان"))).toBe(list);
    // Same text under a different title is a different state — it is kept.
    expect(addVersion(list, v(9, "نفس النص", "clean", "عنوان آخر"))).toHaveLength(2);
    // And a different text is always kept.
    expect(addVersion(list, v(9, "نص مختلف", "clean", "نفس العنوان"))).toHaveLength(2);
  });

  it("capVersions sorts newest-first before capping", () => {
    const list = [v(2, "ب"), v(9, "ط"), v(1, "أ"), v(5, "هـ"), v(7, "ز"), v(3, "ج")];
    expect(capVersions(list).map((e) => e.at)).toEqual([9, 7, 5, 3, 2]);
  });
});

describe("parseVersions (untrusted data)", () => {
  it("keeps valid entries, sorted newest-first and capped", () => {
    const raw = [v(1, "أ"), v(6, "و"), v(3, "ج"), v(2, "ب"), v(5, "هـ"), v(4, "د")];
    expect(parseVersions(raw)?.map((e) => e.at)).toEqual([6, 5, 4, 3, 2]);
  });

  it("drops malformed entries instead of guessing them back into shape", () => {
    const raw = [
      { at: Number.NaN, text: "وقت تالف", source: "improve" },
      { at: "100", text: "وقت نصي", source: "improve" },
      { at: 100, text: "", source: "improve" },
      { at: 100, text: 42, source: "improve" },
      { at: 100, text: "مصدر مجهول", source: "bogus" },
      null, "junk", {},
      { at: 100, text: "السليم الوحيد", source: "restore", title: "  " },
    ];
    expect(parseVersions(raw)).toEqual([{ at: 100, text: "السليم الوحيد", source: "restore" }]);
  });

  it("returns undefined for non-arrays and for arrays with nothing valid", () => {
    expect(parseVersions(undefined)).toBeUndefined();
    expect(parseVersions("nope")).toBeUndefined();
    expect(parseVersions([])).toBeUndefined();
    expect(parseVersions([{ at: 1 }])).toBeUndefined();
  });
});

describe("snapshots at the updateArticle write point", () => {
  beforeEach(() => localStorage.clear());

  const seedArticle = (): Idea => {
    const idea = saveIdea("مسودة أصلية");
    updateArticle(idea.id, "العنوان الأول", "النص الأول كاملًا");
    return loadIdeas().find((i) => i.id === idea.id)!;
  };

  it("an improve apply freezes the pre-replacement text and title", () => {
    const idea = seedArticle();
    const updated = updateArticle(idea.id, "العنوان المحسّن", "النص المحسّن كاملًا", true, "improve");
    expect(updated?.articleBody).toBe("النص المحسّن كاملًا");
    expect(updated?.versions).toHaveLength(1);
    expect(updated?.versions?.[0]).toMatchObject({ text: "النص الأول كاملًا", title: "العنوان الأول", source: "improve" });
  });

  it("a clean apply (the bulk-clean path) records source 'clean'", () => {
    const idea = seedArticle();
    const updated = updateArticle(idea.id, "العنوان الأول", "النص الأول مضبوطًا", true, "clean");
    expect(updated?.versions?.[0]).toMatchObject({ text: "النص الأول كاملًا", source: "clean" });
  });

  it("a manual save (no source) never snapshots", () => {
    const idea = seedArticle();
    const updated = updateArticle(idea.id, "عنوان يدوي", "نص يدوي جديد");
    expect(updated?.versions).toBeUndefined();
  });

  it("a no-op replacement snapshots nothing — there is nothing to protect", () => {
    const idea = seedArticle();
    const updated = updateArticle(idea.id, "العنوان الأول", "النص الأول كاملًا", true, "improve");
    expect(updated?.versions).toBeUndefined();
  });

  it("the cap holds through the write path: the sixth snapshot pushes the oldest out", () => {
    const idea = seedArticle();
    let current: Idea = { ...idea, versions: [v(50, "هـ"), v(40, "د"), v(30, "ج"), v(20, "ب"), v(10, "أ")] };
    replaceAll(current);
    const updated = updateArticle(idea.id, "عنوان جديد", "نص جديد", true, "improve")!;
    expect(updated.versions).toHaveLength(5);
    expect(updated.versions?.[0]).toMatchObject({ text: "النص الأول كاملًا", source: "improve" });
    expect(updated.versions?.map((e) => e.text)).not.toContain("أ");
    void current;
  });

  it("liked articles and songs never grow a history, even if a source is passed", () => {
    const liked = saveIdea("نص خارجي");
    replaceAll({ ...loadIdeas().find((i) => i.id === liked.id)!, liked: true, articleTitle: "خارجي", articleBody: "متن خارجي" });
    expect(updateArticle(liked.id, "خارجي", "متن خارجي آخر", true, "improve")?.versions).toBeUndefined();

    const song = saveIdea("");
    replaceAll({ ...loadIdeas().find((i) => i.id === song.id)!, song: true, articleTitle: "أغنية" });
    expect(updateArticle(song.id, "أغنية", "كلمات", false, "clean")?.versions).toBeUndefined();
  });
});

const replaceAll = (idea: Idea) => {
  const all = loadIdeas().map((i) => (i.id === idea.id ? idea : i));
  localStorage.setItem("afkari.ideas", JSON.stringify(all));
};

describe("restoreVersion", () => {
  beforeEach(() => localStorage.clear());

  const seed = (): Idea => {
    const idea = saveIdea("أصل");
    const withHistory: Idea = {
      ...loadIdeas().find((i) => i.id === idea.id)!,
      articleTitle: "العنوان الحالي", articleBody: "النص الحالي", updatedAt: 500,
      versions: [v(100, "النص القديم", "improve", "العنوان القديم")],
    };
    replaceAll(withHistory);
    return withHistory;
  };

  it("restores text and title, and freezes the pre-restore text as a 'restore' version", () => {
    const idea = seed();
    const restored = restoreVersion(idea.id, 100);
    expect(restored?.articleTitle).toBe("العنوان القديم");
    expect(restored?.articleBody).toBe("النص القديم");
    expect(restored?.versions?.[0]).toMatchObject({ text: "النص الحالي", title: "العنوان الحالي", source: "restore" });
    // The restored-from entry itself survives below the new snapshot.
    expect(restored?.versions?.some((e) => e.at === 100 && e.text === "النص القديم")).toBe(true);
  });

  it("an entry without a title leaves the current title in place", () => {
    const idea = saveIdea("أصل");
    replaceAll({
      ...loadIdeas().find((i) => i.id === idea.id)!,
      articleTitle: "يبقى", articleBody: "حالي", updatedAt: 500,
      versions: [v(100, "قديم بلا عنوان", "clean")],
    });
    const restored = restoreVersion(idea.id, 100);
    expect(restored?.articleTitle).toBe("يبقى");
    expect(restored?.articleBody).toBe("قديم بلا عنوان");
  });

  it("unknown timestamps and ineligible articles restore nothing", () => {
    const idea = seed();
    expect(restoreVersion(idea.id, 999)).toBeUndefined();
    expect(loadIdeas().find((i) => i.id === idea.id)?.articleBody).toBe("النص الحالي");
    const liked: Idea = { ...idea, id: "l1", liked: true, versions: [v(5, "x")] };
    localStorage.setItem("afkari.ideas", JSON.stringify([liked]));
    expect(restoreVersion("l1", 5)).toBeUndefined();
  });
});

describe("mergeIdeas unions version history", () => {
  const base = (versions: IdeaVersion[], updatedAt: number): Idea => ({
    id: "1", text: "أصل", createdAt: 1, updatedAt, articleTitle: "ع", articleBody: "ب", versions,
  });

  it("snapshots from BOTH editions survive, deduped by timestamp, newest first", () => {
    const local = base([v(300, "ج"), v(100, "أ")], 10);
    const remote = base([v(200, "ب"), v(100, "أ")], 9);
    const [merged] = mergeIdeas([local], [remote], []);
    expect(merged?.versions?.map((e) => e.at)).toEqual([300, 200, 100]);
  });

  it("the union survives even when the REMOTE edition wins the text", () => {
    const local = base([v(50, "محلي")], 1);
    const remote = base([v(60, "سحابي")], 2);
    const [merged] = mergeIdeas([local], [remote], []);
    expect(merged?.versions?.map((e) => e.at)).toEqual([60, 50]);
  });

  it("the cap is applied after the union, not before", () => {
    const local = base([v(500, "هـ"), v(400, "د"), v(300, "ج")], 10);
    const remote = base([v(250, "ب٢"), v(200, "ب"), v(100, "أ")], 9);
    const [merged] = mergeIdeas([local], [remote], []);
    expect(merged?.versions?.map((e) => e.at)).toEqual([500, 400, 300, 250, 200]);
  });
});

describe("mergeSourceVersions + saveArticleIdea", () => {
  beforeEach(() => localStorage.clear());

  it("freezes each source's full text, labelled with its title, first source first", () => {
    const a: Idea = { id: "a", text: "خام أ", createdAt: 1, articleTitle: "مقال أ", articleBody: "متن أ كاملًا" };
    const b: Idea = { id: "b", text: "خام ب", createdAt: 2, articleTitle: "مقال ب", articleBody: "متن ب كاملًا" };
    const entries = mergeSourceVersions([a, b], 1000);
    expect(entries).toEqual([
      { at: 1000, text: "متن أ كاملًا", title: "مقال أ", source: "merge" },
      { at: 999, text: "متن ب كاملًا", title: "مقال ب", source: "merge" },
    ]);
  });

  it("skips sources with no article body and caps at five", () => {
    const empty: Idea = { id: "e", text: "", createdAt: 1 };
    const many: Idea[] = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`, text: "خام", createdAt: i, articleTitle: `م${i}`, articleBody: `متن ${i}`,
    }));
    expect(mergeSourceVersions([empty, ...many], 100)).toHaveLength(5);
  });

  it("saveArticleIdea stores the frozen texts as the merged article's history", () => {
    const entries = mergeSourceVersions([{ id: "a", text: "خام", createdAt: 1, articleTitle: "أ", articleBody: "متن أ" }], 50);
    const merged = saveArticleIdea("خام مدمج", "المدمج", "نص مدمج", ["a"], { versions: entries });
    expect(merged.versions).toEqual(entries);
    expect(loadIdeas().find((i) => i.id === merged.id)?.versions).toEqual(entries);
  });
});
