import { OTHER } from "@/lib/topics";

/**
 * «منشور X» — a pure, on-device composer that turns one of the author's own
 * articles into a single X-ready post, the local sibling of the AI-suggested
 * Facebook post. Why pure and not AI: X's 280-character limit is a hard
 * guarantee, and only a deterministic composer can promise it by
 * construction — the hook is composed first, the insight is trimmed at a
 * word boundary with an ellipsis to whatever room remains, and the hook
 * itself is touched only in the pathological case where it alone overflows.
 * Copy-only like Facebook: the app never posts to X; the author pastes the
 * text himself. No network, no model, works offline.
 *
 * Voice (the author's verified X voice for medical posts): SHORT; opens
 * with a direct patient question or a misconception correction; simplified
 * فصحى; decisions tied to «التقييم الطبي»; a medical post may close with
 * «هذه المعلومات لا تغني عن التقييم الطبي» when space allows; hashtags
 * are rare — at most one here, and only from a single-word topic.
 */

export const X_POST_LIMIT = 280;

/** The standard close of the author's medical posts. */
export const X_DISCLAIMER = "هذه المعلومات لا تغني عن التقييم الطبي";

/** Below this many characters a trimmed insight is a stub, not a sentence —
 *  drop it and let the hook (and the medical disclaimer) stand alone. */
const MIN_INSIGHT_CHARS = 24;

export type XPostInput = {
  title: string;
  body: string;
  /** Medical-section article: eligible like any of the author's own, and
   *  the post may carry the medical disclaimer close. */
  medical?: boolean | undefined;
  /** Derived topic, used only as a hashtag candidate (see topicHashtag). */
  topic?: string | undefined;
};

/**
 * Character count the way X weighs a post: one per character, two for
 * astral-plane characters (emoji). Arabic and Latin letters are all BMP,
 * so for the author's text this is simply the character count.
 */
export function xCharCount(text: string): number {
  let n = 0;
  for (const ch of text) n += (ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
  return n;
}

const cleanLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Split a body into sentences on Arabic/Latin terminators, in order. */
function sentencesOf(body: string): string[] {
  const flat = cleanLine(body);
  if (!flat) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i]!;
    if (ch === "." || ch === "!" || ch === "?" || ch === "؟" || ch === "…") {
      const s = flat.slice(start, i + 1).trim();
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const tail = flat.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

const QUESTION_STARTERS = ["هل", "متى", "لماذا", "كيف", "ماذا", "أيّ", "أي", "أين", "من هو", "من هي"];

function startsWithQuestionWord(t: string): boolean {
  return QUESTION_STARTERS.some((w) => t === w || t.startsWith(`${w} `) || t.startsWith(`${w}؟`));
}

/**
 * The hook line: the article's title, cleaned. A title that opens with a
 * question word but lost its question mark gets it back; a question or a
 * misconception correction passes through untouched — the composer never
 * rewrites the author's title into a templated question.
 */
function buildHook(title: string, body: string): string {
  let hook = cleanLine(title);
  if (!hook) hook = sentencesOf(body)[0] ?? "";
  if (!hook) return "";
  if (startsWithQuestionWord(hook) && !/[؟?]$/.test(hook)) hook += "؟";
  return hook;
}

/** The insight line: the body's first sentence that is not the hook itself
 *  (nor a prefix/extension of it). Empty when the body adds nothing. */
function pickInsight(body: string, hook: string): string {
  for (const s of sentencesOf(body)) {
    if (s === hook) continue;
    if (hook && (s.startsWith(hook) || hook.startsWith(s))) continue;
    return s;
  }
  return "";
}

/**
 * Trim to a character budget at a word boundary, closing with an ellipsis
 * (the ellipsis is inside the budget). A single word longer than the
 * budget is cut mid-word — there is no boundary to respect.
 */
function trimToFit(text: string, budget: number): string {
  if (xCharCount(text) <= budget) return text;
  if (budget <= 0) return "";
  if (budget === 1) return "…";
  let out = "";
  let n = 0;
  for (const ch of text) {
    const w = (ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
    if (n + w > budget - 1) break;
    out += ch;
    n += w;
  }
  const lastSpace = out.lastIndexOf(" ");
  if (lastSpace > 0) out = out.slice(0, lastSpace);
  return `${out.trimEnd()}…`;
}

/**
 * The one hashtag this composer ever adds: the article's topic, only when
 * it is a single hashtag-clean word. Real topics are phrases («الإيمان
 * والروح») and the fallback bucket «متفرقات» is not a tag — both yield
 * nothing, which is why hashtags stay rare in the author's posts.
 */
function topicHashtag(topic: string | undefined): string {
  if (!topic) return "";
  const t = topic.trim();
  if (!t || t === OTHER || /\s/.test(t)) return "";
  if (!/^\p{L}[\p{L}\p{N}_]*$/u.test(t)) return "";
  return `#${t}`;
}

/**
 * Compose the X post. Structure: hook line, then the insight (trimmed at
 * a word boundary to the room that remains, reserving the disclaimer's
 * space first on medical posts), then the medical disclaimer when it
 * fits, then the topic hashtag when it fits. The result NEVER exceeds
 * X_POST_LIMIT by the count above.
 */
export function composeXPost(input: XPostInput): string {
  const hook = buildHook(input.title ?? "", input.body ?? "");
  if (!hook) return "";
  let post = xCharCount(hook) > X_POST_LIMIT ? trimToFit(hook, X_POST_LIMIT) : hook;

  const disclaimer = input.medical ? X_DISCLAIMER : "";
  const insight = pickInsight(input.body ?? "", hook);
  if (insight) {
    const reserve = disclaimer ? xCharCount(disclaimer) + 1 : 0;
    const budget = X_POST_LIMIT - xCharCount(post) - 1 - reserve;
    if (budget >= MIN_INSIGHT_CHARS) post += `\n${trimToFit(insight, budget)}`;
  }
  if (disclaimer && xCharCount(post) + 1 + xCharCount(disclaimer) <= X_POST_LIMIT) {
    post += `\n${disclaimer}`;
  }
  const tag = topicHashtag(input.topic);
  if (tag && xCharCount(post) + 1 + xCharCount(tag) <= X_POST_LIMIT) {
    post += `\n${tag}`;
  }
  return post;
}
