import {
  ASK_SCHEMA,
  CLASSIFY_SCHEMA,
  ENRICH_SCHEMA,
  EVIDENCE_SCHEMA,
  FACEBOOK_SCHEMA,
  INSIGHTS_SCHEMA,
  TRANSCRIBE_INSTRUCTIONS,
  sanitizeAdditions,
  sanitizeAsk,
  sanitizeFacebookPost,
  sanitizeInsights,
  sanitizeLabels,
  type AiTask,
  type ArticleAdditions,
  type AskAnswer,
  type AskArticle,
  type ClassifyItem,
  type InsightItem,
  type Insights,
  type Label,
} from "./ai-prompts";
import { verifyAll, type EvidenceResult } from "./evidence";
import { geminiStream, getGeminiKey } from "./gemini";
import { runAi, type Engine } from "./article-ai";
// Thought Loom adaptation: Afkari's ideas.ts re-exported the topics.ts classifier; here the
// offline classifier and text stripper come from topics.ts directly, storage from ideas.ts.
import { classify, strip } from "./topics";
import { getArticle, type Idea } from "./ideas";

/**
 * Ported from Afkari's ai-features. The feature logic (retrieval, sanitizers, evidence
 * verification) is unchanged; only the transport differs. Afkari posted to its Express
 * `/api/gemini/*` endpoints when no personal key was saved. Thought Loom has no such
 * endpoints: every task goes through the app's existing engine dispatch (`runAi`) —
 * the user's own Gemini key in the browser, otherwise the authenticated
 * `/api/articles/improve` server route (Lovable AI gateway) with the task's instructions
 * selected server-side from TASK_INSTRUCTIONS. Model JSON is sanitized on the client on
 * both paths (Afkari's server pre-sanitized classify results; the sanitizers are pure,
 * so running them here keeps one behavior for both engines).
 */
export type AIOptions = { key?: string; signal?: AbortSignal; engine?: Engine };
const signalOf = (o: AIOptions) => o.signal ?? new AbortController().signal;

async function engineOf(o: AIOptions): Promise<Engine> {
  if (o.engine) return o.engine;
  const key = o.key ?? getGeminiKey();
  if (key) return { kind: "gemini", key };
  const { resolveEngine } = await import("./ai-engine");
  const engine = await resolveEngine();
  if (typeof engine === "string") throw new Error(engine);
  return engine;
}

const parseJSON = (text: string) => {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error("جاء رد الذكاء الاصطناعي غير مكتمل. حاول مرة أخرى.");
  }
};

/** Run one JSON task (ask / classify / insights / evidence) on the resolved engine. */
async function runTask(
  task: AiTask,
  payload: string,
  schema: object,
  o: AIOptions,
): Promise<unknown> {
  const engine = await engineOf(o);
  try {
    return parseJSON(await runAi(engine, task, payload, signalOf(o), () => {}, schema));
  } catch (error) {
    // A raw TypeError here is a failed fetch to the app server (offline / unreachable).
    if (error instanceof TypeError)
      throw new Error("تعذّر الوصول إلى الخادم. تأكد من الإنترنت وحاول مرة أخرى.");
    throw error;
  }
}

// ---------- transcription ----------
export const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذّرت قراءة التسجيل."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });

/** Transcribe one audio blob: the personal-key path calls Gemini directly (as in Afkari,
 *  reading the blob via FileReader); the cloud path delegates to Thought Loom's
 *  transcription pipeline and its /api/voice/transcribe route. */
export async function transcribeAudio(blob: Blob, o: AIOptions = {}): Promise<string> {
  const mimeType = (blob.type || "audio/webm").split(";")[0] ?? "audio/webm";
  const engine = await engineOf(o);
  if (engine.kind === "gemini") {
    const data = await blobToBase64(blob);
    const text = await geminiStream(
      engine.key,
      TRANSCRIBE_INSTRUCTIONS,
      [{ inlineData: { mimeType, data } }, { text: "فرّغ هذا التسجيل." }],
      signalOf(o),
    );
    return text.trim();
  }
  const { transcribeAudio: transcribeWithEngine } = await import("./transcribe");
  return transcribeWithEngine(blob, mimeType, engine, signalOf(o));
}

// ---------- ask my ideas ----------
const norm = (s: string) => strip(s).toLocaleLowerCase().replace(/ة/g, "ه").replace(/ى/g, "ي");

