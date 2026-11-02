import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeEvidence } from "./ai-prompts";
import { clearEvidenceCache, extractHadith, fetchAyah, matchRatio, normalizeAr, stripBasmala, verifyAll, verifyCandidate } from "./evidence";

beforeEach(() => clearEvidenceCache());

const ayahJson = (surah: number, n: number, text: string, name = "سُورَةُ البَقَرَةِ") =>
  ({ data: { text, numberInSurah: n, surah: { number: surah, name } } });
const hadithJson = (n: number, text: string, grades: unknown[] = []) => ({ hadiths: [{ hadithnumber: n, text, grades }] });

const mockFetch = (routes: Record<string, unknown | number>) =>
  vi.fn(async (url: string) => {
    for (const [frag, v] of Object.entries(routes)) {
      if (url.includes(frag)) return typeof v === "number" ? { ok: false, status: v, json: async () => ({}) } : { ok: true, status: 200, json: async () => v };
    }
    throw new TypeError("network down");
  }) as unknown as typeof fetch;

describe("normalizeAr / matchRatio", () => {
  it("ignores diacritics, Quranic marks, alef/ya/ta-marbuta variants", () => {
    expect(normalizeAr("ٱللَّهُ لَآ إِلَٰهَ")).toBe(normalizeAr("الله لا اله"));
    expect(normalizeAr("رَحْمَةً")).toBe(normalizeAr("رحمه"));
  });
  it("is 1 for a verbatim opening, tolerant of small slips, 0 for unrelated text", () => {
    const text = "إنما الأعمال بالنيات وإنما لكل امرئ ما نوى";
    expect(matchRatio(text, "إنما الأعمال بالنيات")).toBe(1);
    expect(matchRatio(text, "إنما الأعمال بالنيات وإنما لكل امرئ ما قصد")).toBeGreaterThanOrEqual(0.6);
    expect(matchRatio(text, "الراحمون يرحمهم الرحمن")).toBe(0);
    expect(matchRatio(text, "كلمة")).toBe(0);
  });
});

describe("matchRatio: formulaic openings prove nothing", () => {
  const text = "عن عمر قال سمعت رسول الله صلى الله عليه وسلم يقول إنما الأعمال بالنيات";
  it("REGRESSION: a boilerplate opening scores 0 even when it appears verbatim", () => {
    expect(matchRatio(text, "قال رسول الله صلى الله عليه وسلم")).toBe(0);
    expect(matchRatio(text, "عن النبي صلى الله عليه وسلم")).toBe(0);
  });
  it("a distinctive opening still verifies", () => {
    expect(matchRatio(text, "يقول إنما الأعمال بالنيات")).toBe(1);
  });
});

describe("stripBasmala", () => {
  const withBasmala = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ الم";
  it("removes the basmala the API prepends to ayah 1", () => expect(stripBasmala(withBasmala, 2, 1)).toBe("الم"));
  it("keeps Al-Fatiha ayah 1 (it IS the basmala) and At-Tawba, and other ayat", () => {
    expect(stripBasmala(withBasmala, 1, 1)).toBe(withBasmala);
    expect(stripBasmala(withBasmala, 9, 1)).toBe(withBasmala);
    expect(stripBasmala("ذلك الكتاب", 2, 2)).toBe("ذلك الكتاب");
  });
});

