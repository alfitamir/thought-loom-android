import { getArticle, type Idea } from "./ideas";
import {
  MergeIncompleteError,
  missingMergeLines,
  parseImprovedArticle,
  runAi,
  type Engine,
} from "./article-ai";
import { MERGE_SUGGEST_SCHEMA } from "./ai-prompts";

export type MergeSuggestion = {
  ids: string[];
  title: string;
  reason: string;
  thesis?: string;
  strength?: number;
};

const CACHE = "afkari.mergeSuggestions";
const DISMISSED = "afkari.mergeDismissed";
const groupKey = (ids: string[]) => [...ids].sort().join("|");

export const fingerprint = (ideas: Idea[]) =>
  ideas
    .map((i) => `${i.id}:${i.updatedAt ?? 0}`)
    .sort()
    .join(",");

export const loadSuggestionCache = (): { fp: string; list: MergeSuggestion[] } | null => {
  try {
    return JSON.parse(localStorage.getItem(CACHE) || "null");
  } catch {
    return null;
  }
};
export const saveSuggestionCache = (fp: string, list: MergeSuggestion[]) =>
  localStorage.setItem(CACHE, JSON.stringify({ fp, list }));

const loadDismissed = (): string[][] => {
  try {
    return (JSON.parse(localStorage.getItem(DISMISSED) || "[]") as string[]).map((k) =>
      k.split("|"),
    );
  } catch {
    return [];
  }
};
export const dismissSuggestion = (ids: string[]) => {
  const all = loadDismissed().map(groupKey);
  const key = groupKey(ids);
  if (!all.includes(key)) localStorage.setItem(DISMISSED, JSON.stringify([...all, key]));
};

/** Ids already used as the source of a merged article: never suggested again. */
export const mergedSources = (ideas: Idea[]) => new Set(ideas.flatMap((i) => i.mergedFrom ?? []));

/** A suggestion repeats a dismissed or approved one when one group contains the other. */
const repeats = (ids: string[], done: string[][]) =>
  done.some((d) => d.every((id) => ids.includes(id)) || ids.every((id) => d.includes(id)));

/** Keep only suggestions whose articles still exist, have 2+ members, were never merged, and weren't dismissed. */
export function liveSuggestions(list: MergeSuggestion[], ideas: Idea[]): MergeSuggestion[] {
  const ids = new Set(ideas.map((i) => i.id));
  const sourced = mergedSources(ideas);
  const done = [
    ...loadDismissed(),
    ...ideas.filter((i) => i.mergedFrom?.length).map((i) => [i.id, ...(i.mergedFrom ?? [])]),
  ];
  return list.filter(
    (s) =>
      s.ids.length >= 2 &&
      s.ids.every((id) => ids.has(id) && !sourced.has(id)) &&
      !repeats(s.ids, done),
  );
}

/** Clean model output: known ids only, no duplicates across groups, 2-5 members, weak links dropped, strongest first. (Upgraded to Afkari's strength-aware version.) */
export function sanitizeSuggestions(raw: unknown, ideas: Idea[]): MergeSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(ideas.map((i) => i.id));
  const used = new Set<string>();
  const out: MergeSuggestion[] = [];
  const given = (s: { strength?: unknown } | null | undefined) =>
    Number.isInteger(Number(s?.strength)) && s?.strength !== null && s?.strength !== ""
      ? Math.min(5, Math.max(1, Number(s?.strength)))
      : undefined;
  // A missing strength counts as an average link (3) for ranking, but is not reported as if the model had said so.
  const ranked = raw
    .map((s, i) => ({ s, i, strength: given(s) }))
    .sort((a, b) => (b.strength ?? 3) - (a.strength ?? 3) || a.i - b.i);
  for (const { s, strength } of ranked) {
    if (!s || !Array.isArray(s.ids) || (strength ?? 3) < 3) continue;
    const ids = [
      ...new Set(
        (s.ids as unknown[]).filter(
          (id): id is string => typeof id === "string" && known.has(id) && !used.has(id),
        ),
      ),
    ].slice(0, 5);
    if (ids.length < 2) continue;
    ids.forEach((id) => used.add(id));
    const thesis = String(s.thesis ?? "").trim();
    out.push({
      ids,
      title: String(s.title ?? "").trim() || "مقال مدمج",
      reason: String(s.reason ?? "").trim(),
      ...(thesis ? { thesis } : {}),
      ...(strength !== undefined ? { strength } : {}),
    });
  }
  return out.slice(0, 5);
}

/** Opening + ending carry an article's thesis and conclusion; the middle adds little for matching. */
export const excerptForMatching = (body: string) =>
  body.length <= 700 ? body : `${body.slice(0, 450)} … ${body.slice(-250)}`;

/** Read a JSON array even when the model wrapped it in prose or code fences. */
export function parseJsonList(text: string): unknown {
  const start = text.indexOf("["),
    end = text.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
}

const SCHEMA = MERGE_SUGGEST_SCHEMA;

export async function findMerges(
  ideas: Idea[],
  engine: Engine,
  signal: AbortSignal,
): Promise<MergeSuggestion[]> {
  const sourced = mergedSources(ideas);
  // Liked articles are never suggested: merging them is a manual act only, so
  // their text never reaches the model and no AI merge can consume them.
  const candidates = ideas.filter((i) => !sourced.has(i.id) && !i.liked);
  if (candidates.length < 2) return [];
  const list = candidates.slice(0, 80).map((i) => {
    const a = getArticle(i);
    return { id: i.id, title: a.title, excerpt: excerptForMatching(a.body) };
  });
  const known = new Set(list.map((l) => l.id));
  const avoid = loadDismissed().filter((g) => g.every((id) => known.has(id)));
  const text = await runAi(
    engine,
    "suggest",
    JSON.stringify({ articles: list, avoid }),
    signal,
    () => {},
    SCHEMA,
  );
  return liveSuggestions(sanitizeSuggestions(parseJsonList(text), candidates), ideas);
}

export async function mergeArticles(
  sources: { title: string; body: string }[],
  engine: Engine,
  signal: AbortSignal,
  onText: (t: string) => void,
): Promise<{ title: string; body: string }> {
  const text = await runAi(engine, "merge", JSON.stringify(sources), signal, onText);
  const out = parseImprovedArticle(text);
  const missing = missingMergeLines(
    sources.map((s) => s.body),
    out.body,
  );
  if (missing.length) throw new MergeIncompleteError(out, missing);
  return out;
}
