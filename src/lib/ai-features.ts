import {
  ASK_SCHEMA, CLASSIFY_SCHEMA, EVIDENCE_SCHEMA, INSIGHTS_SCHEMA, TRANSCRIBE_INSTRUCTIONS,
  sanitizeAsk, sanitizeInsights, sanitizeLabels,
  type AiTask, type AskAnswer, type AskArticle, type ClassifyItem, type InsightItem, type Insights, type Label,
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
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(clean); } catch { throw new Error("جاء رد الذكاء الاصطناعي غير مكتمل. حاول مرة أخرى."); }
};

/** Run one JSON task (ask / classify / insights / evidence) on the resolved engine. */
async function runTask(task: AiTask, payload: string, schema: object, o: AIOptions): Promise<unknown> {
  const engine = await engineOf(o);
  try {
    return parseJSON(await runAi(engine, task, payload, signalOf(o), () => {}, schema));
  } catch (error) {
    // A raw TypeError here is a failed fetch to the app server (offline / unreachable).
    if (error instanceof TypeError) throw new Error("تعذّر الوصول إلى الخادم. تأكد من الإنترنت وحاول مرة أخرى.");
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
    const text = await geminiStream(engine.key, TRANSCRIBE_INSTRUCTIONS, [{ inlineData: { mimeType, data } }, { text: "فرّغ هذا التسجيل." }], signalOf(o));
    return text.trim();
  }
  const { transcribeAudio: transcribeWithEngine } = await import("./transcribe");
  return transcribeWithEngine(blob, mimeType, engine, signalOf(o));
}

// ---------- ask my ideas ----------
const norm = (s: string) => strip(s).toLocaleLowerCase().replace(/ة/g, "ه").replace(/ى/g, "ي");

const tokens = (q: string) =>
  [...new Set(norm(q).split(/[^\p{L}\p{N}]+/u).map((w) => w.replace(/^(ال|و|ف|ب|ل)/, "")).filter((w) => w.length > 2))];

/** Most relevant paragraphs of an article for the question, capped so the request stays small. */
export function excerptFor(body: string, toks: string[], max: number): string {
  const paras = body.split(/\n\s*\n/).filter(Boolean);
  const scored = paras.map((p, i) => ({ p, i, s: toks.filter((t) => norm(p).includes(t)).length }));
  const picked: typeof scored = [];
  let used = 0;
  for (const c of [...scored].sort((a, b) => b.s - a.s || a.i - b.i)) {
    if (picked.length && used + c.p.length > max) continue;
    picked.push(c); used += c.p.length;
    if (used >= max) break;
  }
  return picked.sort((a, b) => a.i - b.i).map((c) => c.p).join("\n\n").slice(0, max);
}

/** Keyword retrieval over the local library: title hits weigh most. Falls back to the newest articles. */
export function retrieveRelevant(question: string, ideas: Idea[], k = 8, maxChars = 1800): AskArticle[] {
  const toks = tokens(question);
  const scored = ideas.map((idea) => {
    const a = getArticle(idea);
    const title = norm(a.title), body = norm(a.body);
    const s = toks.reduce((n, t) => n + (title.includes(t) ? 3 : 0) + Math.min(5, body.split(t).length - 1), 0);
    return { idea, a, s };
  });
  const ranked = scored.filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
  const top = (ranked.length ? ranked : scored.sort((x, y) => y.idea.createdAt - x.idea.createdAt)).slice(0, k);
  return top.map(({ idea, a }) => ({ id: idea.id, title: a.title, excerpt: excerptFor(a.body, toks, maxChars) }));
}

export async function askIdeas(question: string, ideas: Idea[], o: AIOptions = {}): Promise<AskAnswer & { used: AskArticle[] }> {
  const used = retrieveRelevant(question, ideas);
  if (!used.length) throw new Error("لا توجد مقالات للبحث فيها بعد.");
  const known = new Set(used.map((a) => a.id));
  const raw = await runTask("ask", `السؤال: ${question}\n\nالمقالات:\n${JSON.stringify(used)}`, ASK_SCHEMA, o);
  return { ...sanitizeAsk(raw, known), used };
}

// ---------- topics & tags ----------
export async function classifyBatch(ideas: Idea[], o: AIOptions = {}): Promise<Record<string, Label>> {
  if (!ideas.length) return {};
  const items: ClassifyItem[] = ideas.map((idea) => {
    const a = getArticle(idea);
    return { id: idea.id, title: a.title, excerpt: a.body.slice(0, 500) };
  });
  const fallback = (id: string) => classify(ideas.find((i) => i.id === id)?.text ?? "");
  const raw = await runTask("classify", JSON.stringify(items), CLASSIFY_SCHEMA, o);
  return sanitizeLabels(raw, items.map((i) => i.id), fallback);
}

// ---------- insights ----------
export async function getInsights(ideas: Idea[], o: AIOptions = {}): Promise<Insights> {
  if (ideas.length < 3) throw new Error("تلزم ثلاثة مقالات على الأقل لاستخراج الرؤى.");
  const items: InsightItem[] = ideas.slice(0, 120).map((idea) => {
    const a = getArticle(idea);
    return { id: idea.id, title: a.title, excerpt: a.body.slice(0, 500) };
  });
  const raw = await runTask("insights", JSON.stringify(items), INSIGHTS_SCHEMA, o);
  return sanitizeInsights(raw, items.map((i) => i.id));
}

// ---------- evidence from Quran, Sunnah and other writings ----------
/** The model proposes references; every Quran/hadith text shown is fetched from a source and checked against them. */
export async function getEvidence(article: { title: string; body: string }, o: AIOptions = {}): Promise<EvidenceResult> {
  if (article.body.trim().length < 40) throw new Error("المقال قصير جدًا لاقتراح شواهد له.");
  const raw = await runTask("evidence", `عنوان المقال: ${article.title}\n\nنص المقال:\n${article.body.slice(0, 12000)}`, EVIDENCE_SCHEMA, o);
  const result = await verifyAll(raw, o.signal);
  if (!result.items.length) {
    throw new Error(result.dropped
      ? "لم نجد شاهدًا يتطابق مع نصوص المصادر الموثوقة، فأسقطنا الاقتراحات احتياطًا. جرّب مقالًا أطول أو أعد المحاولة."
      : "لم يقترح الذكاء الاصطناعي شواهد مناسبة لهذا المقال.");
  }
  return result;
}
