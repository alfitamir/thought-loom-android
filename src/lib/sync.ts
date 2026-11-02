import { supabase } from "@/integrations/supabase/client";
import {
  clearCloudRevived, clearDeleted, loadCloudRevived, loadDeleted, loadIdeas, markDriveDeleted, mergeIdeas, replaceIdeas, type Idea,
} from "./ideas";
import { syncDrive } from "./drive-sync";

const getSession = async () => (await supabase.auth.getSession()).data.session;

const cloudRow = (idea: Idea, userId: string) => ({
  id: idea.id, user_id: userId, text: idea.text, created_at: idea.createdAt,
  article_title: idea.articleTitle ?? null, article_body: idea.articleBody ?? null,
  updated_at: idea.updatedAt ?? 0, merged_from: idea.mergedFrom ?? null,
  topic: idea.topic ?? null, topic_manual: idea.topicManual ?? false,
});

/** Push one idea to the cloud backup (silently skipped when offline or signed out). */
export const pushIdea = async (idea: Idea) => {
  const s = await getSession();
  if (!s || !navigator.onLine) return;
  if (loadDeleted().includes(idea.id)) return;
  // Reconciliation prevents a stale edition from overwriting another device's edit.
  await syncNow();
};

/** Delete one idea from the cloud backup; the deletion record keeps every device from bringing it back. */
export const deleteIdeaCloud = async (_id: string) => {
  await syncNow();
};

let running: Promise<number> | null = null;
let again = false;

/**
 * Two-way sync between local storage and the cloud backup. Overlapping calls are
 * coalesced so a slow sync can never re-add ideas that a newer one deleted.
 * Deletions are recorded in the cloud and win on every device, unless the user
 * explicitly restored the idea from a backup.
 * Returns the number of ideas restored from the cloud.
 */
export function syncNow(): Promise<number> {
  if (running) { again = true; return running; }
  running = run().finally(() => {
    running = null;
    if (again) { again = false; void syncNow(); }
  });
  return running;
}

async function run(): Promise<number> {
  const s = await getSession();
  if (!s || !navigator.onLine) return 0;
  const uid = s.user.id;

  // Explicit restores lift the cloud deletion record first.
  const revived = loadCloudRevived();
  if (revived.length) {
    const { error } = await supabase.from("idea_deletions").delete().eq("user_id", uid).in("idea_id", revived);
    if (error) return 0;
    clearCloudRevived(revived);
  }

  // Record this device's deletions in the cloud before anything else.
  const deleted = loadDeleted();
  if (deleted.length) {
    const { error } = await supabase.from("idea_deletions").upsert(deleted.map((idea_id) => ({ user_id: uid, idea_id })));
    if (error) return 0;
    await supabase.from("ideas").delete().in("id", deleted).eq("user_id", uid);
  }

  const [{ data: gone, error: goneError }, { data, error }] = await Promise.all([
    supabase.from("idea_deletions").select("idea_id").eq("user_id", uid),
    supabase.from("ideas").select("id,text,created_at,article_title,article_body,updated_at,merged_from,topic,topic_manual").eq("user_id", uid),
  ]);
  if (goneError || error || !gone || !data) return 0;
  if (deleted.length) clearDeleted(deleted);

  const cloudDeleted = new Set(gone.map((g) => g.idea_id));
  const revivedNow = new Set(loadCloudRevived());
  const local = loadIdeas();
  const localIds = new Set(local.map((i) => i.id));
  const remote: Idea[] = data.filter((r) => !cloudDeleted.has(r.id) || revivedNow.has(r.id)).map((r) => ({
    id: r.id, text: r.text, createdAt: Number(r.created_at),
    ...(r.article_title === null ? {} : { articleTitle: r.article_title }),
    ...(r.article_body === null ? {} : { articleBody: r.article_body }),
    ...(r.merged_from?.length ? { mergedFrom: r.merged_from } : {}),
    ...(r.topic ? { topic: r.topic } : {}),
    ...(r.topic_manual ? { topicManual: true } : {}),
    updatedAt: Number(r.updated_at),
  }));
  // Read again after network awaits so edits/deletions made during sync are preserved.
  const tombstones = [...new Set([...cloudDeleted, ...loadDeleted()])].filter((id) => !revivedNow.has(id));
  const merged = mergeIdeas(loadIdeas(), remote, tombstones);
  const kept = new Set(merged.map((i) => i.id));
  const removedHere = loadIdeas().filter((i) => !kept.has(i.id)).map((i) => i.id);
  if (removedHere.length) markDriveDeleted(removedHere);
  replaceIdeas(merged);

  // Leftover rows of deleted ideas are cleaned up; changed ideas are uploaded.
  const stale = data.filter((r) => cloudDeleted.has(r.id) && !revivedNow.has(r.id)).map((r) => r.id);
  if (stale.length) await supabase.from("ideas").delete().in("id", stale).eq("user_id", uid);
  const cloudById = new Map(remote.map((i) => [i.id, i]));
  const changed = merged.filter((i) => {
    const cloud = cloudById.get(i.id);
    // Topic pins are metadata that do not bump updatedAt, so they are compared directly.
    return !cloud || (i.updatedAt ?? 0) > (cloud.updatedAt ?? 0) || (!!i.mergedFrom && !cloud.mergedFrom)
      || (i.topic ?? null) !== (cloud.topic ?? null) || (i.topicManual ?? false) !== (cloud.topicManual ?? false);
  });
  if (changed.length) await supabase.from("ideas").upsert(changed.map((i) => cloudRow(i, uid)));
  window.dispatchEvent(new Event("afkari:ideas-changed"));
  void syncDrive().catch(() => {});
  return merged.filter((i) => !localIds.has(i.id)).length;
}
