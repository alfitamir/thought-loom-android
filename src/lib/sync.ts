import { supabase } from "@/integrations/supabase/client";
import { clearDeleted, loadDeleted, loadIdeas, replaceIdeas, type Idea } from "./ideas";

const getSession = async () => (await supabase.auth.getSession()).data.session;

/** Push one idea to the cloud backup (silently skipped when offline or signed out). */
export const pushIdea = async (idea: Idea) => {
  const s = await getSession();
  if (!s || !navigator.onLine) return;
  await supabase.from("ideas").upsert({
    id: idea.id,
    user_id: s.user.id,
    text: idea.text,
    created_at: idea.createdAt,
  });
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
  const { data } = await supabase.from("ideas").select("id,text,created_at").eq("user_id", uid);
  if (!data) return 0;

  const local = loadIdeas();
  const deleted = loadDeleted();

  // Apply offline deletions to the cloud, then stop tracking them.
  if (deleted.length) {
    await supabase.from("ideas").delete().in("id", deleted).eq("user_id", uid);
    clearDeleted(deleted);
  }

  const rows = data as { id: string; text: string; created_at: number }[];
  const localIds = new Set(local.map((i) => i.id));
  const cloudIds = new Set(rows.map((r) => r.id));
  const deletedSet = new Set(deleted);

  const restored: Idea[] = rows
    .filter((r) => !localIds.has(r.id) && !deletedSet.has(r.id))
    .map((r) => ({ id: r.id, text: r.text, createdAt: Number(r.created_at) }));
  const missing = local.filter((i) => !cloudIds.has(i.id));

  if (restored.length) replaceIdeas([...restored, ...local]);
  if (missing.length) {
    await supabase.from("ideas").upsert(
      missing.map((i) => ({ id: i.id, user_id: uid, text: i.text, created_at: i.createdAt })),
    );
  }
  return restored.length;
};
