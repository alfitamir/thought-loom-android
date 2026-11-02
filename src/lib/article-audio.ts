// Generated article audio, kept on this device (IndexedDB) so an article
// that was turned into speech once plays instantly next time — and can be
// shared as a file. A cached record counts as fresh only while the article's
// spoken text still hashes to the value it was generated from; editing the
// article makes the old audio stale, never silently wrong.
//
// Two storage formats share one store:
// - v1 (legacy, written by the first listen release): one record per article
//   holding a single combined WAV blob in `blob`.
// - v2 (current): a manifest record plus one record per synthesized chunk
//   holding raw PCM, so chunks can be cached as they are generated, played
//   progressively, and completed later; sharing concatenates them back into
//   one WAV. New generations always write v2; v1 records stay playable and
//   shareable until replaced.

import { GEMINI_TTS_SAMPLE_RATE, toSpeechText, type TtsEngine } from "./tts";

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

/** v2 manifest: describes a chunked generation; the audio lives in chunk records. */
export type ChunkedAudioManifest = {
  /** Same composite key as a legacy record: `${articleId}:${engine}:${voiceKey}`. */
  key: string;
  articleId: string;
  engine: TtsEngine;
  voiceKey: string;
  textHash: string;
  version: 2;
  format: "pcm-chunks";
  sampleRate: number;
  chunkCount: number;
  createdAt: number;
};

/** One generated chunk of raw PCM, keyed `${audioKey}#${index}`. */
export type AudioChunkRecord = {
  key: string;
  articleId: string;
  engine: TtsEngine;
  voiceKey: string;
  index: number;
  mime: string;
  blob: Blob;
  createdAt: number;
};

export type StoredAudioRecord = ArticleAudioRecord | ChunkedAudioManifest | AudioChunkRecord;

/** Chunk payloads are raw 16-bit PCM, exactly as Gemini TTS returns them. */
export const PCM_CHUNK_MIME = "audio/L16";

export const chunkKey = (baseKey: string, index: number): string => `${baseKey}#${index}`;

export const isChunkedManifest = (rec: StoredAudioRecord): rec is ChunkedAudioManifest =>
  (rec as ChunkedAudioManifest).version === 2 && (rec as ChunkedAudioManifest).format === "pcm-chunks";

export const isAudioChunk = (rec: StoredAudioRecord): rec is AudioChunkRecord =>
  typeof (rec as AudioChunkRecord).index === "number" && "blob" in rec;

export const isLegacyAudio = (rec: StoredAudioRecord): rec is ArticleAudioRecord =>
  !isChunkedManifest(rec) && !isAudioChunk(rec);

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

export const isManifestFresh = (manifest: ChunkedAudioManifest, title: string, body: string): boolean =>
  manifest.textHash === articleTextHash(title, body);

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
  get(key: string): Promise<StoredAudioRecord | null>;
  put(rec: StoredAudioRecord): Promise<void>;
  remove(key: string): Promise<void>;
  listForArticle(articleId: string): Promise<StoredAudioRecord[]>;
}

/** In-memory store (tests, or browsers without IndexedDB). */
export function memoryArticleAudioStore(): ArticleAudioStore {
  const map = new Map<string, StoredAudioRecord>();
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
      return ((await req(t.objectStore(STORE).get(key))) as StoredAudioRecord | undefined) ?? null;
    },
    async put(rec) { const t = await tx("readwrite"); t.objectStore(STORE).put(rec); await done(t); },
    async remove(key) { const t = await tx("readwrite"); t.objectStore(STORE).delete(key); await done(t); },
    async listForArticle(articleId) {
      const t = await tx("readonly");
      return (await req(t.objectStore(STORE).index("articleId").getAll(articleId))) as StoredAudioRecord[];
    },
  };
}

let shared: ArticleAudioStore | null = null;
export const articleAudioStore = (): ArticleAudioStore =>
  (shared ??= typeof indexedDB !== "undefined" ? indexedDbArticleAudioStore() : memoryArticleAudioStore());

/** What is cached for one article + engine, in either storage format. */
export type CachedAudio =
  | { kind: "legacy"; record: ArticleAudioRecord; blob: Blob; fresh: boolean }
  | { kind: "chunks"; manifest: ChunkedAudioManifest; readyIndexes: number[]; fresh: boolean };

/**
 * Look up the cached audio for an article and engine. Legacy v1 records come
 * back as one ready blob; v2 records as their manifest plus the chunk indexes
 * already on the device (a partial generation is resumable from exactly
 * those indexes). `fresh` compares the stored hash against the article's
 * current spoken text.
 */
