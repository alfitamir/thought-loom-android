/** Why a text snapshot was taken: the AI (or restore) operation that was
 *  about to replace the article's text. */
export type VersionSource = "improve" | "clean" | "merge" | "restore";

/**
 * One frozen copy of an article's text, taken automatically BEFORE an AI
 * operation replaced it — the safety net for essays that exist nowhere
 * else. `text` is the article body as it read at that moment; `title` is
 * the title it carried (for 'merge' entries: the consumed source article's
 * title — the entry IS that source's full text, kept on the merged
 * article). Versions are stored NEWEST FIRST and capped at MAX_VERSIONS.
 */
export type IdeaVersion = {
  at: number;
  text: string;
  title?: string;
  source: VersionSource;
};

export type Idea = {
  id: string;
  text: string;
  createdAt: number;
  articleTitle?: string;
  articleBody?: string;
  updatedAt?: number;
  /** Set to updatedAt when the article was last AI-proofread; skip while equal. */
  aiPolishedAt?: number;
  /** Ids of the articles this one was merged from; they are never suggested for merging again. */
  mergedFrom?: string[];
  /** Topic the user pinned by hand; while `topicManual` is set it overrides every derived topic. */
  topic?: string;
  /** True when `topic` was set manually — classification must never overwrite a hand-set topic. */
  topicManual?: boolean;
  /** True for a song the user recorded singing in his own voice. The recording
   *  itself is the content (kept as audio on the recording device only);
   *  `text` holds the lyrics — written by hand, or extracted from the singing
   *  itself by song-lyrics.ts; no AI ever rewrites a song. */
  song?: boolean;
  /** Length of the recording in seconds, when known. Display metadata only. */
  songDuration?: number;
  /** True for an article the user liked ELSEWHERE (not his own writing). It
   *  arrives through its own paste-in path and AI must NEVER modify it: no
   *  polish, no classification, no smart tools, and it is excluded from every
   *  AI corpus (ask, insights, merge suggestions, style samples). */
  liked?: boolean;
  /** Where a liked article came from (author / site / URL), exactly as the
   *  user pasted it. Always shown with the article. */
  source?: string;
  /** Attributions accumulated by manual merges: every liked article a merge
   *  consumed contributes its source (or its title) here, permanently. */
  sources?: string[];
  /** Id of this song's audio file in the «أفكاري — الأغاني» folder on Google
   *  Drive, once the recording has been backed up there. The blob itself is
   *  never an idea field — this id is how another device finds its copy. */
  driveFileId?: string;
  /** True when the user pinned this article by hand: it sorts to the top of
   *  its topic group in the library. Display metadata only — like the topic
   *  pin it never bumps `updatedAt`, and no AI pass reads or writes it. */
  pinned?: boolean;
  /** True when the article belongs to the «القسم الطبي» — a section entirely
   *  its own: the main library never shows it, the medical view shows ONLY
   *  it, and the home surfaces (archive card, recorder destination) keep the
   *  two apart. Section membership is metadata, not a text edit — like the
   *  pins it never bumps `updatedAt`. A song is never a medical article:
   *  song ideas never carry this flag. */
  medical?: boolean;
  /** Name of the project this article belongs to (a book, a lecture
   *  series, a topic file) — organizational metadata the user assigns by
   *  hand, exactly like the topic pin: it never bumps `updatedAt` and no
   *  AI pass reads or writes it. Projects are DERIVED from assignments
   *  (there is no project registry) and are partition-scoped: a project
   *  is identified by (section, name), so the same name in the general
   *  library and in the medical section names two different projects.
   *  Optional — most articles belong to no project. Songs never carry
   *  one (a recording is not project material). */
  project?: string;
  /** Frozen pre-AI copies of this article's text, newest first (see
   *  IdeaVersion). Own articles only: a song's text is its lyrics and a
   *  liked article is never AI-touched, so neither ever grows a history. */
  versions?: IdeaVersion[];
};

