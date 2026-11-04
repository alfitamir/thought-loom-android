import { TASK_INSTRUCTIONS, type AiTask } from "./ai-prompts";

export function parseImprovedArticle(text: string): { title: string; body: string } {
  const lines = text.trim().split("\n");
  const title = (lines.shift() ?? "").replace(/^#+\s*/, "").trim();
  const body = lines.join("\n").trim();
  if (!title || !body) throw new Error("لم تصل نسخة مكتملة من المقال. لم يتغير مقالك الأصلي.");
  return { title, body };
}

export async function readArticleStream(response: Response, onText: (text: string) => void): Promise<string> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? "تعذّر تحسين المقال الآن.");
  }
  if (!response.body) throw new Error("لم تصل نسخة من المقال.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", output = "", completed = false;
  const processLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "text") { output += event.text; onText(output); }
    if (event.type === "done") completed = true;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(processLine);
    }
    buffer += decoder.decode();
    processLine(buffer);
    if (!completed) throw new Error("انقطع الاتصال قبل اكتمال التحسين. مقالك محفوظ كما هو.");
    return output;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const words = (s: string) => s.replace(/[\u064B-\u0652]/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

/** Reject AI output that dropped content: too short, or missing the source's final sentence. */
export function isComplete(source: string, output: string): boolean {
  const src = words(source), out = words(output);
  if (out.length < src.length * 0.85) return false;
  const tail = src.slice(-6).filter((w) => w.length > 2);
  if (!tail.length) return true;
  const outSet = new Set(out.map((w) => w.replace(/^(ال|و|ف|ب)/, "")));
  const hits = tail.filter((w) => outSet.has(w.replace(/^(ال|و|ف|ب)/, ""))).length;
  return hits >= Math.ceil(tail.length / 2);
}

/** Split long bodies on paragraph boundaries so each AI call stays small and complete. */
export function splitChunks(body: string, maxWords = 1500): string[] {
  const chunks: string[] = []; let cur: string[] = []; let n = 0;
  for (const p of body.split(/\n\s*\n/)) {
    const c = p.split(/\s+/).length;
    if (cur.length && n + c > maxWords) { chunks.push(cur.join("\n\n")); cur = []; n = 0; }
    cur.push(p); n += c;
  }
  if (cur.length) chunks.push(cur.join("\n\n"));
  return chunks;
}

export const INCOMPLETE = "النسخة المقترحة ناقصة، لم نغير مقالك.";

/**
 * Thrown when an AI merge proposal dropped source content. Carries the parsed
 * proposal and the exact source units that are missing from it, so the UI can
 * show the owner precisely what would be lost and let HIM decide — the merge
 * is never applied silently in this state.
 */
export class MergeIncompleteError extends Error {
  proposal: { title: string; body: string };
  missing: string[];
  constructor(proposal: { title: string; body: string }, missing: string[]) {
    super(INCOMPLETE);
    this.name = "MergeIncompleteError";
    this.proposal = proposal;
    this.missing = missing;
  }
}

/**
 * Normalize text for COMPARISON ONLY (never for storage): unify Arabic letter
 * variants (hamza forms, ة/ه, ى/ي, ؤ/و, ئ/ي), drop diacritics and tatweel,
 * strip markdown markers, and turn punctuation into spaces — so a line that
 * survives with light rewording or different spelling conventions still
 * counts as present, while a genuinely absent line still fails.
 */
export const normalizeForCompare = (s: string): string => s
  .replace(/[\u064B-\u065F\u0670]/g, "")
  .replace(/\u0640/g, "")
  .replace(/[أإآٱ]/g, "ا")
  .replace(/ة/g, "ه")
  .replace(/ى/g, "ي")
  .replace(/ؤ/g, "و")
  .replace(/ئ/g, "ي")
  .replace(/ء/g, "")
  .replace(/[*_#`>]/g, " ")
  .replace(/[^\p{L}\p{N}\s]+/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const compareTokens = (s: string): string[] => normalizeForCompare(s).split(" ").filter((w) => w.length > 1);

/**
 * Split a body into the units the merge guard checks: paragraphs first, then
 * sentences inside each paragraph. A unit is checked only when it carries
 * real content (3+ tokens) — tiny fragments are ignored so they can neither
 * fail a good merge nor hide inside a bad one. Returns the ORIGINAL texts.
 */
export function mergeUnits(body: string): string[] {
  const units: string[] = [];
  for (const para of body.split(/\n+/)) {
    for (const piece of para.split(/(?<=[.!؟…])\s+/)) {
      const unit = piece.trim();
      if (unit && compareTokens(unit).length >= 3) units.push(unit);
    }
  }
  return units;
}

/**
 * The source units (sentences/paragraph lines, in order, de-duplicated) that
 * do NOT survive in the merge output. A unit survives when its normalized
 * form appears in the normalized output, or when (nearly) all of its tokens
 * are present there — light rephrasing passes, a dropped sentence does not.
 */
export function missingMergeLines(sources: string[], output: string): string[] {
  const outText = normalizeForCompare(output);
  const outCounts = new Map<string, number>();
  for (const t of compareTokens(output)) outCounts.set(t, (outCounts.get(t) ?? 0) + 1);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const unit of mergeUnits(source)) {
      const key = normalizeForCompare(unit);
      if (seen.has(key)) continue;
      seen.add(key);
      if (outText.includes(key)) continue;
      const needed = compareTokens(unit);
      const tally = new Map<string, number>();
      for (const t of needed) tally.set(t, (tally.get(t) ?? 0) + 1);
      let matched = 0;
      for (const [t, n] of tally) matched += Math.min(n, outCounts.get(t) ?? 0);
      const ratio = needed.length ? matched / needed.length : 1;
      if (needed.length <= 3 ? ratio < 1 : ratio < 0.8) missing.push(unit);
    }
  }
  return missing;
}

/** A merged article is complete only when NO checkable source unit is missing. */
export function isMergeComplete(sources: string[], output: string): boolean {
  return missingMergeLines(sources, output).length === 0;
}

export type Engine = { kind: "gemini"; key: string } | { kind: "cloud"; token: string };

/** Run one AI task on the chosen engine and return its full streamed text. */
export async function runAi(
  engine: Engine, task: AiTask, payload: string, signal: AbortSignal,
  onText: (text: string) => void = () => {}, json?: object,
): Promise<string> {
  if (engine.kind === "gemini") {
    const { geminiStream } = await import("./gemini");
    return geminiStream(engine.key, TASK_INSTRUCTIONS[task], payload, signal, onText, json);
  }
  const response = await fetch("/api/articles/improve", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${engine.token}` },
    body: JSON.stringify({ task, payload }),
  });
  return readArticleStream(response, onText);
}

/** Proofread a full article (chunked), verifying nothing is lost. */
export async function improveFull(
  article: { title: string; body: string }, original: string, samples: string[], engine: Engine,
  signal: AbortSignal, onText: (text: string) => void,
): Promise<{ title: string; body: string }> {
  const chunks = splitChunks(article.body);
  let title = article.title; const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const payload = { title: article.title, body: chunks[i], original: chunks.length > 1 ? "" : original.slice(0, 40000), samples };
    const show = (t: string) => onText([...parts, t].join("\n\n"));
    const text = await runAi(engine, "improve", JSON.stringify(payload), signal, show);
    const out = parseImprovedArticle(text);
    if (!isComplete(chunks[i] ?? "", out.body)) throw new Error(INCOMPLETE);
    if (i === 0) title = out.title;
    parts.push(out.body);
  }
  return { title, body: parts.join("\n\n") };
}

/**
 * Clean a full article (chunked) the strict way: remove dictation noise and fix
 * spelling/punctuation ONLY — no wording, order or style changes. The payload
 * deliberately omits `original` and `samples` (unlike improveFull): with no
 * style material in the request and the bare `clean` instructions server-side,
 * nothing can steer the model toward restyling the author's words.
 */
export async function cleanFull(
  article: { title: string; body: string }, engine: Engine,
  signal: AbortSignal, onText: (text: string) => void,
): Promise<{ title: string; body: string }> {
  const chunks = splitChunks(article.body);
  let title = article.title; const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const payload = { title: article.title, body: chunks[i] };
    const show = (t: string) => onText([...parts, t].join("\n\n"));
    const text = await runAi(engine, "clean", JSON.stringify(payload), signal, show);
    const out = parseImprovedArticle(text);
    if (!isComplete(chunks[i] ?? "", out.body)) throw new Error(INCOMPLETE);
    if (i === 0) title = out.title;
    parts.push(out.body);
  }
  return { title, body: parts.join("\n\n") };
}