export async function getCachedAudio(
  articleId: string, engine: TtsEngine, voiceKey: string, title: string, body: string,
  store: ArticleAudioStore = articleAudioStore(),
): Promise<CachedAudio | null> {
  const rec = await store.get(audioKey(articleId, engine, voiceKey));
  if (!rec) return null;
  if (isChunkedManifest(rec)) {
    return {
      kind: "chunks",
      manifest: rec,
      readyIndexes: await listReadyChunks(articleId, engine, voiceKey, store),
      fresh: isManifestFresh(rec, title, body),
    };
  }
  if (isAudioChunk(rec)) return null; // a chunk key was passed, not a base key
  return { kind: "legacy", record: rec, blob: rec.blob, fresh: isAudioFresh(rec, title, body) };
}

/** Sorted indexes of the chunks of one generation that are on this device. */
export async function listReadyChunks(
  articleId: string, engine: TtsEngine, voiceKey: string,
  store: ArticleAudioStore = articleAudioStore(),
): Promise<number[]> {
  const all = await store.listForArticle(articleId);
  return all
    .filter((r): r is AudioChunkRecord => isAudioChunk(r) && r.engine === engine && r.voiceKey === voiceKey)
    .map((r) => r.index)
    .sort((a, b) => a - b);
}

/** Write (or replace) the v2 manifest for a generation of chunkCount chunks. */
export async function saveAudioManifest(
  input: {
    articleId: string; engine: TtsEngine; voiceKey: string; title: string; body: string;
    chunkCount: number; sampleRate?: number;
  },
  store: ArticleAudioStore = articleAudioStore(),
): Promise<ChunkedAudioManifest> {
  const manifest: ChunkedAudioManifest = {
    key: audioKey(input.articleId, input.engine, input.voiceKey),
    articleId: input.articleId,
    engine: input.engine,
    voiceKey: input.voiceKey,
    textHash: articleTextHash(input.title, input.body),
    version: 2,
    format: "pcm-chunks",
    sampleRate: input.sampleRate ?? GEMINI_TTS_SAMPLE_RATE,
    chunkCount: input.chunkCount,
    createdAt: Date.now(),
  };
  await store.put(manifest);
  return manifest;
}

export async function getAudioManifest(
  articleId: string, engine: TtsEngine, voiceKey: string,
  store: ArticleAudioStore = articleAudioStore(),
): Promise<ChunkedAudioManifest | null> {
  const rec = await store.get(audioKey(articleId, engine, voiceKey));
  return rec && isChunkedManifest(rec) ? rec : null;
}

/** Save one chunk's raw PCM as soon as it has been synthesized. */
export async function saveAudioChunk(
  input: { articleId: string; engine: TtsEngine; voiceKey: string; index: number; pcm: Blob },
  store: ArticleAudioStore = articleAudioStore(),
): Promise<void> {
  const base = audioKey(input.articleId, input.engine, input.voiceKey);
  await store.put({
    key: chunkKey(base, input.index),
    articleId: input.articleId,
    engine: input.engine,
    voiceKey: input.voiceKey,
    index: input.index,
    mime: PCM_CHUNK_MIME,
    blob: input.pcm,
    createdAt: Date.now(),
  });
}

/** One chunk's raw PCM blob, or null when that chunk was never generated. */
export async function getAudioChunk(
  articleId: string, engine: TtsEngine, voiceKey: string, index: number,
  store: ArticleAudioStore = articleAudioStore(),
): Promise<Blob | null> {
  const rec = await store.get(chunkKey(audioKey(articleId, engine, voiceKey), index));
  return rec && isAudioChunk(rec) ? rec.blob : null;
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

/**
 * Delete one engine's audio for an article, or all of it when engine is
 * omitted. For a specific engine + voice this removes the manifest (or the
 * legacy record) AND every chunk record belonging to it.
 */
export async function deleteArticleAudio(
  articleId: string, engine?: TtsEngine, voiceKey?: string,
  store: ArticleAudioStore = articleAudioStore(),
): Promise<void> {
  const all = await store.listForArticle(articleId);
  const doomed = all.filter((r) => {
    if (engine && voiceKey) {
      const base = audioKey(articleId, engine, voiceKey);
      return r.key === base || r.key.startsWith(`${base}#`);
    }
    return !engine || r.engine === engine;
  });
  await Promise.all(doomed.map((r) => store.remove(r.key)));
}
