import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "./ideas";

const geminiStream = vi.fn();
vi.mock("./gemini", async (orig) => ({
  ...(await orig<typeof import("./gemini")>()),
  geminiStream: (...a: unknown[]) => geminiStream(...a),
}));

// Thought Loom adaptation: Afkari's features posted to its Express /api/gemini/* endpoints
// when no personal key was saved. Here the no-key path resolves the cloud engine
// (resolveEngine mocked to a signed-in session) and streams NDJSON from
// /api/articles/improve; transcription goes to /api/voice/transcribe (SSE).
vi.mock("./ai-engine", () => ({ resolveEngine: async () => ({ kind: "cloud", token: "T" }) }));

import {
  askIdeas,
  classifyBatch,
  excerptFor,
  getArticleEnrichment,
  getEvidence,
  getFacebookPost,
  getInsights,
  retrieveRelevant,
  transcribeAudio,
} from "./ai-features";
import { clearEvidenceCache } from "./evidence";

const idea = (id: string, title: string, body: string, createdAt = 1): Idea => ({
  id,
  text: body,
  createdAt,
  articleTitle: title,
  articleBody: body,
  updatedAt: createdAt,
});
const lib = [
  idea("g", "غزة والمقاومة", "كلام طويل عن غزة والمقاومة والاحتلال.\n\nفقرة ثانية عن الصبر.", 1),
  idea("f", "الأسرة والتربية", "التربية في الأسرة المسلمة مسؤولية مشتركة.", 2),
  idea("w", "العمل والإدارة", "إدارة الفريق في الشركة تحتاج وضوحا.", 3),
];

const fetchMock = vi.fn();
beforeEach(() => {
  geminiStream.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const reply = (payload: unknown, ok = true) =>
  fetchMock.mockResolvedValue({ ok, json: async () => payload });
const ndjson = (text: string) =>
  new Response(`${JSON.stringify({ type: "text", text })}\n${JSON.stringify({ type: "done" })}\n`, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
const replyModel = (payload: unknown) =>
  fetchMock.mockResolvedValue(ndjson(JSON.stringify(payload)));

describe("retrieveRelevant", () => {
  it("ranks the article whose title/body matches the question first", () => {
    expect(retrieveRelevant("ما رأيي في المقاومة في غزة؟", lib)[0]!.id).toBe("g");
    expect(retrieveRelevant("كيف أربي أولادي في الأسرة", lib)[0]!.id).toBe("f");
  });
  it("matches despite diacritics, hamza variants and the definite article", () => {
    expect(retrieveRelevant("الإِدَارَةُ", lib)[0]!.id).toBe("w");
  });
  it("treats ة/ه and ى/ي spelling variants as the same word", () => {
    expect(retrieveRelevant("غزه", lib)[0]!.id).toBe("g");
    expect(retrieveRelevant("الاداره", lib)[0]!.id).toBe("w");
  });
  it("falls back to the newest articles when nothing matches", () => {
    expect(retrieveRelevant("zzzz qqqq", lib).map((a) => a.id)).toEqual(["w", "f", "g"]);
  });
  it("respects k and the excerpt size cap", () => {
    const big = idea(
      "big",
      "غزة",
      Array.from({ length: 50 }, (_, i) => `فقرة ${i} عن غزة ${"كلمة ".repeat(40)}`).join("\n\n"),
    );
    const [a] = retrieveRelevant("غزة", [big, ...lib], 1, 500);
    expect(retrieveRelevant("غزة", [big, ...lib], 1)).toHaveLength(1);
    expect(a!.excerpt.length).toBeLessThanOrEqual(500);
  });
});

describe("excerptFor", () => {
  it("prefers the paragraphs that mention the question terms, in original order", () => {
    const body = "مقدمة عامة.\n\nعن الصبر وحده.\n\nعن غزة والمقاومة.";
    expect(excerptFor(body, ["غزه"], 20)).toBe("عن غزة والمقاومة.");
  });
});

describe("askIdeas routing", () => {
  it("uses the app server route when no personal key is saved", async () => {
    replyModel({
      answer: "جواب",
      sources: [
        { id: "g", note: "n" },
        { id: "fake", note: "x" },
      ],
    });
    const out = await askIdeas("المقاومة", lib);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/articles/improve");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).task).toBe("ask");
    expect(out.sources.map((s) => s.id)).toEqual(["g"]); // hallucinated id removed
    expect(out.used.length).toBeGreaterThan(0);
  });
  it("uses the user's own Gemini key directly when provided, bypassing the server", async () => {
    geminiStream.mockResolvedValue(JSON.stringify({ answer: "جواب", sources: [] }));
    const out = await askIdeas("المقاومة", lib, { key: "K" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(geminiStream.mock.calls[0]![0]).toBe("K");
    expect(out.answer).toBe("جواب");
  });
  it("explains malformed model JSON instead of crashing", async () => {
    geminiStream.mockResolvedValue("{not json");
    await expect(askIdeas("x", lib, { key: "K" })).rejects.toThrow("غير مكتمل");
  });
  it("surfaces the server's error message", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: "حد الاستخدام" }) });
    await expect(askIdeas("x", lib)).rejects.toThrow("حد الاستخدام");
  });
  it("reports an unreachable server in Arabic", async () => {
    fetchMock.mockRejectedValue(new TypeError("fail"));
    await expect(askIdeas("x", lib)).rejects.toThrow("تعذّر الوصول");
  });
  it("refuses an empty library", async () => {
    await expect(askIdeas("x", [])).rejects.toThrow("لا توجد مقالات");
  });
});