/** At most this many snapshots are kept per article — the newest ones. */
export const MAX_VERSIONS = 5;

const VERSION_SOURCES: readonly string[] = ["improve", "clean", "merge", "restore"];

/** Newest first, capped at MAX_VERSIONS. */
export function capVersions(versions: IdeaVersion[]): IdeaVersion[] {
  return [...versions].sort((a, b) => b.at - a.at).slice(0, MAX_VERSIONS);
}

/**
 * Prepend a snapshot (storage is newest-first). A snapshot identical to
 * the newest existing one — same text and title — is skipped: that exact
 * state is already frozen, and a duplicate would only push older, still
 * distinct snapshots out of the cap.
 */
export function addVersion(versions: IdeaVersion[] | undefined, entry: IdeaVersion): IdeaVersion[] {
  const list = versions ?? [];
  const newest = list[0];
  if (newest && newest.text === entry.text && (newest.title ?? "") === (entry.title ?? "")) return list;
  return capVersions([entry, ...list]);
}

/**
 * Validate untrusted version data (backup files, cloud rows, Drive files)
 * into clean IdeaVersion entries. Anything malformed — bad timestamp,
 * non-string or empty text, unknown source — is dropped, never guessed.
 */
export function parseVersions(raw: unknown): IdeaVersion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: IdeaVersion[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const e = v as { at?: unknown; text?: unknown; title?: unknown; source?: unknown };
    if (typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
    if (typeof e.text !== "string" || !e.text) continue;
    if (typeof e.source !== "string" || !VERSION_SOURCES.includes(e.source)) continue;
    out.push({
      at: e.at, text: e.text, source: e.source as VersionSource,
      ...(typeof e.title === "string" && e.title.trim() ? { title: e.title } : {}),
    });
  }
  return out.length ? capVersions(out) : undefined;
}

export const TOPICS: Record<string, string[]> = {
  "الإيمان والروح": ["الله", "صلاة", "دين", "إيمان", "قرآن", "دعاء", "رمضان", "الجنة", "روح"],
  "العمل والنجاح": ["عمل", "شغل", "وظيفة", "مشروع", "نجاح", "إدارة", "فريق", "شركة", "هدف", "إنتاجية"],
  "الأسرة والعلاقات": ["أسرة", "عائلة", "زوج", "زوجة", "أولاد", "ابن", "بنت", "أب", "أم", "صديق", "أصدقاء", "حب"],
  "الصحة": ["صحة", "رياضة", "نوم", "أكل", "طعام", "مرض", "جسم", "مشي", "رجيم"],
  "المال": ["مال", "فلوس", "استثمار", "ادخار", "راتب", "تجارة", "سعر", "ربح"],
  "التقنية": ["تقنية", "ذكاء", "برنامج", "تطبيق", "هاتف", "إنترنت", "كمبيوتر", "برمجة"],
  "النفس والتأمل": ["نفس", "شعور", "حزن", "سعادة", "قلق", "خوف", "تفكير", "حياة", "صبر", "أمل"],
  "المجتمع": ["مجتمع", "ناس", "وطن", "تعليم", "مدرسة", "ثقافة", "سياسة"],
};
export const OTHER = "متفرقات";

const strip = (s: string) => s.replace(/[\u064B-\u0652]/g, "").replace(/[أإآ]/g, "ا");

export function classify(text: string): string {
  const t = strip(text);
  let best = OTHER, score = 0;
  for (const [topic, words] of Object.entries(TOPICS)) {
    const n = words.filter((w) => {
      const word = strip(w);
      return word.length > 2 ? t.includes(word) : new RegExp(`(^|\\s)(ال)?${word}(?=\\s|[،.!؟?]|$)`).test(t);
    }).length;
    if (n > score) { score = n; best = topic; }
  }
  return best;
}