const tokens = (q: string) => [
  ...new Set(
    norm(q)
      .split(/[^\p{L}\p{N}]+/u)
      .map((w) => w.replace(/^(ال|و|ف|ب|ل)/, ""))
      .filter((w) => w.length > 2),
  ),
];

/** Most relevant paragraphs of an article for the question, capped so the request stays small. */
export function excerptFor(body: string, toks: string[], max: number): string {
  const paras = body.split(/\n\s*\n/).filter(Boolean);
  const scored = paras.map((p, i) => ({ p, i, s: toks.filter((t) => norm(p).includes(t)).length }));
  const picked: typeof scored = [];
  let used = 0;
  for (const c of [...scored].sort((a, b) => b.s - a.s || a.i - b.i)) {
    if (picked.length && used + c.p.length > max) continue;
    picked.push(c);
    used += c.p.length;
    if (used >= max) break;
  }
  return picked
    .sort((a, b) => a.i - b.i)
    .map((c) => c.p)
    .join("\n\n")
    .slice(0, max);
}

/** Keyword retrieval over the local library: title hits weigh most. Falls back to the newest articles.
 *  Liked articles are other people's writing: they are never part of the ask corpus. */
export function retrieveRelevant(
  question: string,
  ideas: Idea[],
  k = 8,
  maxChars = 1800,
): AskArticle[] {
  const own = ideas.filter((i) => !i.liked);
  const toks = tokens(question);
  const scored = own.map((idea) => {
    const a = getArticle(idea);
    const title = norm(a.title),
      body = norm(a.body);
    const s = toks.reduce(
      (n, t) => n + (title.includes(t) ? 3 : 0) + Math.min(5, body.split(t).length - 1),
      0,
    );
    return { idea, a, s };
  });
  const ranked = scored.filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
  const top = (
    ranked.length ? ranked : scored.sort((x, y) => y.idea.createdAt - x.idea.createdAt)
  ).slice(0, k);
  return top.map(({ idea, a }) => ({
    id: idea.id,
    title: a.title,
    excerpt: excerptFor(a.body, toks, maxChars),
  }));
}

export async function askIdeas(
  question: string,
  ideas: Idea[],
  o: AIOptions = {},
): Promise<AskAnswer & { used: AskArticle[] }> {
  const used = retrieveRelevant(question, ideas);
  if (!used.length) throw new Error("لا توجد مقالات للبحث فيها بعد.");
  const known = new Set(used.map((a) => a.id));
  const raw = await runTask(
    "ask",
    `السؤال: ${question}\n\nالمقالات:\n${JSON.stringify(used)}`,
    ASK_SCHEMA,
    o,
  );
  return { ...sanitizeAsk(raw, known), used };
}

// ---------- topics & tags ----------
export async function classifyBatch(
  ideas: Idea[],
  o: AIOptions = {},
): Promise<Record<string, Label>> {
  // Defense in depth (labelAll already skips them): liked articles are never classified.
  const own = ideas.filter((i) => !i.liked);
  if (!own.length) return {};
  const items: ClassifyItem[] = own.map((idea) => {
    const a = getArticle(idea);
    return { id: idea.id, title: a.title, excerpt: a.body.slice(0, 500) };
  });
  const fallback = (id: string) => classify(own.find((i) => i.id === id)?.text ?? "");
  const raw = await runTask("classify", JSON.stringify(items), CLASSIFY_SCHEMA, o);
  return sanitizeLabels(
    raw,
    items.map((i) => i.id),
    fallback,
  );
}

// ---------- insights ----------
export async function getInsights(ideas: Idea[], o: AIOptions = {}): Promise<Insights> {
  // Insights describe the author's own body of work; liked articles never enter the corpus.
  const own = ideas.filter((i) => !i.liked);
  if (own.length < 3) throw new Error("تلزم ثلاثة مقالات على الأقل لاستخراج الرؤى.");
  const items: InsightItem[] = own.slice(0, 120).map((idea) => {
    const a = getArticle(idea);
    return { id: idea.id, title: a.title, excerpt: a.body.slice(0, 500) };
  });
  const raw = await runTask("insights", JSON.stringify(items), INSIGHTS_SCHEMA, o);
  return sanitizeInsights(
    raw,
    items.map((i) => i.id),
  );
}

// ---------- article enrichment (additions, quotes, questions) ----------
export type ArticleEnrichment = ArticleAdditions;

