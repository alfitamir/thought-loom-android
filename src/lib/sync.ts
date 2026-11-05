import { supabase } from "@/integrations/supabase/client";
import {
  clearCloudRevived,
  clearDeleted,
  loadCloudRevived,
  loadDeleted,
  loadIdeas,
  markDriveDeleted,
  mergeIdeas,
  parseVersions,
  replaceIdeas,
  type Idea,
} from "./ideas";
import { syncDrive } from "./drive-sync";

const getSession = async () => (await supabase.auth.getSession()).data.session;

/**
 * Sync health record (audit F-6.1). A failed cloud sync used to be
 * indistinguishable from a healthy one — run() returned 0 on every
 * failure branch and no caller could tell. Now every pass ends in a
 * typed SyncResult, the last SUCCESS is timestamped, and the last
 * failure's message is kept until a pass succeeds again; Settings shows
 * both in «حالة النسخ الاحتياطي».
 */
const LAST_SYNC_KEY = "afkari.lastCloudSync";
const LAST_ERROR_KEY = "afkari.lastCloudSyncError";

/** Outcome of a cloud sync pass, modelled on DriveResult. */
export type SyncResult = { ok: true; restored: number } | { ok: false; message: string };

/** When the cloud backup last completed a full sync on this device (0 = never). */
export const lastCloudSync = (): number => {
  try {
    return Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
  } catch {
    return 0;
  }
};

/** Why the most recent cloud sync attempt failed ("" once one succeeds). */
export const lastCloudSyncError = (): string => {
  try {
    return localStorage.getItem(LAST_ERROR_KEY) ?? "";
  } catch {
    return "";
  }
};

const CLOUD_FAIL_MESSAGE =
  "تعذّرت المزامنة السحابية الآن. أفكارك محفوظة على الهاتف، وسنعيد المحاولة تلقائيًا.";

const recordSyncSuccess = () => {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    localStorage.removeItem(LAST_ERROR_KEY);
  } catch {
    /* the record is a gauge, never a blocker */
  }
};
const fail = (message: string): SyncResult => {
  try {
    localStorage.setItem(LAST_ERROR_KEY, message);
  } catch {
    /* same */
  }
  return { ok: false, message };
};