const FILLERS = /(^|\s)(اممم+|امم|آآ+|ااا+|ممم+|يعني يعني|اه اه)(?=\s|$)/g;

export function toArticle(text: string): { title: string; paragraphs: string[] } {
  const clean = text.replace(FILLERS, " ").replace(/\s+/g, " ").trim();
  const sentences = clean.split(/(?<=[.!؟?،])\s+/).filter(Boolean);
  const paragraphs: string[] = [];
  let cur: string[] = [];
  let words = 0;
  for (const s of sentences) {
    cur.push(s);
    words += s.split(" ").length;
    if (words >= 35) { paragraphs.push(cur.join(" ")); cur = []; words = 0; }
  }
  if (cur.length) paragraphs.push(cur.join(" "));
  const fixed = paragraphs.map((p) => (/[.!؟?]$/.test(p) ? p : p.replace(/[،,]$/, "") + "."));
  const title = clean.split(" ").slice(0, 6).join(" ").replace(/[.،,!؟?]+$/, "");
  return { title: title || "فكرة", paragraphs: fixed };
}

const KEY = "afkari.ideas";
const DEL_KEY = "afkari.deleted";

export const loadIdeas = (): Idea[] => {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
};
export const replaceIdeas = (all: Idea[]) => localStorage.setItem(KEY, JSON.stringify(all));

export function getArticle(idea: Idea): { title: string; body: string } {
  const local = toArticle(idea.text);
  return {
    title: idea.articleTitle ?? local.title,
    body: idea.articleBody ?? local.paragraphs.join("\n\n"),
  };
}

export function matchesArticle(idea: Idea, query: string): boolean {
  const article = getArticle(idea);
  const normalized = strip(query).trim().toLocaleLowerCase();
  return !normalized || strip(`${article.title}\n${article.body}\n${idea.text}`).toLocaleLowerCase().includes(normalized);
}

/**
 * The single write point where an existing article's text is replaced.
 * When `snapshotSource` names the AI (or restore) operation doing the
 * replacing, the article's CURRENT text is frozen into its version
 * history first — atomically, in the same write — so no AI pass can ever
 * destroy a text that exists nowhere else. Manual saves pass no source
 * and are never snapshotted. Songs and liked articles are ineligible:
 * their text is never AI-replaced in the first place.
 */
export function updateArticle(id: string, title: string, body: string, polished = false, snapshotSource?: VersionSource): Idea | undefined {
  if (!title.trim() || !body.trim()) return;
  const all = loadIdeas();
  const current = all.find((idea) => idea.id === id);
  if (!current) return;
  const updated: Idea = {
    ...current,
    articleTitle: title.trim(),
    articleBody: body.trim(),
    updatedAt: Math.max(Date.now(), (current.updatedAt ?? 0) + 1),
  };
  if (snapshotSource && !current.song && !current.liked) {
    const before = getArticle(current);
    // Nothing to protect when the "replacement" changes neither title nor body.
    if (before.title !== title.trim() || before.body !== body.trim()) {
      updated.versions = addVersion(current.versions, {
        // Strictly increasing timestamps keep same-millisecond snapshots distinct.
        at: Math.max(Date.now(), (current.versions?.[0]?.at ?? 0) + 1),
        text: before.body,
        title: before.title,
        source: snapshotSource,
      });
    }
  }
  if (polished && updated.updatedAt !== undefined) updated.aiPolishedAt = updated.updatedAt; else delete updated.aiPolishedAt;
  replaceIdeas(all.map((idea) => idea.id === id ? updated : idea));
  return updated;
}

/**
 * Bring back a frozen version: the article's text (and title, when the
 * entry carries one) becomes the version's. The pre-restore text is
 * itself snapshotted first (source 'restore') through the same write
 * point, so a restore is never a one-way door either.
 */
