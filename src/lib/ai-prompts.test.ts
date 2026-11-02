import { describe, expect, it } from "vitest";
import { CLASSIFY_INSTRUCTIONS, TOPIC_LIST, sanitizeAsk, sanitizeInsights, sanitizeLabels } from "./ai-prompts";
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