const cloudRow = (idea: Idea, userId: string) => ({
  id: idea.id,
  user_id: userId,
  text: idea.text,
  created_at: idea.createdAt,
  article_title: idea.articleTitle ?? null,
  article_body: idea.articleBody ?? null,
  updated_at: idea.updatedAt ?? 0,
  ai_polished_at: idea.aiPolishedAt ?? null,
  merged_from: idea.mergedFrom ?? null,
  topic: idea.topic ?? null,
  topic_manual: idea.topicManual ?? false,
  song: idea.song ?? false,
  song_duration: idea.songDuration ?? null,
  drive_file_id: idea.driveFileId ?? null,
  liked: idea.liked ?? false,
  source: idea.source ?? null,
  sources: idea.sources ?? null,
  pinned: idea.pinned ?? false,
  medical: idea.medical ?? false,
  project: idea.project ?? null,
  versions: idea.versions ?? null,
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

let running: Promise<SyncResult> | null = null;
let again = false;

/**
 * Two-way sync between local storage and the cloud backup. Overlapping calls are
 * coalesced so a slow sync can never re-add ideas that a newer one deleted.
 * Deletions are recorded in the cloud and win on every device, unless the user
 * explicitly restored the idea from a backup.
 * Resolves with a SyncResult — how many ideas the cloud restored, or why
 * the pass failed (the failure is also recorded for Settings). Never rejects.
 */
export function syncNow(): Promise<SyncResult> {
  if (running) {
    again = true;
    return running;
  }
  running = run().finally(() => {
    running = null;
    if (again) {
      again = false;
      void syncNow();
    }
  });
  return running;
}

async function run(): Promise<SyncResult> {
  try {
    return await runPass();
  } catch {
    return fail(CLOUD_FAIL_MESSAGE);
  }
}

async function runPass(): Promise<SyncResult> {
  if (!navigator.onLine) return fail("لا يوجد اتصال بالإنترنت الآن. سنزامن عند الاتصال.");
  const s = await getSession();
  if (!s) return fail("سجّل الدخول أولاً لتفعيل النسخة الاحتياطية السحابية.");
  const uid = s.user.id;

  // Explicit restores lift the cloud deletion record first.
  const revived = loadCloudRevived();
  if (revived.length) {
    const { error } = await supabase
      .from("idea_deletions")
      .delete()
      .eq("user_id", uid)
      .in("idea_id", revived);
    if (error) return fail(CLOUD_FAIL_MESSAGE);
    clearCloudRevived(revived);
  }

  // Record this device's deletions in the cloud before anything else.
  const deleted = loadDeleted();
  if (deleted.length) {
    const { error } = await supabase
      .from("idea_deletions")
      .upsert(deleted.map((idea_id) => ({ user_id: uid, idea_id })));
    if (error) return fail(CLOUD_FAIL_MESSAGE);
    const { error: deleteError } = await supabase
      .from("ideas")
      .delete()
      .in("id", deleted)
      .eq("user_id", uid);
    if (deleteError) return fail(CLOUD_FAIL_MESSAGE);
  }

  const [{ data: gone, error: goneError }, { data, error }] = await Promise.all([
    supabase.from("idea_deletions").select("idea_id").eq("user_id", uid),
    supabase
      .from("ideas")
      .select(
        "id,text,created_at,article_title,article_body,updated_at,ai_polished_at,merged_from,topic,topic_manual,song,song_duration,drive_file_id,liked,source,sources,pinned,medical,project,versions",
      )
      .eq("user_id", uid),
  ]);
  if (goneError || error || !gone || !data) return fail(CLOUD_FAIL_MESSAGE);
  if (deleted.length) clearDeleted(deleted);

  const cloudDeleted = new Set(gone.map((g) => g.idea_id));
  const revivedNow = new Set(loadCloudRevived());
  const local = loadIdeas();
  const localIds = new Set(local.map((i) => i.id));
  const remote: Idea[] = data
    .filter((r) => !cloudDeleted.has(r.id) || revivedNow.has(r.id))
    .map((r) => {
      // The jsonb history is untrusted until validated into clean entries.
      const versions = parseVersions(r.versions);
      return {
        id: r.id,
        text: r.text,
        createdAt: Number(r.created_at),
        ...(r.article_title === null ? {} : { articleTitle: r.article_title }),
        ...(r.article_body === null ? {} : { articleBody: r.article_body }),
        ...(r.merged_from?.length ? { mergedFrom: r.merged_from } : {}),
        ...(r.topic ? { topic: r.topic } : {}),
        ...(r.topic_manual ? { topicManual: true } : {}),
        ...(r.song ? { song: true } : {}),
        ...(typeof r.song_duration === "number" ? { songDuration: r.song_duration } : {}),
        ...(r.drive_file_id ? { driveFileId: r.drive_file_id } : {}),
        ...(r.liked ? { liked: true } : {}),
        ...(r.source ? { source: r.source } : {}),
        ...(r.sources?.length ? { sources: r.sources } : {}),
        ...(r.pinned ? { pinned: true } : {}),
        ...(r.medical ? { medical: true } : {}),
        ...(r.project ? { project: r.project } : {}),
        ...(versions ? { versions } : {}),
        ...(typeof r.ai_polished_at === "number" ? { aiPolishedAt: r.ai_polished_at } : {}),
        updatedAt: Number(r.updated_at),
      };
    });
  // Read again after network awaits so edits/deletions made during sync are preserved.
  const tombstones = [...new Set([...cloudDeleted, ...loadDeleted()])].filter(
    (id) => !revivedNow.has(id),
  );
  const merged = mergeIdeas(loadIdeas(), remote, tombstones);
  const kept = new Set(merged.map((i) => i.id));
  const removedHere = loadIdeas()
    .filter((i) => !kept.has(i.id))
    .map((i) => i.id);
  if (removedHere.length) markDriveDeleted(removedHere);
  replaceIdeas(merged);

  // Leftover rows of deleted ideas are cleaned up; changed ideas are uploaded.
  const stale = data
    .filter((r) => cloudDeleted.has(r.id) && !revivedNow.has(r.id))
    .map((r) => r.id);
  if (stale.length) {
    const { error: staleError } = await supabase
      .from("ideas")
      .delete()
      .in("id", stale)
      .eq("user_id", uid);
    if (staleError) return fail(CLOUD_FAIL_MESSAGE);
  }
  const cloudById = new Map(remote.map((i) => [i.id, i]));
  const changed = merged.filter((i) => {
    const cloud = cloudById.get(i.id);
    // Topic pins are metadata that do not bump updatedAt, so they are compared directly.
    // The song flag rides along the same way (a merge can adopt it without a text edit).
    return (
      !cloud ||
      (i.updatedAt ?? 0) > (cloud.updatedAt ?? 0) ||
      (!!i.mergedFrom && !cloud.mergedFrom) ||
      (i.topic ?? null) !== (cloud.topic ?? null) ||
      (i.topicManual ?? false) !== (cloud.topicManual ?? false) ||
      (i.song ?? false) !== (cloud.song ?? false) ||
      (i.songDuration ?? null) !== (cloud.songDuration ?? null) ||
      (i.driveFileId ?? null) !== (cloud.driveFileId ?? null) ||
      (i.liked ?? false) !== (cloud.liked ?? false) ||
      (i.source ?? null) !== (cloud.source ?? null) ||
      JSON.stringify(i.sources ?? null) !== JSON.stringify(cloud.sources ?? null) ||
      // The library pin is metadata that does not bump updatedAt either, so it is compared directly.
      (i.pinned ?? false) !== (cloud.pinned ?? false) ||
      // Section membership rides along the same way (a move never edits the text).
      (i.medical ?? false) !== (cloud.medical ?? false) ||
      // Project assignment is hand-set metadata too (filing never edits the text).
      (i.project ?? null) !== (cloud.project ?? null) ||
      // Version history rides along too: editions reconcile by union in
      // mergeIdeas, and a union that grew must reach the cloud even when
      // no timestamp moved.
      JSON.stringify(i.versions ?? null) !== JSON.stringify(cloud.versions ?? null) ||
      // The polish stamp rides along too: needsPolish compares it with
      // updatedAt, so a stamp earned on one device must reach the cloud
      // even when no timestamp moved — otherwise every other device
      // re-polishes finished articles.
      (i.aiPolishedAt ?? null) !== (cloud.aiPolishedAt ?? null)
    );
  });
  if (changed.length) {
    const { error: upsertError } = await supabase
      .from("ideas")
      .upsert(changed.map((i) => cloudRow(i, uid)));
    if (upsertError) return fail(CLOUD_FAIL_MESSAGE);
  }
  window.dispatchEvent(new Event("afkari:ideas-changed"));
  void syncDrive().catch(() => {});
  recordSyncSuccess();
  return { ok: true, restored: merged.filter((i) => !localIds.has(i.id)).length };
}