export function restoreVersion(id: string, at: number): Idea | undefined {
  const current = loadIdeas().find((idea) => idea.id === id);
  if (!current || current.song || current.liked) return;
  const entry = (current.versions ?? []).find((v) => v.at === at);
  if (!entry || !entry.text.trim()) return;
  const title = entry.title?.trim() ? entry.title : getArticle(current).title;
  return updateArticle(id, title, entry.text, false, "restore");
}

/**
 * The safety net an AI merge leaves behind: each consumed source's full
 * article text, frozen as a 'merge' version on the merged article and
 * labelled with the source's title — built BEFORE the sources are
 * deleted. Storage is newest-first, so the first source lists first.
 */
export function mergeSourceVersions(sources: Idea[], now = Date.now()): IdeaVersion[] {
  const entries: IdeaVersion[] = [];
  sources.forEach((s, idx) => {
    const a = getArticle(s);
    if (!a.body.trim()) return;
    entries.push({ at: now - idx, text: a.body, title: a.title, source: "merge" });
  });
  return capVersions(entries);
}

/** Merge editions without overwriting newer local work; deletion always wins. */
export function mergeIdeas(local: Idea[], remote: Idea[], deleted: string[]): Idea[] {
  const tombstones = new Set(deleted);
  const merged = new Map(local.filter((i) => !tombstones.has(i.id)).map((i) => [i.id, i]));
  for (const idea of remote) {
    if (tombstones.has(idea.id)) continue;
    const existing = merged.get(idea.id);
    if (!existing) { merged.set(idea.id, idea); continue; }
    let winner = (idea.updatedAt ?? 0) > (existing.updatedAt ?? 0) ? idea : existing;
    const loser = winner === idea ? existing : idea;
    const localWon = winner === existing;
    // A hand-pinned topic is metadata a text edition must not silently erase: it rides
    // onto the winning edition unless that edition carries a pin of its own.
    if (!winner.topicManual && loser.topicManual && loser.topic) winner = { ...winner, topic: loser.topic, topicManual: true };
    // Same for the song flag: an edition that lacks it must not un-song the winner,
    // and a winner without the recording's length adopts the loser's.
    if (!winner.song && loser.song) {
      winner = { ...winner, song: true, ...(winner.songDuration === undefined && loser.songDuration !== undefined ? { songDuration: loser.songDuration } : {}) };
    } else if (winner.song && winner.songDuration === undefined && loser.songDuration !== undefined) {
      winner = { ...winner, songDuration: loser.songDuration };
    }
    // A liked article is liked on every device: an edition that lacks the flag
    // (or the attribution) must not un-like the winner or lose where it came from.
    if (!winner.liked && loser.liked) winner = { ...winner, liked: true };
    if (!winner.source && loser.source) winner = { ...winner, source: loser.source };
    if (winner.sources?.length || loser.sources?.length) {
      const union = [...new Set([...(winner.sources ?? []), ...(loser.sources ?? [])])];
      if (union.join("\n") !== (winner.sources ?? []).join("\n")) winner = { ...winner, sources: union };
    }
    // A Drive copy is metadata like the pin: an edition that lacks the file id
    // must not orphan the winner's backed-up recording.
    if (!winner.driveFileId && loser.driveFileId) winner = { ...winner, driveFileId: loser.driveFileId };
    // The library pin is metadata too: an edition that lacks it must not
    // silently unpin the winner.
    if (!winner.pinned && loser.pinned) winner = { ...winner, pinned: true };
    // Section membership is metadata as well: an edition that lacks the
    // medical flag must not pull the winner out of the medical section.
    if (!winner.medical && loser.medical) winner = { ...winner, medical: true };
    // Project assignment is hand-set metadata too: an edition that lacks
    // a project must not silently un-file the winner. When BOTH editions
    // carry a project the winner keeps its own — assignments are never
    // merged across names.
    if (!winner.project && loser.project) winner = { ...winner, project: loser.project };
    // Version history is a union, never a contest: snapshots frozen on
    // EITHER edition survive (deduped by timestamp), the cap applied
    // after the union — a sync must never throw away a frozen text.
    if (winner.versions?.length || loser.versions?.length) {
      const byAt = new Map<number, IdeaVersion>();
      for (const v of loser.versions ?? []) byAt.set(v.at, v);
      for (const v of winner.versions ?? []) byAt.set(v.at, v);
      const union = capVersions([...byAt.values()]);
      if (JSON.stringify(union) !== JSON.stringify(winner.versions ?? [])) winner = { ...winner, versions: union };
    }
    // As before: a local winner that was never polished adopts the remote polish stamp.
    if (localWon && winner.aiPolishedAt === undefined && idea.aiPolishedAt !== undefined) winner = { ...winner, aiPolishedAt: idea.aiPolishedAt };
    merged.set(idea.id, winner);
  }
  return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
}

