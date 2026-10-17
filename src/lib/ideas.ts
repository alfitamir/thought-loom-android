export type Idea = { id: string; text: string; createdAt: number };

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
    const n = words.filter((w) => t.includes(strip(w))).length;
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

// Ids deleted on this device — used to propagate offline deletions to the cloud backup.
export const loadDeleted = (): string[] => {
  try { return JSON.parse(localStorage.getItem(DEL_KEY) || "[]"); } catch { return []; }
};
export const clearDeleted = (ids: string[]) =>
  localStorage.setItem(DEL_KEY, JSON.stringify(loadDeleted().filter((d) => !ids.includes(d))));

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
};
