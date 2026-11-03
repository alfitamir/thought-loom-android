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

import {
  CURRENT_TTS_VOICE_KEY, GEMINI_TTS_SAMPLE_RATE, modelForVoiceKey, toSpeechText, type TtsEngine,
} from "./tts";

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
  /** The TTS model that produced (or is producing) this generation. The
   * voiceKey embeds it for new keys; manifests written before the model
   * upgrade have no modelId field at runtime — modelForVoiceKey derives it
   * from their bare voice key instead. A generation is only ever resumed or
   * completed by the model recorded here. */
  modelId: string;
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
  listAll(): Promise<StoredAudioRecord[]>;
}

/** In-memory store (tests, or browsers without IndexedDB). */
export function memoryArticleAudioStore(): ArticleAudioStore {
  const map = new Map<string, StoredAudioRecord>();
  return {
    async get(key) { return map.get(key) ?? null; },
    async put(rec) { map.set(rec.key, rec); },
    async remove(key) { map.delete(key); },
    async listForArticle(articleId) { return [...map.values()].filter((r) => r.articleId === articleId); },
    async listAll() { return [...map.values()]; },
  };
}

const DB = "thought-loom-audio";
const STORE = "article-audio";
const SONGS_STORE = "songs";
const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/**
 * One shared open for both stores in this database. Version 2 added the
 * `songs` store (the user's own singing recordings); the TTS cache store
 * is untouched by the upgrade.
 */
let sharedDbp: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  sharedDbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("articleId", "articleId");
      }
      if (!db.objectStoreNames.contains(SONGS_STORE)) {
        db.createObjectStore(SONGS_STORE, { keyPath: "key" });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return sharedDbp;
}