// Ids deleted on this device — used to propagate offline deletions to the cloud backup.
export const loadDeleted = (): string[] => {
  try { return JSON.parse(localStorage.getItem(DEL_KEY) || "[]"); } catch { return []; }
};
export const clearDeleted = (ids: string[]) =>
  localStorage.setItem(DEL_KEY, JSON.stringify(loadDeleted().filter((d) => !ids.includes(d))));
/** Record deletions that arrived from another backup so the cloud copy is removed too. */
export const markDeleted = (ids: string[]) => {
  const del = loadDeleted();
  localStorage.setItem(DEL_KEY, JSON.stringify([...new Set([...del, ...ids])]));
};

// Google Drive keeps its own pending lists, cleared only after a successful Drive sync.
const DRIVE_DEL_KEY = "afkari.driveDeleted";
const DRIVE_REVIVED_KEY = "afkari.driveRevived";
const readList = (key: string): string[] => {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
};
const writeList = (key: string, ids: string[]) => localStorage.setItem(key, JSON.stringify([...new Set(ids)]));
export const loadDriveDeleted = () => readList(DRIVE_DEL_KEY);
export const loadDriveRevived = () => readList(DRIVE_REVIVED_KEY);
/** Deleted elsewhere (cloud record): the Drive file must learn about it too. */
export const markDriveDeleted = (ids: string[]) => writeList(DRIVE_DEL_KEY, [...loadDriveDeleted(), ...ids]);
// Restored ideas whose cloud deletion record must be lifted on the next cloud sync.
const CLOUD_REVIVED_KEY = "afkari.cloudRevived";
export const loadCloudRevived = () => readList(CLOUD_REVIVED_KEY);
export const clearCloudRevived = (ids: string[]) => writeList(CLOUD_REVIVED_KEY, loadCloudRevived().filter((d) => !ids.includes(d)));
/** A restore brings ideas back everywhere, including ones deleted on another device. */
export const markRevived = (ids: string[]) => {
  writeList(DRIVE_REVIVED_KEY, [...loadDriveRevived(), ...ids]);
  writeList(CLOUD_REVIVED_KEY, [...loadCloudRevived(), ...ids]);
  writeList(DRIVE_DEL_KEY, loadDriveDeleted().filter((d) => !ids.includes(d)));
};
export const clearDriveMarks = (deleted: string[], revived: string[]) => {
  writeList(DRIVE_DEL_KEY, loadDriveDeleted().filter((d) => !deleted.includes(d)));
  writeList(DRIVE_REVIVED_KEY, loadDriveRevived().filter((d) => !revived.includes(d)));
};

export const saveIdea = (text: string, opts?: { medical?: boolean }): Idea => {
  const all = loadIdeas();
  const idea: Idea = { id: crypto.randomUUID(), text, createdAt: Date.now() };
  // The recorder's medical context: an idea dictated/written while the
  // «القسم الطبي» chip is up is born inside the medical section.
  if (opts?.medical) idea.medical = true;
  all.unshift(idea);
  localStorage.setItem(KEY, JSON.stringify(all));
  return idea;
};
export const deleteIdea = (id: string) => {
  localStorage.setItem(KEY, JSON.stringify(loadIdeas().filter((i) => i.id !== id)));
  const del = loadDeleted();
  if (!del.includes(id)) localStorage.setItem(DEL_KEY, JSON.stringify([...del, id]));
  writeList(DRIVE_DEL_KEY, [...loadDriveDeleted(), id]);
  writeList(DRIVE_REVIVED_KEY, loadDriveRevived().filter((d) => d !== id));
};

