import type { Label } from "./ai-prompts";
import { classifyBatch, type AIOptions } from "./ai-features";
// In Afkari, ideas.ts re-exported the topics.ts classifier; Thought Loom's ideas.ts keeps its
// own local grouping classifier, so the AI-label layer imports Afkari's taxonomy directly.
import { classify } from "./topics";
import type { Idea } from "./ideas";

/** AI labels live beside the ideas (not inside them) so sync and backups stay untouched. */
type Stored = Label & { v: number };
const KEY = "afkari.aiLabels";
const BATCH = 30;

const load = (): Record<string, Stored> => {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") ?? {}; } catch { return {}; }
};
const version = (idea: Idea) => idea.updatedAt ?? 0;

/** The AI label if it is still valid for this edition of the article, otherwise the offline keyword fallback. */
export function labelFor(idea: Idea, all: Record<string, Stored> = load()): Label & { ai: boolean } {
  const s = all[idea.id];
  if (s && s.v === version(idea)) return { topic: s.topic, tags: s.tags, ai: true };
  return { topic: classify(idea.text), tags: [], ai: false };
}

export const unlabeled = (ideas: Idea[]) => {
  const all = load();
  return ideas.filter((i) => { const s = all[i.id]; return !s || s.v !== version(i); });
};

export const loadLabels = load;

/** Label every stale/unlabeled idea in batches; progress callback reports done/total. Partial progress is kept on failure. */
export async function labelAll(
  ideas: Idea[], o: AIOptions & { onProgress?: (done: number, total: number) => void } = {},
): Promise<number> {
  const todo = unlabeled(ideas);
  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const labels = await classifyBatch(chunk, o);
    const all = load();
    for (const idea of chunk) { const lab = labels[idea.id]; if (lab) all[idea.id] = { ...lab, v: version(idea) }; }
    localStorage.setItem(KEY, JSON.stringify(all));
    done += chunk.length;
    o.onProgress?.(Math.min(done, todo.length), todo.length);
  }
  window.dispatchEvent(new Event("afkari:labels-changed"));
  return todo.length;
}