export function indexedDbArticleAudioStore(): ArticleAudioStore {
  const db = () => openDb();
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
    async listAll() {
      const t = await tx("readonly");
      return (await req(t.objectStore(STORE).getAll())) as StoredAudioRecord[];
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
async function cachedFromRecord(
  rec: StoredAudioRecord, articleId: string, title: string, body: string,
  store: ArticleAudioStore,
): Promise<CachedAudio | null> {
  if (isChunkedManifest(rec)) {
    return {
      kind: "chunks",
      manifest: rec,
      readyIndexes: await listReadyChunks(articleId, rec.engine, rec.voiceKey, store),
      fresh: isManifestFresh(rec, title, body),
    };
  }
  if (isAudioChunk(rec)) return null; // a chunk key was passed, not a base key
  return { kind: "legacy", record: rec, blob: rec.blob, fresh: isAudioFresh(rec, title, body) };
}

export async function getCachedAudio(
  articleId: string, engine: TtsEngine, voiceKey: string, title: string, body: string,
  store: ArticleAudioStore = articleAudioStore(),
): Promise<CachedAudio | null> {
  const rec = await store.get(audioKey(articleId, engine, voiceKey));
  if (!rec) return null;
  return cachedFromRecord(rec, articleId, title, body, store);
}

/**
 * Find whatever audio is cached for an article + engine, across models:
 * the current model's entry first, then the newest chunked generation,
 * then the newest legacy record. The returned manifest/record carries its
 * own voiceKey (and with it, its model) — callers play and share it as-is,
 * and resume it only with that same model.
 */
export async function findCachedAudio(
  articleId: string, engine: TtsEngine, title: string, body: string,
  store: ArticleAudioStore = articleAudioStore(),
): Promise<CachedAudio | null> {
  const all = (await store.listForArticle(articleId)).filter((r) => r.engine === engine);
  const manifests = all.filter(isChunkedManifest)
    .sort((a, b) => b.createdAt - a.createdAt);
  const chosenManifest = manifests.find((m) => m.voiceKey === CURRENT_TTS_VOICE_KEY) ?? manifests[0];
  if (chosenManifest) return cachedFromRecord(chosenManifest, articleId, title, body, store);
  const legacy = all.filter(isLegacyAudio).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (legacy) return cachedFromRecord(legacy, articleId, title, body, store);
  return null;
}

/**
 * Ids of every article that has generated Gemini audio on this device, in
 * ONE pass over the store — the library uses it to badge article cards
 * without a per-card lookup. Presence only: a chunked manifest (even a
 * partial generation) or a legacy single-file record counts, fresh or
 * stale; lone chunk records without a manifest do not.
 */
export async function listArticleIdsWithAudio(
  store: ArticleAudioStore = articleAudioStore(),
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const rec of await store.listAll()) {
    if (rec.engine === "gemini" && (isChunkedManifest(rec) || isLegacyAudio(rec))) ids.add(rec.articleId);
  }
  return ids;
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
    chunkCount: number; sampleRate?: number; modelId?: string;
  },
  store: ArticleAudioStore = articleAudioStore(),
): Promise<ChunkedAudioManifest> {
  const manifest: ChunkedAudioManifest = {
    key: audioKey(input.articleId, input.engine, input.voiceKey),
    articleId: input.articleId,
    engine: input.engine,
    voiceKey: input.voiceKey,
    modelId: input.modelId ?? modelForVoiceKey(input.voiceKey),
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

// ---------------------------------------------------------------------------
// Song recordings: the user's own singing, one assembled file per song idea.
// They live in a SEPARATE store of the same database so the TTS cache logic
// (freshness hashes, chunk manifests, the «صوت» badge pass) can never
// confuse a real recording with generated speech. A song's audio exists
// ONLY on the device that recorded it — sync carries the idea (title,
// lyrics, flag, duration), never the blob.
// ---------------------------------------------------------------------------

export type SongAudioRecord = {
  /** The song idea's id (also the record key). */
  key: string;
  ideaId: string;
  mime: string;
  blob: Blob;
  /** Recording length in seconds, as measured when it was saved. */
  duration: number;
  createdAt: number;
};

export interface SongAudioStore {
  get(ideaId: string): Promise<SongAudioRecord | null>;
  put(rec: SongAudioRecord): Promise<void>;
  remove(ideaId: string): Promise<void>;
  listAll(): Promise<SongAudioRecord[]>;
}

/** In-memory store (tests, or browsers without IndexedDB). */
export function memorySongAudioStore(): SongAudioStore {
  const map = new Map<string, SongAudioRecord>();
  return {
    async get(ideaId) { return map.get(ideaId) ?? null; },
    async put(rec) { map.set(rec.key, rec); },
    async remove(ideaId) { map.delete(ideaId); },
    async listAll() { return [...map.values()]; },
  };
}

export function indexedDbSongAudioStore(): SongAudioStore {
  const db = () => openDb();
  const tx = async (mode: IDBTransactionMode) => (await db()).transaction(SONGS_STORE, mode);
  const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return {
    async get(ideaId) {
      const t = await tx("readonly");
      return ((await req(t.objectStore(SONGS_STORE).get(ideaId))) as SongAudioRecord | undefined) ?? null;
    },
    async put(rec) { const t = await tx("readwrite"); t.objectStore(SONGS_STORE).put(rec); await done(t); },
    async remove(ideaId) { const t = await tx("readwrite"); t.objectStore(SONGS_STORE).delete(ideaId); await done(t); },
    async listAll() {
      const t = await tx("readonly");
      return (await req(t.objectStore(SONGS_STORE).getAll())) as SongAudioRecord[];
    },
  };
}

let sharedSongStore: SongAudioStore | null = null;
export const songAudioStore = (): SongAudioStore =>
  (sharedSongStore ??= typeof indexedDB !== "undefined" ? indexedDbSongAudioStore() : memorySongAudioStore());

/** Save (or replace) the recording of one song idea. */
export async function saveSongAudio(
  input: { ideaId: string; blob: Blob; mime?: string; duration?: number },
  store: SongAudioStore = songAudioStore(),
): Promise<SongAudioRecord> {
  const rec: SongAudioRecord = {
    key: input.ideaId,
    ideaId: input.ideaId,
    mime: input.mime || input.blob.type || "audio/webm",
    blob: input.blob,
    duration: input.duration ?? 0,
    createdAt: Date.now(),
  };
  await store.put(rec);
  return rec;
}

/** The recording of one song idea on THIS device, or null when it isn't here. */
export async function getSongAudio(
  ideaId: string,
  store: SongAudioStore = songAudioStore(),
): Promise<SongAudioRecord | null> {
  return store.get(ideaId);
}

/** Delete one song's recording from this device. */
export async function deleteSongAudio(
  ideaId: string,
  store: SongAudioStore = songAudioStore(),
): Promise<void> {
  await store.remove(ideaId);
}