/** The topic an article is filed under: the user's hand-set topic while pinned, otherwise the keyword classification of its body. */
export function articleTopic(idea: Idea): string {
  if (idea.topicManual && idea.topic?.trim()) return idea.topic;
  return classify(getArticle(idea).body);
}

/**
 * Pin an article to a topic by hand. This is metadata, not a text edit, so `updatedAt`
 * is left alone (the AI label versioned by it stays valid and keeps its tags).
 * Choosing the topic the article already sits under is a no-op — it does not set the pin.
 */
export function setArticleTopic(id: string, topic: string): Idea | undefined {
  const next = topic.trim();
  if (!next) return;
  const all = loadIdeas();
  const current = all.find((idea) => idea.id === id);
  if (!current) return;
  if (articleTopic(current) === next) return current;
  const updated: Idea = { ...current, topic: next, topicManual: true };
  replaceIdeas(all.map((idea) => (idea.id === id ? updated : idea)));
  return updated;
}

/** Hand the article back to automatic classification: the pin is removed, the topic is derived again. */
export function clearArticleTopic(id: string): Idea | undefined {
  const all = loadIdeas();
  const current = all.find((idea) => idea.id === id);
  if (!current || !current.topicManual) return current;
  const updated: Idea = { ...current };
  delete updated.topic;
  delete updated.topicManual;
  replaceIdeas(all.map((idea) => (idea.id === id ? updated : idea)));
  return updated;
}

/**
 * Pin or unpin an article by hand. This is display metadata, not a text edit,
 * so `updatedAt` is left alone (exactly like the topic pin). Setting the state
 * the article already has is a no-op.
 */
export function setPinned(id: string, pinned: boolean): Idea | undefined {
  const all = loadIdeas();
  const current = all.find((idea) => idea.id === id);
  if (!current) return;
  if (!!current.pinned === pinned) return current;
  const updated: Idea = { ...current };
  if (pinned) updated.pinned = true; else delete updated.pinned;
  replaceIdeas(all.map((idea) => (idea.id === id ? updated : idea)));
  return updated;
}

/** Pinned articles first, everything else in its existing order (stable). */
export function sortWithPinnedFirst(list: Idea[]): Idea[] {
  return [...list].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
}

/**
 * Move an article into or out of the «القسم الطبي». This is section
 * membership, not a text edit, so `updatedAt` is left alone (exactly like
 * the pins). Setting the state the article already has is a no-op. A song
 * is never a medical article — the flag is refused for songs outright.
 */
export function setMedical(id: string, medical: boolean): Idea | undefined {
  const all = loadIdeas();
  const current = all.find((idea) => idea.id === id);
  if (!current) return;
  if (current.song) return current;
  if (!!current.medical === medical) return current;
  const updated: Idea = { ...current };
  if (medical) updated.medical = true; else delete updated.medical;
  replaceIdeas(all.map((idea) => (idea.id === id ? updated : idea)));
  return updated;
}

/**
 * File an article under a project (or take it out with `null`). This is
 * organizational metadata, not a text edit, so `updatedAt` is left alone
 * (exactly like the pins). Names are trimmed; an empty name clears the
 * assignment. Setting the assignment the article already has is a no-op.
 */