/**
 * Ported from Afkari's getArticleEnrichment. Afkari posted the article to its Express
 * `/api/gemini/suggest-additions` endpoint, which prompted Gemini with the additions
 * instructions + schema and returned sanitizeAdditions output. Here the same prompt is
 * built client-side and dispatched through the app engine like the other ported
 * features (personal key in-browser, else the authenticated server route, whose
 * TASK_INSTRUCTIONS now carries those same instructions as the `enrich` task); the
 * result is sanitized with the same sanitizeAdditions. Afkari's backend guards are
 * kept: an empty body is refused, and bodies over its 50,000-character cap are
 * refused with its message instead of being sent (the server route's own payload
 * cap is looser, so the cap is enforced here to keep the same request size).
 * NOTE: quotes returned here are model-suggested and NOT source-verified — the
 * editor labels them «غير موثّق»; verified text is only the Evidence path below.
 */
export async function getArticleEnrichment(
  article: { title: string; body: string },
  o: AIOptions = {},
): Promise<ArticleEnrichment> {
  if (!article.body.trim()) throw new Error("نص المقال مطلوب");
  if (article.body.length > 50_000) throw new Error("المقال أطول من الحد المسموح");
  const payload = `بناءً على المقال التالي للكاتب، اقترح إضافات فكرية واقتباسات ملهمة لتعميق المقال:\nالعنوان: ${article.title.slice(0, 200)}\n\nالنص:\n${article.body}`;
  const raw = await runTask("enrich", payload, ENRICH_SCHEMA, o);
  return sanitizeAdditions(raw);
}

// ---------- facebook post suggestion ----------
export type FacebookOptions = AIOptions & {
  /** 0 = first suggestion; >0 = a regeneration attempt whose opening/angle must differ. */
  variation?: number;
};

/**
 * One Facebook post suggested from the article, in the author's own published voice
 * (FACEBOOK_INSTRUCTIONS carries the rules from his real posts). Dispatched like the
 * other features (personal key in-browser, else the authenticated server route with
 * the `facebook` task) and sanitized client-side. Copy-only by design: the app never
 * posts to Facebook — the author pastes the text himself. Regeneration passes a
 * variation number so the prompt demands a different opening and angle.
 */
export async function getFacebookPost(
  article: { title: string; body: string },
  o: FacebookOptions = {},
): Promise<string> {
  if (!article.body.trim()) throw new Error("نص المقال مطلوب");
  const variation = o.variation ?? 0;
  let payload = `حوّل المقال التالي للكاتب إلى منشور فيسبوك واحد قصير بصوته:\nالعنوان: ${article.title.slice(0, 200)}\n\nالنص:\n${article.body}`;
  if (variation > 0) {
    payload += `\n\nتنبيه: هذه المحاولة رقم ${variation + 1} لصياغة المنشور. غيّر جملة الافتتاح وزاوية العرض تغييرًا واضحًا عن أي صياغة مباشرة، ولا تبدأ بتلخيص للمقال؛ اختر مدخلًا مختلفًا من داخل أفكاره.`;
  }
  const raw = await runTask("facebook", payload, FACEBOOK_SCHEMA, o);
  const post = sanitizeFacebookPost(raw);
  if (!post) throw new Error("لم يقترح الذكاء الاصطناعي منشورًا لهذا المقال. حاول مرة أخرى.");
  return post;
}

// ---------- evidence from Quran, Sunnah and other writings ----------
/** The model proposes references; every Quran/hadith text shown is fetched from a source and checked against them. */
export async function getEvidence(
  article: { title: string; body: string },
  o: AIOptions = {},
): Promise<EvidenceResult> {
  if (article.body.trim().length < 40) throw new Error("المقال قصير جدًا لاقتراح شواهد له.");
  const raw = await runTask(
    "evidence",
    `عنوان المقال: ${article.title}\n\nنص المقال:\n${article.body.slice(0, 12000)}`,
    EVIDENCE_SCHEMA,
    o,
  );
  const result = await verifyAll(raw, o.signal);
  if (!result.items.length) {
    throw new Error(
      result.dropped
        ? "لم نجد شاهدًا يتطابق مع نصوص المصادر الموثوقة، فأسقطنا الاقتراحات احتياطًا. جرّب مقالًا أطول أو أعد المحاولة."
        : "لم يقترح الذكاء الاصطناعي شواهد مناسبة لهذا المقال.",
    );
  }
  return result;
}
