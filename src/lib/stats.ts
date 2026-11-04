// «إحصائياتي» — the Settings stats section's numbers.
//
// Pure derivations over the VISIBLE ideas list (the caller feeds
// pending-deletes.loadVisibleIdeas, so an idea inside its undo window is
// never counted). Everything comes from stored fields — createdAt, the
// article body, the topic derivation and the kind flags — so there is
// nothing new to persist, sync or back up: the same list anywhere yields
// the same numbers.
import { articleTopic, getArticle, type Idea } from "./ideas";

/** Words in a text, counted exactly the way the article editor counts
 *  them («عدد الكلمات»): whitespace-separated tokens. */
export const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export type TopicCount = { topic: string; count: number };

export type LibraryStats = {
  /** Own articles (not songs, not liked) created in now's calendar month. */
  monthArticles: number;
  /** Words across those articles' bodies, editor-style counting. */
  monthWords: number;
  /** Own writing overall: not songs, not liked (medical included). */
  articles: number;
  songs: number;
  liked: number;
  /** Ideas filed in «القسم الطبي» (the medical flag, whatever else they are). */
  medical: number;
  /** The three most-written-about topics among own articles. */
  topTopics: TopicCount[];
  /** Consecutive creation days ending today — or yesterday, so a streak
   *  does not read 0 in the morning before anything is written. */
  currentStreak: number;
  longestStreak: number;
};

/** His own writing: a song is a recording and a liked article is someone
 *  else's words — neither counts as an article he wrote. */
const isArticle = (idea: Idea): boolean => !idea.song && !idea.liked;

const DAY_MS = 86_400_000;

/** Serial number of the LOCAL calendar day a timestamp falls on.
 *  Serializing the local (year, month, day) through UTC keeps daylight
 *  shifts from ever merging two days or splitting one. */
const daySerial = (ts: number): number => {
  const d = new Date(ts);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
};

/** Streaks run over EVERY visible idea's creation day — a recorded song
 *  or a saved article alike marks a day he created something here. */
function streaks(ideas: Idea[], now: number): { currentStreak: number; longestStreak: number } {
  const days = new Set(ideas.map((i) => daySerial(i.createdAt)));
  if (!days.size) return { currentStreak: 0, longestStreak: 0 };
  const sorted = [...days].sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  for (let k = 1; k < sorted.length; k += 1) {
    const prev = sorted[k - 1] ?? 0;
    const cur = sorted[k] ?? prev;
    run = cur === prev + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  // Anchor on today, falling back to yesterday: the streak is only
  // broken once a full day has passed with nothing created.
  let anchor = daySerial(now);
  if (!days.has(anchor)) anchor -= 1;
  let current = 0;
  while (days.has(anchor)) {
    current += 1;
    anchor -= 1;
  }
  return { currentStreak: current, longestStreak: longest };
}

export function computeStats(ideas: Idea[], now = Date.now()): LibraryStats {
  const n = new Date(now);
  const own = ideas.filter(isArticle);
  const thisMonth = own.filter((i) => {
    const d = new Date(i.createdAt);
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
  });
  const monthWords = thisMonth.reduce((sum, i) => sum + countWords(getArticle(i).body), 0);

  const byTopic = new Map<string, number>();
  for (const i of own) {
    const topic = articleTopic(i);
    byTopic.set(topic, (byTopic.get(topic) ?? 0) + 1);
  }
  const topTopics = [...byTopic.entries()]
    .map(([topic, count]) => ({ topic, count }))
    // Most articles first; ties break on the topic name itself so the
    // order is the same on every device and every run.
    .sort((a, b) => b.count - a.count || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))
    .slice(0, 3);

  return {
    monthArticles: thisMonth.length,
    monthWords,
    articles: own.length,
    songs: ideas.filter((i) => i.song).length,
    liked: ideas.filter((i) => i.liked).length,
    medical: ideas.filter((i) => i.medical).length,
    topTopics,
    ...streaks(ideas, now),
  };
}