export function setProject(id: string, name: string | null): Idea | undefined {
  const all = loadIdeas();
  const current = all.find((idea) => idea.id === id);
  if (!current) return;
  const next = (name ?? "").trim();
  if ((current.project ?? "") === next) return current;
  const updated: Idea = { ...current };
  if (next) updated.project = next; else delete updated.project;
  replaceIdeas(all.map((idea) => (idea.id === id ? updated : idea)));
  return updated;
}

/** Every project currently in use in the given list, with its article
 *  count, busiest first — derived from assignments, like topicOptions.
 *  Callers pass ONE partition's ideas, so the list is that section's
 *  projects only. */
export function projectOptions(ideas: Idea[]): { project: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const idea of ideas) {
    const name = idea.project?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project, "ar"));
}

/**
 * Rename a project inside ONE partition: every member's assignment moves
 * to the new name (bulk setProject over that section's members only —
 * the other section's same-named project is a different project and is
 * never touched). Renaming onto a name that already exists in the
 * partition merges the two projects, exactly as assigning an article to
 * an existing project would. Metadata only — no `updatedAt` moves.
 * Returns how many articles were renamed (0 for a no-op).
 */
export function renameProject(medical: boolean, from: string, to: string): number {
  const target = to.trim();
  if (!target || target === from) return 0;
  const all = loadIdeas();
  let n = 0;
  const next = all.map((idea) => {
    if (!!idea.medical === medical && idea.project === from) { n++; return { ...idea, project: target }; }
    return idea;
  });
  if (n) replaceIdeas(next);
  return n;
}

/**
 * Dissolve a project inside ONE partition: all its members are simply
 * unassigned — the articles themselves are never touched. Returns how
 * many articles were unassigned.
 */
export function clearProject(medical: boolean, name: string): number {
  const all = loadIdeas();
  let n = 0;
  const next = all.map((idea) => {
    if (!!idea.medical === medical && idea.project === name) {
      n++;
      const updated = { ...idea };
      delete updated.project;
      return updated;
    }
    return idea;
  });
  if (n) replaceIdeas(next);
  return n;
}

/** The two library partitions: the medical section and everything else.
 *  Every surface reads exactly one side — the main library the `main`
 *  side, the medical view the `medical` side — so an article can never
 *  appear in both. */
export function partitionIdeas(ideas: Idea[]): { main: Idea[]; medical: Idea[] } {
  const main: Idea[] = [];
  const medical: Idea[] = [];
  for (const idea of ideas) (idea.medical ? medical : main).push(idea);
  return { main, medical };
}

/** Every topic currently in use, with its article count, busiest first — the manual picker's list. */
export function topicOptions(ideas: Idea[]): { topic: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const idea of ideas) {
    const t = articleTopic(idea);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic, "ar"));
}

/** A liked article is someone else's text: the AI polish must never run on it. */
export const needsPolish = (idea: Idea) => !idea.liked && (idea.aiPolishedAt === undefined || idea.aiPolishedAt < (idea.updatedAt ?? 0));

/** Save a ready article (e.g. a merge) as a new idea; `text` keeps the combined originals. */
export const saveArticleIdea = (text: string, title: string, body: string, mergedFrom?: string[], extra?: { liked?: boolean; source?: string; sources?: string[]; medical?: boolean; versions?: IdeaVersion[] }): Idea => {
  const now = Date.now();
  const idea: Idea = { id: crypto.randomUUID(), text, createdAt: now, articleTitle: title.trim(), articleBody: body.trim(), updatedAt: now, aiPolishedAt: now };
  if (mergedFrom?.length) idea.mergedFrom = [...new Set(mergedFrom)];
  // An AI merge that consumes its sources carries their frozen texts as
  // its version history (built by mergeSourceVersions before deletion).
  if (extra?.versions?.length) idea.versions = capVersions(extra.versions);
  if (extra?.liked) idea.liked = true;
  // A merge stays in the section its articles lived in (manual-merge
  // partners are partition-scoped, so the section is unambiguous).
  if (extra?.medical) idea.medical = true;
  if (extra?.source?.trim()) idea.source = extra.source.trim();
  if (extra?.sources?.length) idea.sources = [...new Set(extra.sources.map((s) => s.trim()).filter(Boolean))];
  replaceIdeas([idea, ...loadIdeas()]);
  return idea;
};

