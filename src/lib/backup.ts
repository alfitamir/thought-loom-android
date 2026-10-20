import { clearDeleted, loadDeleted, loadIdeas, mergeIdeas, replaceIdeas, type Idea } from "./ideas";

export function buildBackup(ideas: Idea[], exportedAt = Date.now()): string {
  return JSON.stringify({ app: "afkari", version: 1, exportedAt, ideas }, null, 2);
}

const BAD = "الملف ليس نسخة احتياطية صالحة من أفكاري.";

/** Validate a backup file and return its ideas (throws an Arabic message). */
export function parseBackup(raw: string): Idea[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error(BAD); }
  const list = (data as { app?: string; ideas?: unknown })?.app === "afkari" ? (data as { ideas?: unknown }).ideas : null;
  if (!Array.isArray(list)) throw new Error(BAD);
  return list.flatMap((i): Idea[] => {
    if (!i || typeof i.id !== "string" || typeof i.text !== "string" || typeof i.createdAt !== "number") return [];
    const idea: Idea = { id: i.id, text: i.text, createdAt: i.createdAt };
    if (typeof i.articleTitle === "string") idea.articleTitle = i.articleTitle;
    if (typeof i.articleBody === "string") idea.articleBody = i.articleBody;
    if (typeof i.updatedAt === "number") idea.updatedAt = i.updatedAt;
    if (typeof i.aiPolishedAt === "number") idea.aiPolishedAt = i.aiPolishedAt;
    return [idea];
  });
}

/** Restore ideas into this device without overwriting newer local edits. Returns how many were added. */
export function restoreBackup(imported: Idea[]): number {
  const local = loadIdeas();
  const ids = imported.map((i) => i.id);
  // A restore is an explicit choice: bring back ideas even if they were deleted here.
  if (loadDeleted().some((d) => ids.includes(d))) clearDeleted(ids);
  const merged = mergeIdeas(local, imported, []);
  replaceIdeas(merged);
  window.dispatchEvent(new Event("afkari:ideas-changed"));
  const before = new Set(local.map((i) => i.id));
  return merged.filter((i) => !before.has(i.id)).length;
}
