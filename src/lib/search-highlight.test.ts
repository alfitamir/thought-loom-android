import { describe, expect, it } from "vitest";
import { countOccurrences, splitByQuery } from "./search-highlight";

const joined = (text: string, query: string) =>
  splitByQuery(text, query)
    .map((s) => s.text)
    .join("");
const matched = (text: string, query: string) =>
  splitByQuery(text, query)
    .filter((s) => s.match)
    .map((s) => s.text);

describe("splitByQuery", () => {
  it("returns one non-match segment when there is no query", () => {
    expect(splitByQuery("نص عادي", "")).toEqual([{ text: "نص عادي", match: false }]);
    expect(splitByQuery("نص عادي", "   ")).toEqual([{ text: "نص عادي", match: false }]);
  });

  it("returns no segments for empty text", () => {
    expect(splitByQuery("", "كلمة")).toEqual([]);
  });

  it("returns one non-match segment when nothing matches", () => {
    expect(splitByQuery("مرحبا بالعالم", "غائب")).toEqual([
      { text: "مرحبا بالعالم", match: false },
    ]);
  });

  it("wraps every occurrence and preserves the original text", () => {
    const text = "الصبر مفتاح الفرج، والصبر جميل";
    const segments = splitByQuery(text, "الصبر");
    expect(segments.filter((s) => s.match)).toHaveLength(2);
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });

  it("matches Latin case-insensitively but keeps the original casing", () => {
    expect(matched("Hello hello HELLO", "hello")).toEqual(["Hello", "hello", "HELLO"]);
    expect(joined("Hello hello HELLO", "hello")).toBe("Hello hello HELLO");
  });

  it("folds alef forms like the library filter does", () => {
    expect(matched("الإيمان نور", "الايمان")).toEqual(["الإيمان"]);
    expect(matched("آية وإشارة", "ايه")).toEqual([]);
    expect(matched("السلام عليكم", "السَّلام")).toEqual(["السلام"]);
  });

  it("matches across diacritics inside the text", () => {
    const text = "السَّلَامُ عليكم";
    const hit = matched(text, "السلام");
    expect(hit).toHaveLength(1);
    expect(joined(text, "السلام")).toBe(text);
  });

  it("does not double-count overlapping occurrences", () => {
    expect(matched("aaa", "aa")).toEqual(["aa"]);
  });
});

describe("countOccurrences", () => {
  it("counts occurrences in Arabic and Latin text", () => {
    expect(countOccurrences("الصبر جميل والصبر مفتاح", "الصبر")).toBe(2);
    expect(countOccurrences("Test test TEST", "test")).toBe(3);
  });

  it("is zero for empty query, empty text, or no match", () => {
    expect(countOccurrences("نص", "")).toBe(0);
    expect(countOccurrences("", "نص")).toBe(0);
    expect(countOccurrences("نص قصير", "غائب")).toBe(0);
  });

  it("agrees with splitByQuery on non-overlapping counting", () => {
    expect(countOccurrences("aaa", "aa")).toBe(1);
    expect(countOccurrences("الإيمان والإيمان", "الايمان")).toBe(2);
  });
});