/**
 * Save an article the user liked elsewhere, pasted in by hand. The pasted
 * body is kept verbatim as both the original text and the article body —
 * no derivation, no polish, no AI pass of any kind runs on it, ever.
 */
export const saveLikedArticle = (title: string, source: string, body: string): Idea | undefined => {
  if (!title.trim() || !body.trim()) return;
  const now = Date.now();
  const idea: Idea = {
    id: crypto.randomUUID(), text: body.trim(), createdAt: now,
    articleTitle: title.trim(), articleBody: body.trim(), updatedAt: now, liked: true,
  };
  if (source.trim()) idea.source = source.trim();
  replaceIdeas([idea, ...loadIdeas()]);
  return idea;
};

/** Every attribution an article carries: its own source first, then the
 *  sources it accumulated from merges. A liked article with neither falls
 *  back to its title — a merge must never leave it unattributed. */
export function attributionsOf(idea: Idea): string[] {
  const out = [...new Set([idea.source, ...(idea.sources ?? [])].map((s) => s?.trim()).filter((s): s is string => !!s))];
  if (!out.length && idea.liked) out.push(getArticle(idea).title);
  return out;
}

/**
 * The attribution outcome of a MANUAL merge (pure; the AI merge path never
 * sees liked articles). The result is `liked` (AI-locked) only when EVERY
 * consumed article was liked. Every consumed liked article contributes its
 * attribution; when the result itself stays liked, the first consumed source
 * remains its primary `source` and the rest ride in `sources`.
 */
export function mergeAttributions(consumed: Idea[]): { liked: boolean; source?: string; sources: string[] } {
  const liked = consumed.length > 0 && consumed.every((i) => i.liked);
  const collected: string[] = [];
  for (const idea of consumed) for (const a of attributionsOf(idea)) if (!collected.includes(a)) collected.push(a);
  if (!liked) return { liked: false, sources: collected };
  const source = consumed.map((i) => i.source?.trim()).find(Boolean);
  return { liked: true, ...(source ? { source } : {}), sources: collected.filter((a) => a !== source) };
}

/**
 * Build (not yet saved) a song idea. The recording is the content; `text`
 * starts empty and later holds the lyrics the user writes by hand.
 */
export const buildSongIdea = (input: { id?: string; title: string; durationSeconds?: number; createdAt?: number }): Idea => {
  const now = input.createdAt ?? Date.now();
  const idea: Idea = {
    id: input.id ?? crypto.randomUUID(),
    text: "",
    createdAt: now,
    articleTitle: input.title.trim() || "أغنية",
    song: true,
    updatedAt: now,
  };
  if (input.durationSeconds && input.durationSeconds > 0) idea.songDuration = Math.round(input.durationSeconds);
  return idea;
};

/**
 * Save a song's title and lyrics. Unlike `updateArticle` this edits `text`
 * itself — for a song the text IS the lyrics — and empty lyrics are allowed
 * (a song can exist before its words are written down). Songs only: any
 * articleBody a song somehow carries is dropped so the lyrics stay the
 * single source the article view derives from.
 */
export function updateSong(id: string, title: string, lyrics: string): Idea | undefined {
  const all = loadIdeas();
  const current = all.find((idea) => idea.id === id);
  if (!current || !current.song) return;
  const updated: Idea = {
    ...current,
    text: lyrics,
    updatedAt: Math.max(Date.now(), (current.updatedAt ?? 0) + 1),
  };
  if (title.trim()) updated.articleTitle = title.trim();
  delete updated.articleBody;
  delete updated.aiPolishedAt;
  replaceIdeas(all.map((idea) => (idea.id === id ? updated : idea)));
  return updated;
};
