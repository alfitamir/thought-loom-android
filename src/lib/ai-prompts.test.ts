import { describe, expect, it } from "vitest";
import { CLASSIFY_INSTRUCTIONS, TOPIC_LIST, sanitizeAdditions, sanitizeAsk, sanitizeInsights, sanitizeLabels } from "./ai-prompts";
import { OTHER } from "./topics";

describe("sanitizeAsk", () => {
  const known = new Set(["a", "b"]);
  it("keeps only known, de-duplicated sources", () => {
    const out = sanitizeAsk({ answer: " جواب ", sources: [{ id: "a", note: " n " }, { id: "a", note: "dup" }, { id: "zzz", note: "x" }, null] }, known);
    expect(out).toEqual({ answer: "جواب", sources: [{ id: "a", note: "n" }] });
  });
  it("tolerates a missing sources array", () => {
    expect(sanitizeAsk({ answer: "x" }, known).sources).toEqual([]);
  });
  it("throws when there is no answer rather than showing a blank result", () => {
    expect(() => sanitizeAsk({ answer: "  ", sources: [] }, known)).toThrow();
    expect(() => sanitizeAsk(null, known)).toThrow();
  });
});

describe("sanitizeLabels", () => {
  const fb = () => "fallback-topic";
  it("accepts only topics from the closed list, else falls back", () => {
    const out = sanitizeLabels([{ id: "a", topic: TOPIC_LIST[0], tags: ["x"] }, { id: "b", topic: "اخترعته", tags: [] }], ["a", "b"], fb);
    expect(out["a"]!.topic).toBe(TOPIC_LIST[0]);
    expect(out["b"]!.topic).toBe("fallback-topic");
  });
  it("drops unknown ids and keeps the first label per id", () => {
    const out = sanitizeLabels([{ id: "q", topic: OTHER, tags: [] }, { id: "a", topic: OTHER, tags: ["1"] }, { id: "a", topic: OTHER, tags: ["2"] }], ["a"], fb);
    expect(Object.keys(out)).toEqual(["a"]);
    expect(out["a"]!.tags).toEqual(["1"]);
  });
  it("cleans tags: strips #, trims, dedupes, drops empty/long, caps at 4", () => {
    const out = sanitizeLabels([{ id: "a", topic: OTHER, tags: ["#دولة", " دولة ", "", "x".repeat(31), "1", "2", "3", "4", "5"] }], ["a"], fb);
    expect(out["a"]!.tags).toEqual(["دولة", "1", "2", "3"]);
  });
  it("the classify prompt lists every allowed topic", () => {
    for (const t of TOPIC_LIST) expect(CLASSIFY_INSTRUCTIONS).toContain(t);
  });
});

describe("sanitizeInsights", () => {
  const ids = ["a", "b", "c"];
  it("drops themes with fewer than two real articles or no name", () => {
    const out = sanitizeInsights({
      themes: [{ name: "ok", summary: "s", ids: ["a", "b", "zzz"] }, { name: "thin", summary: "", ids: ["a"] }, { name: " ", summary: "", ids: ["a", "b"] }],
      prompts: [{ title: "t", angle: "a" }, { title: "", angle: "x" }],
    }, ids);
    expect(out.themes).toEqual([{ name: "ok", summary: "s", ids: ["a", "b"] }]);
    expect(out.prompts).toEqual([{ title: "t", angle: "a" }]);
  });
  it("throws when nothing usable came back", () => {
    expect(() => sanitizeInsights({ themes: [], prompts: [] }, ids)).toThrow();
    expect(() => sanitizeInsights("junk", ids)).toThrow();
  });
});

describe("sanitizeAdditions", () => {
  it("returns empty arrays for unusable input instead of throwing", () => {
    const empty = { additions: [], quotes: [], questions: [] };
    expect(sanitizeAdditions(null)).toEqual(empty);
    expect(sanitizeAdditions("junk")).toEqual(empty);
    expect(sanitizeAdditions({ additions: "x", quotes: 3, questions: {} })).toEqual(empty);
  });
  it("keeps only well-shaped entries, trimmed and bounded", () => {
    const out = sanitizeAdditions({
      additions: ["  زاوية  ", "", 7, "ب".repeat(600)],
      quotes: [
        { quote: " قول ", author: " مؤلف ", context: " سياق " },
        { quote: "   ", author: "x", context: "y" },
        { author: "بلا نص" },
        null,
      ],
      questions: [" سؤال؟ ", ""],
    });
    expect(out.additions[0]).toBe("زاوية");
    expect(out.additions[1]).toHaveLength(500);
    expect(out.additions).toHaveLength(2);
    expect(out.quotes).toEqual([{ quote: "قول", author: "مؤلف", context: "سياق" }]);
    expect(out.questions).toEqual(["سؤال؟"]);
  });
  it("caps the list sizes (10 additions, 8 quotes, 10 questions)", () => {
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    const out = sanitizeAdditions({
      additions: many(15, (i) => `a${i}`),
      quotes: many(12, (i) => ({ quote: `q${i}`, author: "a", context: "c" })),
      questions: many(14, (i) => `s${i}`),
    });
    expect(out.additions).toHaveLength(10);
    expect(out.quotes).toHaveLength(8);
    expect(out.questions).toHaveLength(10);
  });
});
