import { describe, it, expect, beforeEach } from "vitest";
import {
  addVersion,
  capVersions,
  loadIdeas,
  mergeIdeas,
  mergeSourceVersions,
  parseVersions,
  pruneVersionsToBudget,
  restoreVersion,
  VERSION_BUDGET_BYTES,
  saveArticleIdea,
  saveIdea,
  updateArticle,
  type Idea,
  type IdeaVersion,
} from "./ideas";

const v = (
  at: number,
  text: string,
  source: IdeaVersion["source"] = "improve",
  title?: string,
): IdeaVersion => ({ at, text, source, ...(title ? { title } : {}) });

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
      null,
      "junk",
      {},
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
    const updated = updateArticle(
      idea.id,
      "العنوان المحسّن",
      "النص المحسّن كاملًا",
      true,
      "improve",
    );
    expect(updated?.articleBody).toBe("النص المحسّن كاملًا");
    expect(updated?.versions).toHaveLength(1);
    expect(updated?.versions?.[0]).toMatchObject({
      text: "النص الأول كاملًا",
      title: "العنوان الأول",
      source: "improve",
    });
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
    const current: Idea = {
      ...idea,
      versions: [v(50, "هـ"), v(40, "د"), v(30, "ج"), v(20, "ب"), v(10, "أ")],
    };
    replaceAll(current);
    const updated = updateArticle(idea.id, "عنوان جديد", "نص جديد", true, "improve")!;
    expect(updated.versions).toHaveLength(5);
    expect(updated.versions?.[0]).toMatchObject({ text: "النص الأول كاملًا", source: "improve" });
    expect(updated.versions?.map((e) => e.text)).not.toContain("أ");
    void current;
  });

  it("liked articles and songs never grow a history, even if a source is passed", () => {
    const liked = saveIdea("نص خارجي");
    replaceAll({
      ...loadIdeas().find((i) => i.id === liked.id)!,
      liked: true,
      articleTitle: "خارجي",
      articleBody: "متن خارجي",
    });
    expect(
      updateArticle(liked.id, "خارجي", "متن خارجي آخر", true, "improve")?.versions,
    ).toBeUndefined();

    const song = saveIdea("");
    replaceAll({
      ...loadIdeas().find((i) => i.id === song.id)!,
      song: true,
      articleTitle: "أغنية",
    });
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
      articleTitle: "العنوان الحالي",
      articleBody: "النص الحالي",
      updatedAt: 500,
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
    expect(restored?.versions?.[0]).toMatchObject({
      text: "النص الحالي",
      title: "العنوان الحالي",
      source: "restore",
    });
    // The restored-from entry itself survives below the new snapshot.
    expect(restored?.versions?.some((e) => e.at === 100 && e.text === "النص القديم")).toBe(true);
  });

  it("an entry without a title leaves the current title in place", () => {
    const idea = saveIdea("أصل");
    replaceAll({
      ...loadIdeas().find((i) => i.id === idea.id)!,
      articleTitle: "يبقى",
      articleBody: "حالي",
      updatedAt: 500,
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
    id: "1",
    text: "أصل",
    createdAt: 1,
    updatedAt,
    articleTitle: "ع",
    articleBody: "ب",
    versions,
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
    const a: Idea = {
      id: "a",
      text: "خام أ",
      createdAt: 1,
      articleTitle: "مقال أ",
      articleBody: "متن أ كاملًا",
    };
    const b: Idea = {
      id: "b",
      text: "خام ب",
      createdAt: 2,
      articleTitle: "مقال ب",
      articleBody: "متن ب كاملًا",
    };
    const entries = mergeSourceVersions([a, b], 1000);
    expect(entries).toEqual([
      { at: 1000, text: "متن أ كاملًا", title: "مقال أ", source: "merge" },
      { at: 999, text: "متن ب كاملًا", title: "مقال ب", source: "merge" },
    ]);
  });

  it("skips sources with no article body and caps at five", () => {
    const empty: Idea = { id: "e", text: "", createdAt: 1 };
    const many: Idea[] = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      text: "خام",
      createdAt: i,
      articleTitle: `م${i}`,
      articleBody: `متن ${i}`,
    }));
    expect(mergeSourceVersions([empty, ...many], 100)).toHaveLength(5);
  });

  it("saveArticleIdea stores the frozen texts as the merged article's history", () => {
    const entries = mergeSourceVersions(
      [{ id: "a", text: "خام", createdAt: 1, articleTitle: "أ", articleBody: "متن أ" }],
      50,
    );
    const merged = saveArticleIdea("خام مدمج", "المدمج", "نص مدمج", ["a"], { versions: entries });
    expect(merged.versions).toEqual(entries);
    expect(loadIdeas().find((i) => i.id === merged.id)?.versions).toEqual(entries);
  });
});

