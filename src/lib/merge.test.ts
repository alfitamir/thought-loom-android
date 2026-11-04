// Ported from Afkari's merge.test.ts: the pure-helper suites (sanitizeSuggestions with
// strength/thesis, excerptForMatching, liveSuggestions, fingerprint) run verbatim against
// Thought Loom's upgraded merge.ts; the mergeArticles suite is adapted to Loom's Engine API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissSuggestion, excerptForMatching, fingerprint, findMerges, liveSuggestions, mergeArticles, sanitizeSuggestions } from "./merge";
import { INCOMPLETE, MergeIncompleteError } from "./article-ai";
import type { Idea } from "./ideas";

const ideas: Idea[] = ["a", "b", "c", "d"].map((id, n) => ({ id, text: id, createdAt: n, updatedAt: n }));

describe("sanitizeSuggestions", () => {
  it("drops unknown ids, singletons and non-arrays", () => {
    expect(sanitizeSuggestions("x", ideas)).toEqual([]);
    expect(sanitizeSuggestions([{ ids: ["a", "zzz"], title: "t", reason: "r" }], ideas)).toEqual([]);
  });
  it("never lets one article appear in two groups", () => {
    const out = sanitizeSuggestions([
      { ids: ["a", "b"], title: "one", reason: "" },
      { ids: ["b", "c"], title: "two", reason: "" }, // b already used → only c left → dropped
    ], ideas);
    expect(out.map((s) => s.ids)).toEqual([["a", "b"]]);
  });
  it("dedupes ids inside a group and defaults the title", () => {
    const [s] = sanitizeSuggestions([{ ids: ["a", "a", "b"], title: "  ", reason: " r " }], ideas);
    expect(s).toEqual({ ids: ["a", "b"], title: "مقال مدمج", reason: "r" });
  });
});

describe("sanitizeSuggestions: strength and thesis", () => {
  it("drops weak links (strength < 3) and orders strongest first", () => {
    const out = sanitizeSuggestions([
      { ids: ["a", "b"], title: "weak", reason: "", strength: 2 },
      { ids: ["b", "d"], title: "ok", reason: "", strength: 3 },
      { ids: ["a", "c"], title: "strong", reason: "", strength: 5, thesis: " أطروحة " },
    ], ideas);
    expect(out.map((s) => s.title)).toEqual(["strong", "ok"]);
    expect(out[0]!.thesis).toBe("أطروحة");
  });
  it("a strong group claims its articles before a weaker overlapping one", () => {
    const out = sanitizeSuggestions([
      { ids: ["a", "b"], title: "weaker", reason: "", strength: 3 },
      { ids: ["b", "c"], title: "stronger", reason: "", strength: 5 },
    ], ideas);
    expect(out.map((s) => s.ids)).toEqual([["b", "c"]]);
  });
  it("caps a group at 5 articles and the list at 5 groups", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `n${i}`, text: "x", createdAt: i }));
    const groups = Array.from({ length: 7 }, (_, g) => ({ ids: [`n${g * 2}`, `n${g * 2 + 1}`], title: `g${g}`, reason: "", strength: 4 }));
    expect(sanitizeSuggestions(groups, many)).toHaveLength(5);
    expect(sanitizeSuggestions([{ ids: many.map((m) => m.id), title: "big", reason: "", strength: 4 }], many)[0]!.ids).toHaveLength(5);
  });
  it("treats a missing or garbage strength as an average link instead of discarding the group", () => {
    expect(sanitizeSuggestions([{ ids: ["a", "b"], title: "t", reason: "" }], ideas)).toHaveLength(1);
    expect(sanitizeSuggestions([{ ids: ["a", "b"], title: "t", reason: "", strength: "high" }], ideas)).toHaveLength(1);
  });
});

describe("excerptForMatching", () => {
  it("keeps short bodies whole and samples opening + ending of long ones", () => {
    expect(excerptForMatching("قصير")).toBe("قصير");
    const long = "بداية" + "و".repeat(2000) + "نهاية";
    const ex = excerptForMatching(long);
    expect(ex.startsWith("بداية")).toBe(true);
    expect(ex.endsWith("نهاية")).toBe(true);
    expect(ex.length).toBeLessThan(750);
  });
});