describe("fetchAyah", () => {
  it("rejects a response for a different ayah than requested", async () => {
    const f = mockFetch({ "/2:255/": ayahJson(2, 254, "x") });
    await expect(fetchAyah(2, 255, undefined, f)).rejects.toThrow();
  });
  it("de-duplicates concurrent identical requests and caches successes", async () => {
    const f = mockFetch({ "/2:255/": ayahJson(2, 255, "اللَّهُ لَا إِلَهَ إِلَّا هُوَ") });
    await Promise.all([fetchAyah(2, 255, undefined, f), fetchAyah(2, 255, undefined, f)]);
    await fetchAyah(2, 255, undefined, f);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("extractHadith", () => {
  it("accepts both the array shape and the single-object shape", () => {
    expect(extractHadith(hadithJson(7, "نص"), 7)?.text).toBe("نص");
    expect(extractHadith({ hadithnumber: 7, text: "نص", grades: [] }, 7)?.text).toBe("نص");
  });
  it("returns null for junk", () => {
    expect(extractHadith({}, 1)).toBeNull();
    expect(extractHadith({ hadiths: [{ text: "  " }] }, 1)).toBeNull();
  });
});

describe("sanitizeEvidence", () => {
  const good = { kind: "quran", surah: 2, from: 255, to: 255, opening: "الله لا إله إلا هو", claim: "c", why: "w" };
  it("drops structurally impossible references before any network call", () => {
    const out = sanitizeEvidence([
      good,
      { ...good, surah: 115 }, { ...good, from: 0 }, { ...good, to: 300 }, { ...good, opening: "كلمة" },
      { kind: "hadith", collection: "fakebook", number: 1, opening: "إنما الأعمال بالنيات", claim: "", why: "" },
      { kind: "hadith", collection: "bukhari", number: 0, opening: "إنما الأعمال بالنيات", claim: "", why: "" },
      { kind: "writing", author: "ابن خلدون", work: "المقدمة", idea: "فكرة", confidence: "low", claim: "", why: "" },
      { kind: "writing", author: "", work: "المقدمة", idea: "فكرة", confidence: "high", claim: "", why: "" },
      { kind: "unknown" }, null,
    ]);
    expect(out).toHaveLength(1);
  });
  it("accepts all three kinds, dedupes, and caps at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...good, from: i + 1, to: i + 1 }));
    expect(sanitizeEvidence(many)).toHaveLength(8);
    expect(sanitizeEvidence([good, good])).toHaveLength(1);
    expect(sanitizeEvidence([{ kind: "writing", author: "المسيري", work: "العلمانية الجزئية والعلمانية الشاملة", idea: "ف", confidence: "high", claim: "", why: "" }])).toHaveLength(1);
  });
});

describe("verifyCandidate", () => {
  const quran = { kind: "quran" as const, surah: 2, from: 255, to: 255, opening: "الله لا إله إلا هو الحي القيوم", claim: "c", why: "w" };
  const hadith = { kind: "hadith" as const, collection: "bukhari" as const, number: 1, opening: "إنما الأعمال بالنيات", claim: "c", why: "w" };

  it("verified Quran: shows the SOURCE text, not the model's, with a proper reference", async () => {
    const f = mockFetch({ "/2:255/": ayahJson(2, 255, "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ") });
    const v = await verifyCandidate(quran, undefined, f);
    expect(v).toMatchObject({ kind: "quran", status: "verified", ref: "البَقَرَةِ".length ? expect.stringContaining("الآية 255") : "" });
    expect((v as any).text.startsWith("﴿")).toBe(true);
    expect((v as any).text).toContain("ٱلْقَيُّومُ");
  });
  it("REGRESSION: a wrong reference (text does not match the claimed opening) is dropped, not shown", async () => {
    const f = mockFetch({ "/2:255/": ayahJson(2, 255, "ذلك الكتاب لا ريب فيه هدى للمتقين") });
    expect(await verifyCandidate(quran, undefined, f)).toBe("dropped");
  });
  it("verified hadith with the source's grade, matching despite the isnad before the matn", async () => {
    const f = mockFetch({ "/ara-bukhari/1.json": hadithJson(1, "حدثنا الحميدي قال حدثنا سفيان عن عمر قال سمعت رسول الله يقول إنما الأعمال بالنيات", [{ name: "Al-Albani", grade: "Sahih" }]) });
    const v = await verifyCandidate(hadith, undefined, f) as any;
    expect(v).toMatchObject({ kind: "hadith", status: "verified", grade: "Sahih (Al-Albani)" });
    expect(v.ref).toContain("صحيح البخاري");
  });
  it("labels Bukhari/Muslim without per-hadith grades as من الصحيحين, others as needing takhrij", async () => {
    const f = mockFetch({ "/ara-bukhari/1.json": hadithJson(1, "إنما الأعمال بالنيات"), "/ara-tirmidhi/1.json": hadithJson(1, "إنما الأعمال بالنيات") });
    expect(((await verifyCandidate(hadith, undefined, f)) as any).grade).toBe("من الصحيحين");
    expect(((await verifyCandidate({ ...hadith, collection: "tirmidhi" }, undefined, f)) as any).grade).toContain("راجع التخريج");
  });
  it("REGRESSION: a hadith number that resolves to a different hadith is dropped", async () => {
    const f = mockFetch({ "/ara-bukhari/1.json": hadithJson(1, "كان رسول الله يحب التيمن في تنعله وترجله") });
    expect(await verifyCandidate(hadith, undefined, f)).toBe("dropped");
  });
  it("a reference that does not exist at the source (404) is dropped", async () => {
    expect(await verifyCandidate(quran, undefined, mockFetch({ "/2:255/": 404 }))).toBe("dropped");
  });
  it("source unreachable: keeps the reference, shows NO text, marks unverified", async () => {
    const v = await verifyCandidate(quran, undefined, mockFetch({})) as any;
    expect(v).toMatchObject({ kind: "quran", status: "unverified", text: "" });
  });
  it("multi-ayah ranges are fetched in parallel and joined", async () => {
    const f = mockFetch({ "/2:1/": ayahJson(2, 1, "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ الم"), "/2:2/": ayahJson(2, 2, "ذلك الكتاب لا ريب فيه") });
    const v = await verifyCandidate({ ...quran, from: 1, to: 2, opening: "ذلك الكتاب لا ريب" }, undefined, f) as any;
    expect(v.text).toBe("﴿الم ذلك الكتاب لا ريب فيه﴾");
    expect(v.ref).toContain("1-2");
  });
  it("other writings are never presented as verified", async () => {
    const v = await verifyCandidate({ kind: "writing", author: "ابن خلدون", work: "المقدمة", idea: "العمران", claim: "c", why: "w", confidence: "high" });
    expect(v).toMatchObject({ kind: "writing", status: "unverifiable" });
  });
  it("propagates user aborts instead of mislabeling them as unverified", async () => {
    const c = new AbortController(); c.abort();
    await expect(verifyCandidate(quran, c.signal, mockFetch({ "/2:255/": ayahJson(2, 255, "x") }))).rejects.toThrow();
  });
});

describe("verifyAll", () => {
  it("sorts verified Quran first, counts dropped, and puts unverified last", async () => {
    const f = mockFetch({
      "/2:255/": ayahJson(2, 255, "الله لا إله إلا هو الحي القيوم"),
      "/ara-bukhari/1.json": hadithJson(1, "كلام آخر تماما لا علاقة له"),
      "/ara-muslim/9.json": 500,
    });
    const raw = [
      { kind: "writing", author: "المسيري", work: "كتاب", idea: "فكرة", confidence: "medium", claim: "", why: "" },
      { kind: "hadith", collection: "bukhari", number: 1, opening: "إنما الأعمال بالنيات", claim: "", why: "" },
      { kind: "hadith", collection: "muslim", number: 9, opening: "من رأى منكم منكرا فليغيره", claim: "", why: "" },
      { kind: "quran", surah: 2, from: 255, to: 255, opening: "الله لا إله إلا هو الحي", claim: "", why: "" },
    ];
    const { items, dropped } = await verifyAll(raw, undefined, f);
    expect(dropped).toBe(1);
    expect(items.map((i) => `${i.kind}:${i.status}`)).toEqual(["quran:verified", "writing:unverifiable", "hadith:unverified"]);
  });
});
