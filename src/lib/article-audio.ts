// Generated article audio, kept on this device (IndexedDB) so an article
// that was turned into speech once plays instantly next time — and can be
// shared as a file. A cached record counts as fresh only while the article's
// spoken text still hashes to the value it was generated from; editing the
// article makes the old audio stale, never silently wrong.

import { toSpeechText, type TtsEngine } from "./tts";

export type ArticleAudioRecord = {
  /** Composite key: `${articleId}:${engine}:${voiceKey}`. */
  key: string;
  articleId: string;
  engine: TtsEngine;
  voiceKey: string;
  textHash: string;
  mime: string;
  blob: Blob;
  createdAt: number;
};

/** FNV-1a 32-bit hash of the text, as 8 hex chars. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const articleTextHash = (title: string, body: string): string => textHash(toSpeechText(title, body));

export const audioKey = (articleId: string, engine: TtsEngine, voiceKey: string): string =>
  `${articleId}:${engine}:${voiceKey}`;

export const isAudioFresh = (rec: ArticleAudioRecord, title: string, body: string): boolean =>
  rec.textHash === articleTextHash(title, body);

const EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

/** A share/download-safe file name from the article title. */
export function audioFileName(title: string, mime: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return `${clean || "مقال"}.${EXTENSIONS[mime] ?? "audio"}`;
}

export interface ArticleAudioStore {
  get(key: string): Promise<ArticleAudioRecord | null>;
  put(rec: ArticleAudioRecord): Promise<void>;
  remove(key: string): Promise<void>;
  listForArticle(articleId: string): Promise<ArticleAudioRecord[]>;
}

/** In-memory store (tests, or browsers without IndexedDB). */
export function memoryArticleAudioStore(): ArticleAudioStore {
  const map = new Map<string, ArticleAudioRecord>();
  return {
    async get(key) { return map.get(key) ?? null; },
    async put(rec) { map.set(rec.key, rec); },
    async remove(key) { map.delete(key); },
    async listForArticle(articleId) { return [...map.values()].filter((r) => r.articleId === articleId); },
  };
}

const DB = "thought-loom-audio";
const STORE = "article-audio";
const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const store = r.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("articleId", "articleId");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function indexedDbArticleAudioStore(): ArticleAudioStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= openDb());
  const tx = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode);
  const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return {
    async get(key) {
      const t = await tx("readonly");
      return ((await req(t.objectStore(STORE).get(key))) as ArticleAudioRecord | undefined) ?? null;
    },
    async put(rec) { const t = await tx("readwrite"); t.objectStore(STORE).put(rec); await done(t); },
    async remove(key) { const t = await tx("readwrite"); t.objectStore(STORE).delete(key); await done(t); },
    async listForArticle(articleId) {
      const t = await tx("readonly");
      return (await req(t.objectStore(STORE).index("articleId").getAll(articleId))) as ArticleAudioRecord[];
    },
  };
}

let shared: ArticleAudioStore | null = null;
export const articleAudioStore = (): ArticleAudioStore =>
  (shared ??= typeof indexedDB !== "undefined" ? indexedDbArticleAudioStore() : memoryArticleAudioStore());

export function getCachedAudio(
  articleId: string, engine: TtsEngine, voiceKey: string,
  store: ArticleAudioStore = articleAudioStore(),
): Promise<ArticleAudioRecord | null> {
  return store.get(audioKey(articleId, engine, voiceKey));
}

export async function saveArticleAudio(
  input: { articleId: string; engine: TtsEngine; voiceKey: string; title: string; body: string; blob: Blob },
  store: ArticleAudioStore = articleAudioStore(),
): Promise<ArticleAudioRecord> {
  const rec: ArticleAudioRecord = {
    key: audioKey(input.articleId, input.engine, input.voiceKey),
    articleId: input.articleId,
    engine: input.engine,
    voiceKey: input.voiceKey,
    textHash: articleTextHash(input.title, input.body),
    mime: input.blob.type || "audio/wav",
    blob: input.blob,
    createdAt: Date.now(),
  };
  await store.put(rec);
  return rec;
}

/** Delete one engine's audio for an article, or all of it when engine is omitted. */
export async function deleteArticleAudio(
  articleId: string, engine?: TtsEngine, voiceKey?: string,
  store: ArticleAudioStore = articleAudioStore(),
): Promise<void> {
  if (engine && voiceKey) { await store.remove(audioKey(articleId, engine, voiceKey)); return; }
  const all = await store.listForArticle(articleId);
  await Promise.all(all.filter((r) => !engine || r.engine === engine).map((r) => store.remove(r.key)));
}
