import { getArticle, type Idea } from "./ideas";
import { INCOMPLETE, isMergeComplete, parseImprovedArticle } from "./article-ai";
import { geminiStream, MERGE_INSTRUCTIONS, SUGGEST_INSTRUCTIONS } from "./gemini";

export type MergeSuggestion = { ids: string[]; title: string; reason: string };

const CACHE = "afkari.mergeSuggestions";
const DISMISSED = "afkari.mergeDismissed";
const groupKey = (ids: string[]) => [...ids].sort().join("|");

export const fingerprint = (ideas: Idea[]) => ideas.map((i) => `${i.id}:${i.updatedAt ?? 0}`).sort().join(",");

export const loadSuggestionCache = (): { fp: string; list: MergeSuggestion[] } | null => {
  try { return JSON.parse(localStorage.getItem(CACHE) || "null"); } catch { return null; }
};
export const saveSuggestionCache = (fp: string, list: MergeSuggestion[]) => localStorage.setItem(CACHE, JSON.stringify({ fp, list }));

const loadDismissed = (): string[] => {
  try { return JSON.parse(localStorage.getItem(DISMISSED) || "[]"); } catch { return []; }
};
export const dismissSuggestion = (ids: string[]) => {
  const all = loadDismissed();
  const key = groupKey(ids);
  if (!all.includes(key)) localStorage.setItem(DISMISSED, JSON.stringify([...all, key]));
};

/** Keep only suggestions whose articles still exist, have 2+ members, and weren't dismissed. */
export function liveSuggestions(list: MergeSuggestion[], ideas: Idea[]): MergeSuggestion[] {
  const ids = new Set(ideas.map((i) => i.id));
  const dismissed = new Set(loadDismissed());
  return list.filter((s) => s.ids.length >= 2 && s.ids.every((id) => ids.has(id)) && !dismissed.has(groupKey(s.ids)));
}

/** Clean model output: known ids only, no duplicates across groups, 2+ members. */
export function sanitizeSuggestions(raw: unknown, ideas: Idea[]): MergeSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(ideas.map((i) => i.id));
  const used = new Set<string>();
  const out: MergeSuggestion[] = [];
  for (const s of raw) {
    if (!s || !Array.isArray(s.ids)) continue;
    const ids = [...new Set((s.ids as unknown[]).filter((id): id is string => typeof id === "string" && known.has(id) && !used.has(id)))];
    if (ids.length < 2) continue;
    ids.forEach((id) => used.add(id));
    out.push({ ids, title: String(s.title ?? "").trim() || "مقال مدمج", reason: String(s.reason ?? "").trim() });
  }
  return out;
}

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { ids: { type: "ARRAY", items: { type: "STRING" } }, title: { type: "STRING" }, reason: { type: "STRING" } },
    required: ["ids", "title", "reason"],
  },
};

export async function findMerges(ideas: Idea[], key: string, signal: AbortSignal): Promise<MergeSuggestion[]> {
  if (ideas.length < 2) return [];
  const list = ideas.slice(0, 80).map((i) => {
    const a = getArticle(i);
    return { id: i.id, title: a.title, excerpt: a.body.slice(0, 600) };
  });
  const text = await geminiStream(key, SUGGEST_INSTRUCTIONS, JSON.stringify(list), signal, () => {}, SCHEMA);
  return sanitizeSuggestions(JSON.parse(text), ideas);
}

export async function mergeArticles(
  sources: { title: string; body: string }[], key: string, signal: AbortSignal, onText: (t: string) => void,
): Promise<{ title: string; body: string }> {
  const text = await geminiStream(key, MERGE_INSTRUCTIONS, JSON.stringify(sources), signal, onText);
  const out = parseImprovedArticle(text);
  if (!isMergeComplete(sources.map((s) => s.body), out.body)) throw new Error(INCOMPLETE);
  return out;
}
