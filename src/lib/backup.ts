import { clearDeleted, loadDeleted, loadIdeas, markRevived, mergeIdeas, replaceIdeas, type Idea } from "./ideas";

export function buildBackup(ideas: Idea[], exportedAt = Date.now()): string {
  return JSON.stringify({ app: "afkari", version: 1, exportedAt, ideas }, null, 2);
}

const BAD = "الملف ليس نسخة احتياطية صالحة من أفكاري.";

/** Validate a backup file and return its ideas (throws an Arabic message).
 *  Accepts the wrapped export format and, as in Afkari, a bare array of ideas. */
export function parseBackup(raw: string): Idea[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error(BAD); }
  const obj = data as { app?: string; ideas?: unknown } | null;
  // A wrapped file from another app gets Afkari's specific message; anything else malformed keeps the generic one.
  if (!Array.isArray(data) && obj && typeof obj === "object" && "ideas" in obj && obj.app !== "afkari") {
    throw new Error("هذا الملف ليس نسخة احتياطية من «أفكاري».");
  }
  const list = Array.isArray(data) ? data : obj?.app === "afkari" ? obj.ideas : null;
  if (!Array.isArray(list)) throw new Error(BAD);
  const ideas = list.flatMap((i): Idea[] => {
    if (!i || typeof i.id !== "string" || typeof i.text !== "string" || typeof i.createdAt !== "number") return [];
    const idea: Idea = { id: i.id, text: i.text, createdAt: i.createdAt };
    if (typeof i.articleTitle === "string") idea.articleTitle = i.articleTitle;
    if (typeof i.articleBody === "string") idea.articleBody = i.articleBody;
    if (typeof i.updatedAt === "number") idea.updatedAt = i.updatedAt;
    if (typeof i.aiPolishedAt === "number") idea.aiPolishedAt = i.aiPolishedAt;
    if (Array.isArray(i.mergedFrom)) idea.mergedFrom = i.mergedFrom.filter((m: unknown): m is string => typeof m === "string");
    // A hand-pinned topic must survive a restore, or the lock would silently vanish.
    if (typeof i.topic === "string" && i.topic.trim()) idea.topic = i.topic;
    if (i.topicManual === true && idea.topic) idea.topicManual = true;
    // A song's flag and length travel in backups like any other field; the
    // recording itself never does (audio stays on the recording device).
    if (i.song === true) idea.song = true;
    if (typeof i.songDuration === "number" && i.songDuration > 0) idea.songDuration = i.songDuration;
    // A liked article's flag and attribution travel too — a restore must
    // never turn someone else's article into an unmarked, AI-editable one.
    if (i.liked === true) idea.liked = true;
    if (typeof i.source === "string" && i.source.trim()) idea.source = i.source;
    if (Array.isArray(i.sources)) {
      const sources = i.sources.filter((s: unknown): s is string => typeof s === "string" && !!s.trim());
      if (sources.length) idea.sources = sources;
    }
    // The Drive file id travels too, so a restored song still knows where its copy lives.
    if (typeof i.driveFileId === "string" && i.driveFileId.trim()) idea.driveFileId = i.driveFileId;
    // The library pin travels too — a restore must not silently unpin what
    // the user fixed to the top of its group.
    if (i.pinned === true) idea.pinned = true;
    return [idea];
  });
  if (list.length && !ideas.length) throw new Error("لم نجد أفكارًا صالحة في هذا الملف.");
  return ideas;
}

/** Restore ideas into this device without overwriting newer local edits. Returns how many were added. */
export function restoreBackup(imported: Idea[]): number {
  const local = loadIdeas();
  const ids = imported.map((i) => i.id);
  // A restore is an explicit choice: bring back ideas even if they were deleted here.
  if (loadDeleted().some((d) => ids.includes(d))) clearDeleted(ids);
  markRevived(ids);
  const merged = mergeIdeas(local, imported, []);
  replaceIdeas(merged);
  window.dispatchEvent(new Event("afkari:ideas-changed"));
  const before = new Set(local.map((i) => i.id));
  return merged.filter((i) => !before.has(i.id)).length;
}
