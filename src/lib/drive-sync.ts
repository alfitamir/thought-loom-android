import { supabase } from "@/integrations/supabase/client";
import {
  clearDriveMarks, loadDeleted, loadDriveDeleted, loadDriveRevived, loadIdeas, markDeleted, mergeIdeas, replaceIdeas, type Idea,
} from "./ideas";

const SYNCED_AT = "afkari.driveSyncedAt";
export type DriveResult = { ok: true; restored: number } | { ok: false; message: string };

export const lastDriveSync = (): number => {
  try { return Number(localStorage.getItem(SYNCED_AT)) || 0; } catch { return 0; }
};

let running: Promise<DriveResult> | null = null;
let again = false;

/** Two-way sync with the backup file in Google Drive. Overlapping calls are coalesced. */
export function syncDrive(): Promise<DriveResult> {
  if (running) { again = true; return running; }
  running = run().finally(() => {
    running = null;
    if (again) { again = false; void syncDrive(); }
  });
  return running;
}

async function run(): Promise<DriveResult> {
  if (!navigator.onLine) return { ok: false, message: "لا يوجد اتصال بالإنترنت الآن. سنزامن عند الاتصال." };
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) return { ok: false, message: "سجّل الدخول أولاً لتفعيل المزامنة مع Google Drive." };
  const sentDeleted = loadDriveDeleted();
  const sentRevived = loadDriveRevived();
  const res = await fetch("/api/drive/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ ideas: loadIdeas(), deleted: sentDeleted, revived: sentRevived }),
  }).catch(() => null);
  if (!res) return { ok: false, message: "تعذّر الوصول إلى Google Drive الآن. أفكارك محفوظة على الهاتف." };
  const data = await res.json().catch(() => ({})) as { ideas?: Idea[]; deleted?: string[]; message?: string };
  if (!res.ok || !Array.isArray(data.ideas) || !Array.isArray(data.deleted)) {
    return { ok: false, message: data.message ?? "تعذّرت المزامنة مع Google Drive الآن." };
  }
  clearDriveMarks(sentDeleted, sentRevived);

  // Re-read local state: edits, deletions or restores made during the request win.
  const revivedNow = new Set(loadDriveRevived());
  const tombstones = [...new Set([...data.deleted, ...loadDriveDeleted(), ...loadDeleted()])].filter((id) => !revivedNow.has(id));
  const before = loadIdeas();
  const merged = mergeIdeas(before, data.ideas, tombstones);
  const kept = new Set(merged.map((i) => i.id));
  // Deleted on another device: remove it from the cloud backup as well.
  const removed = before.filter((i) => !kept.has(i.id)).map((i) => i.id);
  if (removed.length) markDeleted(removed);
  replaceIdeas(merged);
  localStorage.setItem(SYNCED_AT, String(Date.now()));
  window.dispatchEvent(new Event("afkari:ideas-changed"));
  window.dispatchEvent(new Event("afkari:drive-synced"));
  const had = new Set(before.map((i) => i.id));
  return { ok: true, restored: merged.filter((i) => !had.has(i.id)).length };
}
