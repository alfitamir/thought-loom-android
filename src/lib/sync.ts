import { supabase } from "@/integrations/supabase/client";
import { clearDeleted, loadDeleted, loadIdeas, mergeIdeas, replaceIdeas, type Idea } from "./ideas";

const getSession = async () => (await supabase.auth.getSession()).data.session;

const cloudRow = (idea: Idea, userId: string) => ({
  id: idea.id, user_id: userId, text: idea.text, created_at: idea.createdAt,
  article_title: idea.articleTitle ?? null, article_body: idea.articleBody ?? null,
  updated_at: idea.updatedAt ?? 0,
});

/** Push one idea to the cloud backup (silently skipped when offline or signed out). */
export const pushIdea = async (idea: Idea) => {
  const s = await getSession();
  if (!s || !navigator.onLine) return;
  if (loadDeleted().includes(idea.id)) return;
  // Reconciliation prevents a stale edition from overwriting another device's edit.
  await syncNow();
};

/** Delete one idea from the cloud backup (silently skipped when offline or signed out). */
export const deleteIdeaCloud = async (id: string) => {
  const s = await getSession();
  if (!s || !navigator.onLine) return;
  const { error } = await supabase.from("ideas").delete().eq("id", id).eq("user_id", s.user.id);
  if (!error) clearDeleted([id]);
};

/**
 * Two-way sync between local storage and the cloud backup:
 * restores cloud ideas missing on this device, pushes local ideas missing in the
 * cloud, and propagates deletions recorded while offline.
 * Returns the number of ideas restored from the cloud.
 */
export const syncNow = async (): Promise<number> => {
  const s = await getSession();
  if (!s || !navigator.onLine) return 0;
  const uid = s.user.id;
  const { data } = await supabase.from("ideas").select("id,text,created_at,article_title,article_body,updated_at").eq("user_id", uid);
  if (!data) return 0;

  const local = loadIdeas();
  const deleted = loadDeleted();

  // Apply offline deletions to the cloud, then stop tracking them.
  if (deleted.length) {
    const { error } = await supabase.from("ideas").delete().in("id", deleted).eq("user_id", uid);
    if (!error) clearDeleted(deleted);
  }

  const localIds = new Set(local.map((i) => i.id));
  const remote: Idea[] = data.map((r) => ({
    id: r.id, text: r.text, createdAt: Number(r.created_at),
    ...(r.article_title === null ? {} : { articleTitle: r.article_title }),
    ...(r.article_body === null ? {} : { articleBody: r.article_body }),
    updatedAt: Number(r.updated_at),
  }));
  // Read again after network awaits so edits/deletions made during sync are preserved.
  const tombstones = [...new Set([...deleted, ...loadDeleted()])];
  const merged = mergeIdeas(loadIdeas(), remote, tombstones);
  replaceIdeas(merged);
  const cloudById = new Map(remote.map((i) => [i.id, i]));
  const changed = merged.filter((i) => {
    const cloud = cloudById.get(i.id);
    return !cloud || (i.updatedAt ?? 0) > (cloud.updatedAt ?? 0);
  });
  if (changed.length) {
    await supabase.from("ideas").upsert(changed.map((i) => cloudRow(i, uid)));
  }
  window.dispatchEvent(new Event("afkari:ideas-changed"));
  return merged.filter((i) => !localIds.has(i.id)).length;
};