describe("liveSuggestions / dismissal", () => {
  const list = [{ ids: ["a", "b"], title: "t", reason: "" }, { ids: ["c", "gone"], title: "t", reason: "" }];
  it("hides groups whose articles were deleted", () => {
    expect(liveSuggestions(list, ideas).map((s) => s.ids)).toEqual([["a", "b"]]);
  });
  it("dismissal is order-insensitive and persists", () => {
    dismissSuggestion(["b", "a"]);
    expect(liveSuggestions(list, ideas)).toEqual([]);
  });
});

describe("fingerprint", () => {
  it("is order-independent and changes when an article is edited", () => {
    expect(fingerprint(ideas)).toBe(fingerprint([...ideas].reverse()));
    expect(fingerprint(ideas)).not.toBe(fingerprint(ideas.map((i) => (i.id === "a" ? { ...i, updatedAt: 99 } : i))));
  });
});

describe("mergeArticles (cloud engine)", () => {
  // Thought Loom adaptation: Afkari's mergeArticles took (sources, signal, onText) and posted
  // to its Express endpoint, which answered JSON. Thought Loom's takes an Engine and streams
  // NDJSON from /api/articles/improve; the completeness guard behavior is identical.
  afterEach(() => vi.unstubAllGlobals());
  const A = "الدولة والمجتمع والمنظومة والخلل الهيكلي في الأداء العام";
  const B = "المقاومة والأمة والعالم والاستعمار الحديث في غزة";
  const sources = [{ title: "1", body: A }, { title: "2", body: B }];
  const engine = { kind: "cloud", token: "T" } as const;
  const stub = (text: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(
    `${JSON.stringify({ type: "text", text })}\n${JSON.stringify({ type: "done" })}\n`,
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } })));
  const run = () => mergeArticles(sources, engine, new AbortController().signal, () => {});

  it("accepts a merge that keeps both sources", async () => {
    stub(`مدمج\n\n${A}. ${B}`);
    expect((await run()).title).toBe("مدمج");
  });
  it("REGRESSION: rejects a merge that silently dropped a source", async () => {
    stub(`مدمج\n\n${A}`);
    await expect(run()).rejects.toThrow(INCOMPLETE);
  });
  it("the rejection carries the proposal and the exact missing lines for the dialog", async () => {
    stub(`مدمج\n\n${A}`);
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeIncompleteError);
    const incomplete = err as MergeIncompleteError;
    expect(incomplete.message).toBe(INCOMPLETE);
    expect(incomplete.proposal).toEqual({ title: "مدمج", body: A });
    expect(incomplete.missing).toEqual([B]);
  });
});

describe("findMerges never touches liked articles", () => {
  afterEach(() => vi.unstubAllGlobals());
  const engine = { kind: "cloud", token: "T" } as const;
  const ownA: Idea = { id: "a", text: "نص أ", createdAt: 1, updatedAt: 1, articleTitle: "أ", articleBody: "الدولة والمجتمع والمنظومة" };
  const ownB: Idea = { id: "b", text: "نص ب", createdAt: 2, updatedAt: 2, articleTitle: "ب", articleBody: "المقاومة والأمة والعالم" };
  const likedX: Idea = { id: "x", text: "نص خارجي", createdAt: 3, updatedAt: 3, articleTitle: "خارجي", articleBody: "الدولة والمجتمع والمنظومة والخلل", liked: true, source: "موقع" };

  it("with fewer than two own articles it asks the model nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await findMerges([ownA, likedX], engine, new AbortController().signal)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a model group naming a liked article is dropped whole", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `${JSON.stringify({ type: "text", text: JSON.stringify([{ ids: ["a", "x"], title: "دمج", reason: "تشابه", strength: 5 }]) })}\n${JSON.stringify({ type: "done" })}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } })));
    expect(await findMerges([ownA, ownB, likedX], engine, new AbortController().signal)).toEqual([]);
  });
});
