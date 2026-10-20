import { describe, expect, it } from "vitest";
import { isMergeComplete } from "./article-ai";
import { sanitizeSuggestions } from "./merge";
import { buildBackup, parseBackup } from "./backup";
import type { Idea } from "./ideas";

const a = "الصبر مفتاح الفرج في الشغل والحياة. لما بتصبر على زملائك بتكسب احترامهم في الآخر.";
const b = "تنظيم الأولويات بيخليني مرتاح البال. بكتب المهام كل صباح وبخلص الأهم الأول.";

describe("merge completeness", () => {
  it("accepts a merge that keeps every source idea to the end", () => {
    expect(isMergeComplete([a, b], `${a}\n\nوكمان، ${b}`)).toBe(true);
  });
  it("rejects a merge that drops one of the source articles", () => {
    expect(isMergeComplete([a, b], a)).toBe(false);
  });
  it("rejects a merge that loses the last sentence of a source", () => {
    expect(isMergeComplete([a, b], `${a}\n\nتنظيم الأولويات بيخليني مرتاح البال.`)).toBe(false);
  });
});

describe("merge suggestions", () => {
  const ideas: Idea[] = ["1", "2", "3"].map((id) => ({ id, text: "x", createdAt: 1 }));
  it("keeps only known ids, groups of two or more, and each article once", () => {
    expect(sanitizeSuggestions([
      { ids: ["1", "2", "9"], title: "العمل", reason: "" },
      { ids: ["2", "3"], title: "مكرر", reason: "" },
    ], ideas)).toEqual([{ ids: ["1", "2"], title: "العمل", reason: "" }]);
  });
});

describe("backup", () => {
  it("round-trips every idea with its edited article", () => {
    const ideas: Idea[] = [{ id: "1", text: "أصل", createdAt: 5, articleTitle: "عنوان", articleBody: "نص", updatedAt: 7, aiPolishedAt: 7 }];
    expect(parseBackup(buildBackup(ideas))).toEqual(ideas);
  });
  it("rejects files that are not an afkari backup", () => {
    expect(() => parseBackup('{"ideas":[]}')).toThrow("ليس نسخة احتياطية");
    expect(() => parseBackup("not json")).toThrow();
  });
});