describe("classifyBatch / getInsights / transcribeAudio", () => {
  it("classifyBatch returns server labels and is a no-op for no ideas", async () => {
    expect(await classifyBatch([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    replyModel([{ id: "g", topic: "الأمة والعالم", tags: ["غزة"] }]);
    expect((await classifyBatch(lib))["g"]!.tags).toEqual(["غزة"]);
  });
  it("classifyBatch sanitizes labels from the personal-key path", async () => {
    geminiStream.mockResolvedValue(
      JSON.stringify([
        { id: "g", topic: "موضوع مخترع", tags: ["#س"] },
        { id: "nope", topic: "x", tags: [] },
      ]),
    );
    const out = await classifyBatch(lib, { key: "K" });
    expect(Object.keys(out)).toEqual(["g"]);
    expect(out["g"]!.tags).toEqual(["س"]);
    expect(out["g"]!.topic).not.toBe("موضوع مخترع");
  });
  it("getInsights needs three articles and validates ids", async () => {
    await expect(getInsights(lib.slice(0, 2))).rejects.toThrow("ثلاثة");
    replyModel({
      themes: [{ name: "م", summary: "s", ids: ["g", "f", "ghost"] }],
      prompts: [{ title: "ت", angle: "ز" }],
    });
    expect((await getInsights(lib)).themes[0]!.ids).toEqual(["g", "f"]);
  });
  it("transcribeAudio uploads the audio file with a clean mime type to the voice route", async () => {
    fetchMock.mockResolvedValue(
      new Response('data: {"type":"transcript.text.done","text":" نص مفرَّغ "}\n\n', {
        status: 200,
      }),
    );
    const text = await transcribeAudio(new Blob(["abc"], { type: "audio/webm;codecs=opus" }));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/voice/transcribe");
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect((form.get("file") as File).type).toBe("audio/webm");
    expect(text).toBe("نص مفرَّغ");
  });
  it("transcribeAudio sends inline audio parts when a personal key is used", async () => {
    geminiStream.mockResolvedValue(" نص ");
    expect(await transcribeAudio(new Blob(["x"], { type: "audio/mp4" }), { key: "K" })).toBe("نص");
    expect(geminiStream.mock.calls[0]![2][0].inlineData.mimeType).toBe("audio/mp4");
  });
});

describe("getEvidence (end to end)", () => {
  const article = {
    title: "الأمانة",
    body: "الأمانة أساس العمران ومن ضيعها ضيع الأمة كلها وهذه دعوى المقال الأولى والأخيرة.",
  };
  const ayah = {
    data: {
      text: "إِنَّا عَرَضْنَا ٱلْأَمَانَةَ عَلَى ٱلسَّمَٰوَٰتِ وَٱلْأَرْضِ",
      numberInSurah: 72,
      surah: { number: 33, name: "سُورَةُ الأحزاب" },
    },
  };
  const route = (candidates: unknown) =>
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/articles/improve") return ndjson(JSON.stringify(candidates));
      if (url.includes("/33:72/")) return { ok: true, json: async () => ayah };
      throw new TypeError("offline");
    });
  const quran = {
    kind: "quran",
    surah: 33,
    from: 72,
    to: 72,
    opening: "إنا عرضنا الأمانة على السماوات",
    claim: "c",
    why: "w",
  };
  beforeEach(() => clearEvidenceCache());

  it("returns the SOURCE text for a correct reference", async () => {
    route([quran]);
    const { items } = await getEvidence(article);
    expect(items[0]!).toMatchObject({ kind: "quran", status: "verified" });
    expect((items[0]! as any).text).toContain("ٱلْأَمَانَةَ");
  });
  it("REGRESSION: a hallucinated reference never reaches the user, and the user is told why", async () => {
    route([{ ...quran, opening: "اقرأ باسم ربك الذي خلق" }]);
    await expect(getEvidence(article)).rejects.toThrow("أسقطنا الاقتراحات");
  });
  it("uses the personal key directly and still verifies against the source", async () => {
    geminiStream.mockResolvedValue(JSON.stringify([quran]));
    route([]);
    const { items } = await getEvidence(article, { key: "K" });
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/articles/improve")).toBe(false);
    expect(items[0]!.status).toBe("verified");
  });
  it("rejects a too-short article before any request", async () => {
    await expect(getEvidence({ title: "t", body: "قصير" })).rejects.toThrow("قصير");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("explains when the model found nothing suitable", async () => {
    route([]);
    await expect(getEvidence(article)).rejects.toThrow("لم يقترح");
  });
});

describe("getArticleEnrichment", () => {
  const art = {
    title: "المقال",
    body: "نص المقال الفكري الطويل عن الدولة والمجتمع والمنظومة الحضارية.",
  };
  const model = {
    additions: [" زاوية أولى ", 42, "زاوية ثانية"],
    quotes: [
      { quote: " «اقتباس» ", author: " مالك بن نبي ", context: " يخدم الفكرة " },
      { quote: "  ", author: "مجهول", context: "" },
      "junk",
    ],
    questions: [" سؤال كاشف؟ ", ""],
  };
  const expected = {
    additions: ["زاوية أولى", "زاوية ثانية"],
    quotes: [{ quote: "«اقتباس»", author: "مالك بن نبي", context: "يخدم الفكرة" }],
    questions: ["سؤال كاشف؟"],
  };

  it("uses the server route with the enrich task when no personal key is saved", async () => {
    replyModel(model);
    const out = await getArticleEnrichment(art);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/articles/improve");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.task).toBe("enrich");
    expect(body.payload).toContain(art.title);
    expect(body.payload).toContain(art.body);
    expect(out).toEqual(expected); // model output sanitized (bad entries dropped, strings trimmed)
  });

  it("uses the user's own Gemini key directly when provided, sanitizing the same way", async () => {
    geminiStream.mockResolvedValue(JSON.stringify(model));
    const out = await getArticleEnrichment(art, { key: "K" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(geminiStream.mock.calls[0]![0]).toBe("K");
    expect(out).toEqual(expected);
  });

  it("explains malformed model JSON instead of crashing", async () => {
    geminiStream.mockResolvedValue("{not json");
    await expect(getArticleEnrichment(art, { key: "K" })).rejects.toThrow("غير مكتمل");
  });

  it("refuses an empty article before any request (Afkari's backend guard)", async () => {
    await expect(getArticleEnrichment({ title: "t", body: "   " })).rejects.toThrow(
      "نص المقال مطلوب",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(geminiStream).not.toHaveBeenCalled();
  });

  it("refuses bodies over Afkari's 50k cap before any request", async () => {
    await expect(getArticleEnrichment({ title: "t", body: "ن".repeat(50_001) })).rejects.toThrow(
      "أطول من الحد",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(geminiStream).not.toHaveBeenCalled();
  });
});

describe("getFacebookPost", () => {
  const art = {
    title: "حصوات المرارة",
    body: "كثيرون يكتشفون حصوات المرارة مصادفة، ولا تعني كل حصوة عملية جراحية؛ القرار يبنى على الأعراض والتقييم الطبي.",
  };
  const clean =
    "هل كل حصوة مرارة تعني عملية؟\n\nغالبًا لا؛ القرار يبنى على الأعراض والتقييم الطبي.";

  it("uses the server route with the facebook task when no personal key is saved, and sanitizes the post", async () => {
    // Model wrapped the post in Arabic quotes and padded it with extra blank lines.
    replyModel({ post: `«${clean.replace("\n\n", "\n\n\n\n")}»` });
    const out = await getFacebookPost(art);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/articles/improve");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.task).toBe("facebook");
    expect(body.payload).toContain(art.title);
    expect(body.payload).toContain(art.body);
    expect(body.payload).not.toContain("المحاولة رقم");
    expect(out).toBe(clean); // wrapping quotes stripped, 3+ newlines collapsed to one blank line
  });

  it("uses the user's own Gemini key directly when provided, sanitizing the same way", async () => {
    geminiStream.mockResolvedValue(JSON.stringify({ post: `"${clean}"` }));
    const out = await getFacebookPost(art, { key: "K" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(geminiStream.mock.calls[0]![0]).toBe("K");
    expect(out).toBe(clean); // straight wrapping quotes stripped
  });

  it("strips markdown fences inside the post and hard-caps it at 1500 chars", async () => {
    geminiStream.mockResolvedValue(
      JSON.stringify({ post: "```\n" + "كلمة ".repeat(400) + "\n```" }),
    );
    const out = await getFacebookPost(art, { key: "K" });
    expect(out).not.toContain("```");
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.startsWith("كلمة")).toBe(true);
  });

  it("adds the variation instruction to the payload when regenerating", async () => {
    geminiStream.mockResolvedValue(JSON.stringify({ post: clean }));
    await getFacebookPost(art, { key: "K", variation: 2 });
    const payload = geminiStream.mock.calls[0]![2] as string;
    expect(payload).toContain("المحاولة رقم 3");
    expect(payload).toContain(art.body);
  });

  it("adds the variation instruction on the server path too", async () => {
    replyModel({ post: clean });
    await getFacebookPost(art, { variation: 1 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.payload).toContain("المحاولة رقم 2");
  });

  it("refuses an empty article before any request", async () => {
    await expect(getFacebookPost({ title: "t", body: "   " })).rejects.toThrow("نص المقال مطلوب");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(geminiStream).not.toHaveBeenCalled();
  });

  it("explains malformed model JSON instead of crashing", async () => {
    geminiStream.mockResolvedValue("{not json");
    await expect(getFacebookPost(art, { key: "K" })).rejects.toThrow("غير مكتمل");
  });

  it("rejects an empty suggested post with a retryable Arabic message", async () => {
    replyModel({ post: "   " });
    await expect(getFacebookPost(art)).rejects.toThrow("لم يقترح");
  });
});

describe("liked articles stay out of every AI corpus", () => {
  const likedX: Idea = {
    ...idea("x", "غزة بعيون أخرى", "غزة والمقاومة والاحتلال غزة غزة غزة", 9),
    liked: true,
    source: "موقع خارجي",
  };
  const mixed = [...lib, likedX];

  it("retrieveRelevant never returns a liked article, even on a perfect match", () => {
    const out = retrieveRelevant("غزة", mixed);
    expect(out.map((a) => a.id)).not.toContain("x");
    expect(out[0]!.id).toBe("g");
  });

  it("askIdeas builds its corpus without liked articles", async () => {
    replyModel({ answer: "إجابة", points: [], articleIds: ["g"] });
    const res = await askIdeas("ما رأيي في غزة؟", mixed);
    expect(res.used.map((a) => a.id)).not.toContain("x");
  });

  it("getInsights counts only the author's own articles toward the minimum", async () => {
    await expect(getInsights([lib[0]!, lib[1]!, likedX])).rejects.toThrow("ثلاثة");
  });

  it("classifyBatch sends no liked article to the model", async () => {
    expect(await classifyBatch([likedX], { key: "K" })).toEqual({});
    expect(geminiStream).not.toHaveBeenCalled();
    geminiStream.mockResolvedValue(
      JSON.stringify([
        { id: "g", topic: "الأمة والعالم", tags: [] },
        { id: "x", topic: "الأمة والعالم", tags: [] },
      ]),
    );
    const out = await classifyBatch(mixed, { key: "K" });
    expect(Object.keys(out)).not.toContain("x");
  });
});
