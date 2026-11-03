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
  /** Id of this song's audio file in the «أفكاري — الأغاني» folder on Google
   *  Drive, once the recording has been backed up there. The blob itself is
   *  never an idea field — this id is how another device finds its copy. */
  driveFileId?: string;
};

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

export function updateArticle(id: string, title: string, body: string, polished = false): Idea | undefined {
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
  if (polished && updated.updatedAt !== undefined) updated.aiPolishedAt = updated.updatedAt; else delete updated.aiPolishedAt;
  replaceIdeas(all.map((idea) => idea.id === id ? updated : idea));
  return updated;
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
    // A Drive copy is metadata like the pin: an edition that lacks the file id
    // must not orphan the winner's backed-up recording.
    if (!winner.driveFileId && loser.driveFileId) winner = { ...winner, driveFileId: loser.driveFileId };
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

export const saveIdea = (text: string): Idea => {
  const all = loadIdeas();
  const idea: Idea = { id: crypto.randomUUID(), text, createdAt: Date.now() };
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

export const needsPolish = (idea: Idea) => idea.aiPolishedAt === undefined || idea.aiPolishedAt < (idea.updatedAt ?? 0);

/** Save a ready article (e.g. a merge) as a new idea; `text` keeps the combined originals. */
export const saveArticleIdea = (text: string, title: string, body: string, mergedFrom?: string[]): Idea => {
  const now = Date.now();
  const idea: Idea = { id: crypto.randomUUID(), text, createdAt: now, articleTitle: title.trim(), articleBody: body.trim(), updatedAt: now, aiPolishedAt: now };
  if (mergedFrom?.length) idea.mergedFrom = [...new Set(mergedFrom)];
  replaceIdeas([idea, ...loadIdeas()]);
  return idea;
};

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
