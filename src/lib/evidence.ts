import { HADITH_COLLECTIONS, sanitizeEvidence, type EvidenceCandidate } from "./ai-prompts";

/**
 * Verified evidence. The model only PROPOSES references; the text shown to the user is always fetched
 * from an authoritative source by that reference, and a reference whose real text does not match the
 * model's stated opening words is discarded. The model's own wording of a verse/hadith is never displayed.
 */
export type EvidenceItem =
  | {
      kind: "quran";
      status: "verified" | "unverified";
      ref: string;
      text: string;
      claim: string;
      why: string;
    }
  | {
      kind: "hadith";
      status: "verified" | "unverified";
      ref: string;
      text: string;
      grade: string;
      claim: string;
      why: string;
    }
  | {
      kind: "writing";
      status: "unverifiable";
      ref: string;
      idea: string;
      confidence: "high" | "medium";
      claim: string;
      why: string;
    };

export type EvidenceResult = { items: EvidenceItem[]; dropped: number };

// ---------- Arabic normalization & matching ----------
const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
export const normalizeAr = (s: string) =>
  s
    .replace(MARKS, "")
    .replace(/[ٱأإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Words in nearly every hadith/ayah; an opening made only of these proves nothing about WHICH text it is. */
const FORMULAIC = new Set([
  "قال",
  "قالت",
  "يقول",
  "رسول",
  "الله",
  "صلي",
  "عليه",
  "وسلم",
  "عن",
  "ان",
  "النبي",
  "رضي",
  "عنه",
  "عنها",
  "يا",
  "من",
  "ما",
  "في",
  "علي",
  "الي",
  "كان",
  "ثم",
  "انه",
  "لا",
  "الا",
]);

/**
 * Share of the opening's consecutive word pairs (that carry at least one distinctive word) found in the text.
 * 1 = verbatim, tolerant of small slips. An opening with fewer than 2 such pairs cannot be verified, so it scores 0.
 */
export function matchRatio(text: string, opening: string): number {
  const t = normalizeAr(text),
    words = normalizeAr(opening).split(" ").filter(Boolean);
  if (words.length < 2) return 0;
  const pairs = words
    .slice(1)
    .map((w, i) => [words[i]!, w] as const)
    .filter(([a, b]) => !(FORMULAIC.has(a) && FORMULAIC.has(b)));
  if (pairs.length < 2) return 0;
  if (t.includes(words.join(" "))) return 1;
  return pairs.filter(([a, b]) => t.includes(`${a} ${b}`)).length / pairs.length;
}
export const MATCH_THRESHOLD = 0.6;

const BASMALA = "بسم الله الرحمن الرحيم";
/** alquran.cloud prepends the basmala to ayah 1 of every surah except Al-Fatiha and At-Tawba. */
export function stripBasmala(text: string, surah: number, ayah: number): string {
  if (ayah !== 1 || surah === 1 || surah === 9) return text;
  const words = text.trim().split(/\s+/);
  return normalizeAr(words.slice(0, 4).join(" ")) === BASMALA ? words.slice(4).join(" ") : text;
}

// ---------- fetching ----------
type Fetch = typeof fetch;
const cache = new Map<string, Promise<unknown>>();
const TIMEOUT_MS = 8000;

/** Rejects when the caller's signal aborts, without cancelling the shared in-flight request. */
const abortable = <T>(p: Promise<T>, signal?: AbortSignal): Promise<T> =>
  !signal
    ? p
    : new Promise<T>((resolve, reject) => {
        if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
        p.then(resolve, reject);
      });

function getJSON(url: string, signal: AbortSignal | undefined, f: Fetch): Promise<unknown> {
  let p = cache.get(url);
  if (!p) {
    // Portable timeout (AbortSignal.timeout/any are missing on older Safari). Independent of any one caller.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    p = (async () => {
      const res = await f(url, { signal: controller.signal });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return res.json();
    })().finally(() => clearTimeout(timer));
    cache.set(url, p);
    p.catch(() => cache.delete(url)); // never cache failures
  }
  return abortable(p, signal);
}
export const clearEvidenceCache = () => cache.clear();

export async function fetchAyah(
  surah: number,
  ayah: number,
  signal?: AbortSignal,
  f: Fetch = fetch,
) {
  const json = await getJSON(
    `https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/quran-simple`,
    signal,
    f,
  );
  const d = (
    json as {
      data?: {
        text?: unknown;
        surah?: { number?: unknown; name?: unknown };
        numberInSurah?: unknown;
      };
    } | null
  )?.data;
  const ayahText = d?.text;
  const surahObj = d?.surah;
  if (typeof ayahText !== "string" || surahObj?.number !== surah || d?.numberInSurah !== ayah)
    throw new Error("bad ayah response");
  return {
    text: stripBasmala(ayahText, surah, ayah).trim(),
    surahName: String(surahObj?.name ?? "").replace(/^سُورَةُ\s*|^سورة\s*/, ""),
  };
}