describe("pruneVersionsToBudget (Wave F storage diet)", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const totalVersionBytes = (all: Idea[]) =>
    all.reduce(
      (sum, i) =>
        sum + (i.versions ?? []).reduce((s, e) => s + bytes(e.text) + bytes(e.title ?? ""), 0),
      0,
    );
  const bigIdea = (id: string, versionTexts: string[], startAt: number): Idea => ({
    id,
    text: `خام ${id}`,
    createdAt: startAt,
    articleTitle: `عنوان ${id}`,
    articleBody: `المتن الحالي ${id}`,
    versions: versionTexts.map((text, j) => v(startAt + versionTexts.length - j, text)),
  });

  it("is exported with the documented 800,000-byte budget", () => {
    expect(VERSION_BUDGET_BYTES).toBe(800_000);
  });

  it("drops exact-duplicate texts within an article and any copy of the current body", () => {
    const idea: Idea = {
      id: "d",
      text: "خام",
      createdAt: 1,
      articleBody: "المتن الحالي",
      versions: [v(40, "نسخة فريدة"), v(30, "المتن الحالي"), v(20, "نسخة فريدة"), v(10, "أخرى")],
    };
    const [out] = pruneVersionsToBudget([idea]);
    expect(out?.versions?.map((e) => e.at)).toEqual([40, 10]);
  });

  it("prunes the globally oldest versions first until the budget holds", () => {
    // 10 articles × 5 versions × ~30 KB ≈ 1.5 MB of history — over budget.
    const filler = "س".repeat(15_000); // ~30,000 UTF-8 bytes
    const all = Array.from({ length: 10 }, (_, i) =>
      bigIdea(
        `a${i}`,
        Array.from({ length: 5 }, (_, j) => `نسخة ${i}-${j} ${filler}`),
        (i + 1) * 100,
      ),
    );
    const out = pruneVersionsToBudget(all);
    expect(totalVersionBytes(out)).toBeLessThanOrEqual(VERSION_BUDGET_BYTES);
    // The globally oldest snapshot (article a0, at=100... its oldest is at 101)
    // goes before newer ones; every article keeps at least one version.
    const remaining = out.flatMap((i) => i.versions ?? []).map((e) => e.at);
    // a0's four oldest are gone; its newest (at=105) is protected and stays.
    expect(remaining).not.toContain(101);
    expect(remaining).not.toContain(102);
    expect(remaining).not.toContain(103);
    expect(remaining).not.toContain(104);
    expect(remaining).toContain(105);
    for (const idea of out) expect(idea.versions?.length).toBeGreaterThanOrEqual(1);
  });

  it("always keeps each article's newest version, even when it alone busts the budget", () => {
    const huge = "ح".repeat(450_000); // ~900,000 UTF-8 bytes > the whole budget
    const idea = bigIdea("big", [huge, "صغيرة قديمة"], 100);
    // bigIdea maps newest first: at=102 is the huge one, at=101 the small old one.
    const [out] = pruneVersionsToBudget([idea]);
    expect(out?.versions).toHaveLength(1);
    expect(out?.versions?.[0]?.text).toBe(huge);
  });

  it("never mutates the caller's data and is idempotent", () => {
    const filler = "س".repeat(15_000);
    const all = Array.from({ length: 10 }, (_, i) =>
      bigIdea(
        `m${i}`,
        Array.from({ length: 5 }, (_, j) => `نسخة ${i}-${j} ${filler}`),
        (i + 1) * 100,
      ),
    );
    const snapshot = JSON.parse(JSON.stringify(all)) as Idea[];
    const once = pruneVersionsToBudget(all);
    expect(all).toEqual(snapshot);
    expect(pruneVersionsToBudget(once)).toEqual(once);
  });

  it("an article whose history is fully pruned as duplicates loses the versions key", () => {
    const idea: Idea = {
      id: "x",
      text: "خام",
      createdAt: 1,
      articleBody: "المتن",
      versions: [v(2, "المتن"), v(1, "المتن")],
    };
    const [out] = pruneVersionsToBudget([idea]);
    expect(out).not.toHaveProperty("versions");
    expect(idea.versions).toHaveLength(2);
  });
});
