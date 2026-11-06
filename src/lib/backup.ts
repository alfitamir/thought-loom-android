import { z } from "zod";
import {
  clearDeleted,
  loadDeleted,
  loadIdeas,
  markRevived,
  mergeIdeas,
  parseVersions,
  replaceIdeas,
  type Idea,
} from "./ideas";
import { ideaSchema } from "./idea-schema";

/** Copy one optional field from untrusted backup data onto the idea when
 *  the shared idea schema accepts the value; drop the field otherwise. */
function copyIdeaField<K extends keyof Idea>(
  idea: Idea,
  raw: Record<string, unknown>,
  key: K,
): void {
  const value = raw[key];
  if (value === undefined) return;
  const parsed = (ideaSchema.shape[key] as z.ZodType<unknown>).safeParse(value);
  if (parsed.success) idea[key] = parsed.data as Idea[K];
}

export function buildBackup(ideas: Idea[], exportedAt = Date.now()): string {
  return JSON.stringify({ app: "afkari", version: 1, exportedAt, ideas }, null, 2);
}

const BAD = "الملف ليس نسخة احتياطية صالحة من أفكاري.";

/** Validate a backup file and return its ideas (throws an Arabic message).
 *  Accepts the wrapped export format and, as in Afkari, a bare array of ideas. */
export function parseBackup(raw: string): Idea[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(BAD);
  }
  const obj = data as { app?: string; ideas?: unknown } | null;
  // A wrapped file from another app gets Afkari's specific message; anything else malformed keeps the generic one.
  if (
    !Array.isArray(data) &&
    obj &&
    typeof obj === "object" &&
    "ideas" in obj &&
    obj.app !== "afkari"
  ) {
    throw new Error("هذا الملف ليس نسخة احتياطية من «أفكاري».");
  }
  const list = Array.isArray(data) ? data : obj?.app === "afkari" ? obj.ideas : null;
  if (!Array.isArray(list)) throw new Error(BAD);
  const ideas = list.flatMap((raw): Idea[] => {
    if (!raw || typeof raw !== "object") return [];
    const i = raw as Record<string, unknown>;
    // Core identity is validated by the shared idea schema (idea-schema.ts):
    // an entry without a valid id/text/createdAt is not an idea at all.
    const core = ideaSchema.pick({ id: true, text: true, createdAt: true }).safeParse(i);
    if (!core.success) return [];
    const idea: Idea = { ...core.data };
    // Every optional field below is validated against that SAME schema,
    // field by field (see copyIdeaField): a mistyped value drops the field,
    // never the whole idea — the leniency this parser has always had, now
    // with exactly one field list in the codebase.
    copyIdeaField(idea, i, "articleTitle");
    copyIdeaField(idea, i, "articleBody");
    copyIdeaField(idea, i, "updatedAt");
    copyIdeaField(idea, i, "aiPolishedAt");
    if (Array.isArray(i["mergedFrom"]))
      idea.mergedFrom = i["mergedFrom"].filter((m: unknown): m is string => typeof m === "string");
    copyIdeaField(idea, i, "topic");
    copyIdeaField(idea, i, "songDuration");
    copyIdeaField(idea, i, "source");
    copyIdeaField(idea, i, "driveFileId");
    copyIdeaField(idea, i, "project");
    // Strings that only mean something non-blank are dropped when blank:
    // a hand-pinned topic (or the lock would silently vanish), a liked
    // article's attribution, the Drive file id (a restored song must know
    // where its copy lives) and the project assignment (or a restore would
    // un-file an article from the book or series it belongs to).
    for (const key of ["topic", "source", "driveFileId", "project"] as const) {
      const value = idea[key];
      if (value !== undefined && !value.trim()) delete idea[key];
    }
    if (idea.songDuration !== undefined && !(idea.songDuration > 0)) delete idea.songDuration;
    // Boolean flags travel only as `true` — an explicit false in a file is
    // the absence of the flag. Each one is load-bearing on restore: a
    // song's flag (the recording itself never travels; audio stays on the
    // recording device), a liked article's flag (or someone else's article
    // would come back unmarked and AI-editable), the library pin (or a
    // restore silently unpins) and section membership (or a medical
    // article drops back into the general library).
    for (const key of ["song", "liked", "pinned", "medical"] as const) {
      copyIdeaField(idea, i, key);
      if (idea[key] !== true) delete idea[key];
    }
    if (i["topicManual"] === true && idea.topic) idea.topicManual = true;
    if (Array.isArray(i["sources"])) {
      const sources = i["sources"].filter(
        (s: unknown): s is string => typeof s === "string" && !!s.trim(),
      );
      if (sources.length) idea.sources = sources;
    }
    // Version history travels too — a restore must not strip the safety
    // net of frozen pre-AI texts. Malformed entries are dropped by the
    // validator, never guessed back into shape.
    const versions = parseVersions(i["versions"]);
    if (versions) idea.versions = versions;
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