/** The hadith-api serves either a single object or a `hadiths` array depending on the path; accept both. */
export function extractHadith(
  json: unknown,
  number: number,
): { text: string; grades: { name: string; grade: string }[] } | null {
  const root = (json ?? {}) as { hadiths?: unknown; text?: unknown; grades?: unknown };
  const h = (
    Array.isArray(root.hadiths)
      ? (root.hadiths.find(
          (x: { hadithnumber?: unknown } | null) => Number(x?.hadithnumber) === number,
        ) ?? root.hadiths[0])
      : root
  ) as { text?: unknown; grades?: unknown } | null | undefined;
  const text = h?.text;
  if (typeof text !== "string" || !text.trim()) return null;
  return {
    text: text.trim(),
    grades: Array.isArray(h?.grades)
      ? (h.grades.filter((g: { grade?: unknown } | null) => g?.grade) as {
          name: string;
          grade: string;
        }[])
      : [],
  };
}

export async function fetchHadith(
  collection: keyof typeof HADITH_COLLECTIONS,
  number: number,
  signal?: AbortSignal,
  f: Fetch = fetch,
) {
  const ed = HADITH_COLLECTIONS[collection].edition;
  const json = await getJSON(
    `https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/${ed}/${number}.json`,
    signal,
    f,
  );
  const h = extractHadith(json, number);
  if (!h) throw new Error("bad hadith response");
  return h;
}

const gradeLabel = (collection: string, grades: { name: string; grade: string }[]) =>
  grades.length
    ? grades.map((g) => `${g.grade} (${g.name})`).join(" · ")
    : collection === "bukhari" || collection === "muslim"
      ? "من الصحيحين"
      : "الدرجة غير متوفرة — راجع التخريج";

// ---------- verification ----------
export type Verdict = EvidenceItem | "dropped";

export async function verifyCandidate(
  c: EvidenceCandidate,
  signal?: AbortSignal,
  f: Fetch = fetch,
): Promise<Verdict> {
  if (c.kind === "writing") {
    return {
      kind: "writing",
      status: "unverifiable",
      ref: `${c.author} — ${c.work}`,
      idea: c.idea,
      confidence: c.confidence,
      claim: c.claim,
      why: c.why,
    };
  }
  try {
    if (c.kind === "quran") {
      const ayat = await Promise.all(
        Array.from({ length: c.to - c.from + 1 }, (_, i) =>
          fetchAyah(c.surah, c.from + i, signal, f),
        ),
      );
      const text = ayat.map((a) => a.text).join(" ");
      if (matchRatio(text, c.opening) < MATCH_THRESHOLD) return "dropped";
      const range = c.from === c.to ? `${c.from}` : `${c.from}-${c.to}`;
      return {
        kind: "quran",
        status: "verified",
        ref: `سورة ${ayat[0]!.surahName}، الآية ${range}`,
        text: `﴿${text}﴾`,
        claim: c.claim,
        why: c.why,
      };
    }
    const h = await fetchHadith(c.collection, c.number, signal, f);
    if (matchRatio(h.text, c.opening) < MATCH_THRESHOLD) return "dropped";
    return {
      kind: "hadith",
      status: "verified",
      ref: `${HADITH_COLLECTIONS[c.collection].name}، رقم ${c.number}`,
      text: h.text,
      grade: gradeLabel(c.collection, h.grades),
      claim: c.claim,
      why: c.why,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    // Source unreachable (offline, blocked, rate limited): keep the reference but show NO text and say so.
    const status = (error as { status?: number })?.status;
    if (status === 404) return "dropped"; // the reference does not exist in the source
    const ref =
      c.kind === "quran"
        ? `سورة رقم ${c.surah}، الآية ${c.from === c.to ? c.from : `${c.from}-${c.to}`}`
        : `${HADITH_COLLECTIONS[c.collection].name}، رقم ${c.number}`;
    return c.kind === "quran"
      ? { kind: "quran", status: "unverified", ref, text: "", claim: c.claim, why: c.why }
      : {
          kind: "hadith",
          status: "unverified",
          ref,
          text: "",
          grade: "",
          claim: c.claim,
          why: c.why,
        };
  }
}

const ORDER = { quran: 0, hadith: 1, writing: 2 } as const;

/** Verify all candidates in parallel; verified first, then by kind. */
export async function verifyAll(
  raw: unknown,
  signal?: AbortSignal,
  f: Fetch = fetch,
): Promise<EvidenceResult> {
  const candidates = sanitizeEvidence(raw);
  const verdicts = await Promise.all(candidates.map((c) => verifyCandidate(c, signal, f)));
  const items = verdicts.filter((v): v is EvidenceItem => v !== "dropped");
  items.sort(
    (a, b) =>
      (a.status === "unverified" ? 1 : 0) - (b.status === "unverified" ? 1 : 0) ||
      ORDER[a.kind] - ORDER[b.kind],
  );
  return { items, dropped: verdicts.length - items.length };
}
