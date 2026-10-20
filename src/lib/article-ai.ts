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

const norm = (w: string) => w.replace(/[أإآ]/g, "ا").replace(/^(ال|و|ف|ب)/, "");

/** A merged article must keep most words of every source and each source's ending. */
export function isMergeComplete(sources: string[], output: string): boolean {
  const out = new Set(words(output).map(norm));
  return sources.every((source) => {
    const src = [...new Set(words(source).filter((w) => w.length > 2).map(norm))];
    if (!src.length) return true;
    if (src.filter((w) => out.has(w)).length < src.length * 0.7) return false;
    const tail = words(source).slice(-6).filter((w) => w.length > 2).map(norm);
    return !tail.length || tail.filter((w) => out.has(w)).length >= Math.ceil(tail.length / 2);
  });
}

export type Engine = { kind: "gemini"; key: string } | { kind: "cloud"; token: string };

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
    let text: string;
    if (engine.kind === "gemini") {
      const { geminiStream, IMPROVE_INSTRUCTIONS } = await import("./gemini");
      text = await geminiStream(engine.key, IMPROVE_INSTRUCTIONS, JSON.stringify(payload), signal, show);
    } else {
      const response = await fetch("/api/articles/improve", {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${engine.token}` },
        body: JSON.stringify(payload),
      });
      text = await readArticleStream(response, show);
    }
    const out = parseImprovedArticle(text);
    if (!isComplete(chunks[i] ?? "", out.body)) throw new Error(INCOMPLETE);
    if (i === 0) title = out.title;
    parts.push(out.body);
  }
  return { title, body: parts.join("\n\n") };
}
