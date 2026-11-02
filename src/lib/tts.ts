// Text-to-speech for listening to saved articles.
// Two engines: the device voice (speechSynthesis — heard live only, never a
// file) and Gemini TTS with the user's personal key (real audio that can be
// cached on the device chunk by chunk and shared like the article itself).
// Gemini chunks are synthesized in parallel (bounded concurrency) and each
// chunk is handed to the caller the moment it lands, so playback can start
// with the first chunk while the rest are still generating.
// The personal key is sent only to Google, from this browser, never logged.

import { geminiErrorMessage } from "./gemini";

export type TtsEngine = "device" | "gemini";

/**
 * Gemini TTS models in preference order (docs: ai.google.dev/gemini-api/docs/speech-generation).
 * The 3.8 models are served by the Interactions API; the 2.5 preview model
 * keeps the classic generateContent shape as the final fallback. A session
 * resolves ONE model — probing with its first chunk — and never mixes
 * models inside one article's audio. Flash-Lite leads: it is the model
 * Google positions for high-throughput read-aloud.
 */
export const GEMINI_TTS_MODELS = [
  "gemini-3.8-flash-lite-tts",
  "gemini-3.8-flash-tts",
  "gemini-2.5-flash-preview-tts",
] as const;
export type GeminiTtsModelId = (typeof GEMINI_TTS_MODELS)[number];
/** The final fallback model (the only one the first listen release used). */
export const GEMINI_TTS_MODEL: GeminiTtsModelId = "gemini-2.5-flash-preview-tts";
/** One documented prebuilt voice, present in both the 2.5 and 3.8 voice
 * lists: "Charon", an informative male voice. Gemini TTS detects Arabic
 * from the text itself — 3.8 speech_config has no language field. */
export const GEMINI_TTS_VOICE = "Charon";
/** Gemini TTS audio is raw PCM: 16-bit little-endian, mono, 24 kHz. */
export const GEMINI_TTS_SAMPLE_RATE = 24000;

/**
 * Cache voice key for one model + voice. A generation's manifest and chunks
 * are stored under this key, so audio is only ever resumed, completed, or
 * exported by the exact model that produced it — never mixed across models.
 */
export const ttsVoiceKey = (model: string): string => `${model}:${GEMINI_TTS_VOICE}`;

/** The voice key new generations write under (the primary model's). */
export const CURRENT_TTS_VOICE_KEY = ttsVoiceKey(GEMINI_TTS_MODELS[0]);

/**
 * The model that produced a cache voice key. Keys written before the model
 * upgrade are the bare voice name ("Charon") — those came from the 2.5
 * pipeline, so they map to the fallback model.
 */
export function modelForVoiceKey(voiceKey: string): string {
  const sep = voiceKey.indexOf(":");
  return sep > 0 ? voiceKey.slice(0, sep) : GEMINI_TTS_MODEL;
}

export class TtsError extends Error {}

/** Plain text prepared for speaking: title then body, markdown marks removed. */
export function toSpeechText(title: string, body: string): string {
  const clean = (s: string) =>
    s
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^>\s?/gm, "")
      .trim();
  return [clean(title), clean(body)].filter(Boolean).join("\n\n");
}

function splitSentences(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  return flat.split(/(?<=[.!؟?…])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Split text into speakable chunks of at most maxChars, on sentence
 * boundaries whenever possible. Diacritics are preserved exactly — they
 * guide pronunciation, so speech text is never stripped.
 */
export function splitForSpeech(text: string, maxChars = 1800): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
  const addPiece = (piece: string) => {
    if (piece.length > maxChars) {
      flush();
      let rest = piece;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(" ", maxChars);
        const comma = Math.max(rest.lastIndexOf("،", maxChars), rest.lastIndexOf("؛", maxChars), rest.lastIndexOf(",", maxChars));
        if (comma > maxChars * 0.4) cut = comma + 1;
        if (cut <= 0) cut = maxChars;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      return;
    }
    const joined = current ? `${current} ${piece}` : piece;
    if (joined.length > maxChars) { flush(); current = piece; } else current = joined;
  };
  for (const sentence of splitSentences(text)) addPiece(sentence);
  flush();
  return chunks;
}

/** Wrap raw 16-bit mono PCM in a WAV header so browsers can play/share it. */
export function pcmToWav(pcm: Uint8Array, sampleRate = GEMINI_TTS_SAMPLE_RATE): Uint8Array {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate: 16-bit mono
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Read a Blob as bytes; FileReader fallback where Blob.arrayBuffer is
 * missing (older webviews, jsdom) — same approach as ai-features' blobToBase64. */
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new TtsError("تعذّرت قراءة الصوت المحفوظ."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
  return base64ToBytes(dataUrl.split(",")[1] ?? "");
}

/** Concatenate raw PCM chunks into one continuous PCM stream, in order. */
export function concatPcm(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  return all;
}

/**
 * Map over items with at most `limit` promises in flight. Results keep the
 * input order regardless of completion order. The first failure stops new
 * work from starting (in-flight work may settle) and is rethrown; an aborted
 * signal does the same and surfaces as an AbortError.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (failure === null && !signal?.aborted) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (e) {
        if (failure === null) failure = e;
        return;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failure !== null) throw failure;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return results;
}

export function buildGeminiTtsRequest(text: string) {
  return {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } } },
    },
  };
}

/** Extract the base64 PCM from a Gemini TTS response. Throws a TtsError when absent. */
export function parseGeminiTtsAudio(json: unknown): Uint8Array {
  const data = (json as { candidates?: { content?: { parts?: { inlineData?: { data?: unknown } }[] } }[] })
    ?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (typeof data !== "string" || !data) throw new TtsError("لم يصل صوت من Gemini. حاول مرة أخرى.");
  return base64ToBytes(data);
}

export type SynthProgress = (done: number, total: number) => void;

/** The 3.8 models are served by the Interactions API; older ones are not. */
const INTERACTIONS_MODELS: ReadonlySet<string> = new Set([GEMINI_TTS_MODELS[0], GEMINI_TTS_MODELS[1]]);
const usesInteractionsApi = (model: string): boolean => INTERACTIONS_MODELS.has(model);

/** Internal signal: this model cannot serve the request at all, so a session
 * may fall through to the next model in GEMINI_TTS_MODELS. Never user-facing. */
export class ModelUnavailableError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * Whether an HTTP failure means "this model is unavailable" (fall through to
 * the next model) rather than a real error (surface it). Only a 404, or a
 * 400/403 whose message says the model is missing/unsupported, qualifies —
 * quota (429), bad keys, and everything else never fall through.
 */
export function isModelUnavailable(status: number, message: string): boolean {
  if (status === 404) return true;
  if (status !== 400 && status !== 403) return false;
  return /not found|not available|not supported|unsupported|does not exist|unknown model|invalid model/i.test(message);
}

const responseErrorMessage = (json: unknown): string => {
  const err = json as { error?: { message?: unknown }; message?: unknown };
  if (typeof err?.error?.message === "string") return err.error.message;
  if (typeof err?.message === "string") return err.message;
  return "";
};

/**
 * The single-speaker Interactions API request for the 3.8 models. It asks
 * explicitly for headerless PCM (`audio/l16`): the unary default is a full
 * WAV file, which could not be concatenated chunk-by-chunk like raw PCM.
 */
export function buildInteractionsTtsRequest(model: string, text: string) {
  return {
    model,
    input: [{ type: "user_input", content: [{ type: "text", text }] }],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: GEMINI_TTS_SAMPLE_RATE },
    generation_config: { speech_config: [{ voice: GEMINI_TTS_VOICE }] },
  };
}

const ascii = (bytes: Uint8Array, off: number, len: number): string =>
  String.fromCharCode(...bytes.slice(off, off + len));

/**
 * Normalize a TTS payload to headerless PCM. Raw PCM passes through; a WAV
 * payload (the 3.8 unary default, in case the server ignored the audio/l16
 * request) is unwrapped to its data chunk — the format is fixed at 24 kHz
 * mono 16-bit, so the PCM frames are directly concatenable either way.
 */
export function unwrapPcm(bytes: Uint8Array, mimeType?: string): Uint8Array {
  const isWav = mimeType?.toLowerCase().includes("wav") ||
    (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE");
  if (!isWav) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = ascii(bytes, off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === "data") return bytes.slice(off + 8, Math.min(off + 8 + size, bytes.length));
    off += 8 + size + (size % 2); // chunk payloads are word-aligned
  }
  return bytes; // malformed WAV: keep the bytes rather than dropping audio
}

/**
 * Extract the audio from an Interactions API response: the LAST audio block
 * of the model_output steps (raw REST keeps base64 audio in
 * steps[].content[].data). Normalized to headerless PCM. Throws a TtsError
 * when the response carries no audio.
 */
export function parseInteractionsTtsAudio(json: unknown): Uint8Array {
  const root = json as {
    steps?: { type?: string; content?: { type?: string; data?: unknown; mime_type?: string }[] }[];
    output_audio?: { data?: unknown; mime_type?: string };
  };
  let data: unknown;
  let mimeType: string | undefined;
  for (const step of root?.steps ?? []) {
    if (step?.type !== "model_output") continue;
    for (const part of step.content ?? []) {
      if (part?.type === "audio") { data = part.data; mimeType = part.mime_type; }
    }
  }
  // Defensive: SDK-shaped convenience field, if a gateway ever returns it.
  if (typeof data !== "string" && typeof root?.output_audio?.data === "string") {
    data = root.output_audio.data;
    mimeType = root.output_audio.mime_type;
  }
  if (typeof data !== "string" || !data) throw new TtsError("لم يصل صوت من Gemini. حاول مرة أخرى.");
  return unwrapPcm(base64ToBytes(data), mimeType);
}

/** One TTS request for a single chunk through one specific model's API. */
export async function synthesizeGeminiChunkWithModel(
  chunk: string, key: string, model: string, signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const interactions = usesInteractionsApi(model);
  let response: Response;
  try {
    response = await fetch(
      interactions
        ? "https://generativelanguage.googleapis.com/v1beta/interactions"
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        ...(signal ? { signal } : {}),
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(interactions ? buildInteractionsTtsRequest(model, chunk) : buildGeminiTtsRequest(chunk)),
      },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TtsError("تعذّر الوصول إلى Gemini. تأكد من الإنترنت وحاول مرة أخرى.");
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const message = responseErrorMessage(err);
    if (isModelUnavailable(response.status, message)) throw new ModelUnavailableError(response.status, message);
    throw new TtsError(geminiErrorMessage(response.status, message));
  }
  const json = await response.json().catch(() => null);
  return interactions ? parseInteractionsTtsAudio(json) : parseGeminiTtsAudio(json);
}

/** One Gemini TTS request for a single chunk of text; returns raw PCM bytes.
 * Pinned to the 2.5 fallback model (the classic generateContent shape). */
export async function synthesizeGeminiChunk(
  chunk: string, key: string, signal?: AbortSignal,
): Promise<Uint8Array> {
  return synthesizeGeminiChunkWithModel(chunk, key, GEMINI_TTS_MODEL, signal);
}

export type TtsSession = {
  /** The resolved model, or the primary until the first chunk resolves it. */
  readonly model: string;
  /** Cache voice key binding this session's audio to its model. Only final
   * once the first chunk has resolved the model — read it from onChunkReady
   * time onward, never before synthesis starts. */
  readonly voiceKey: string;
  synthesizeChunk: (chunk: string, signal?: AbortSignal) => Promise<Uint8Array>;
};

type PendingChunk = {
  chunk: string;
  signal?: AbortSignal;
  resolve: (pcm: Uint8Array) => void;
  reject: (error: unknown) => void;
};

/**
 * A synthesis session bound to ONE model, resolved lazily: the first chunk
 * probes GEMINI_TTS_MODELS in order, falling through only on model-level
 * failures (see isModelUnavailable). Chunks requested while the probe is in
 * flight wait, then synthesize with the resolved model — an article's audio
 * therefore never mixes models. A failed probe rejects the waiting chunks
 * with the same error and re-arms, so a later call can probe again.
 */
export function createTtsSession(key: string): TtsSession {
  let resolved: string | null = null;
  let probing = false;
  let waiters: PendingChunk[] = [];

  const settleWaiters = (error: unknown) => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.reject(error);
  };

  const runProbe = async (first: PendingChunk) => {
    let lastUnavailable: ModelUnavailableError | null = null;
    for (const candidate of GEMINI_TTS_MODELS) {
      try {
        const pcm = await synthesizeGeminiChunkWithModel(first.chunk, key, candidate, first.signal);
        resolved = candidate;
        first.resolve(pcm);
        const pending = waiters;
        waiters = [];
        for (const w of pending) {
          void synthesizeGeminiChunkWithModel(w.chunk, key, candidate, w.signal).then(w.resolve, w.reject);
        }
        return;
      } catch (error) {
        if (error instanceof ModelUnavailableError) { lastUnavailable = error; continue; }
        probing = false;
        first.reject(error);
        settleWaiters(error);
        return;
      }
    }
    probing = false;
    const error = new TtsError(geminiErrorMessage(lastUnavailable?.status ?? 404, lastUnavailable?.message ?? ""));
    first.reject(error);
    settleWaiters(error);
  };

  const synthesizeChunk = (chunk: string, signal?: AbortSignal): Promise<Uint8Array> => {
    if (resolved) return synthesizeGeminiChunkWithModel(chunk, key, resolved, signal);
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: PendingChunk = { chunk, ...(signal ? { signal } : {}), resolve, reject };
      if (!probing) {
        probing = true;
        void runProbe(waiter);
      } else {
        waiters.push(waiter);
      }
    });
  };

  return {
    get model() { return resolved ?? GEMINI_TTS_MODELS[0]; },
    get voiceKey() { return ttsVoiceKey(resolved ?? GEMINI_TTS_MODELS[0]); },
    synthesizeChunk,
  };
}

export type SynthesizeChunksOptions = {
  /** Max requests in flight at once (default 3). */
  concurrency?: number;
  /** Chunk size passed to splitForSpeech (default 1800 chars). */
  maxChars?: number;
  /** Called as EACH chunk completes — possibly out of index order — with the
   * chunk's index and its raw PCM, so callers can cache and play early. */
  onChunkReady?: (index: number, pcm: Uint8Array) => void;
  signal?: AbortSignal;
};

async function synthesizeChunkList(
  chunks: string[], key: string, opts: SynthesizeChunksOptions,
): Promise<Uint8Array[]> {
  if (!key.trim()) throw new TtsError("أضف مفتاح Gemini من الإعدادات ⚙️ لتوليد الصوت.");
  if (!chunks.length) throw new TtsError("لا يوجد نص للقراءة.");
  const session = createTtsSession(key);
  return mapWithConcurrency(chunks, opts.concurrency ?? 3, async (chunk, i) => {
    const pcm = await session.synthesizeChunk(chunk, opts.signal);
    opts.onChunkReady?.(i, pcm);
    return pcm;
  }, opts.signal);
}

/**
 * Synthesize the whole text with Gemini TTS, chunks in parallel. Resolves
 * with the PCM of every chunk in text order; onChunkReady fires earlier, per
 * completion, for progressive playback.
 */
export async function synthesizeGeminiChunks(
  text: string, key: string, opts: SynthesizeChunksOptions = {},
): Promise<Uint8Array[]> {
  return synthesizeChunkList(splitForSpeech(text, opts.maxChars), key, opts);
}

/** Generate one WAV file for the whole text with Gemini TTS. */
export async function synthesizeGemini(
  text: string, key: string,
  opts: { signal?: AbortSignal; onProgress?: SynthProgress; maxChars?: number } = {},
): Promise<Blob> {
  const chunks = splitForSpeech(text, opts.maxChars);
  let done = 0;
  const parts = await synthesizeChunkList(chunks, key, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    onChunkReady: () => { done++; opts.onProgress?.(done, chunks.length); },
  });
  return new Blob([pcmToWav(concatPcm(parts)) as BlobPart], { type: "audio/wav" });
}

export type DeviceSpeech = { stop: () => void; done: Promise<void> };

/**
 * Read the text aloud with the device voice, chunk by chunk (long single
 * utterances get cut off by some browsers). Prefers an Arabic voice when the
 * device has one. Produces no file — device speech cannot be saved or shared.
 * onChunk receives the 0-based index of the chunk that just started.
 */
export function speakWithDevice(
  text: string,
  opts: { rate?: number; onChunk?: (index: number, total: number) => void } = {},
): DeviceSpeech {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    throw new TtsError("صوت الجهاز غير متاح على هذا الجهاز.");
  }
  const chunks = splitForSpeech(text);
  if (!chunks.length) throw new TtsError("لا يوجد نص للقراءة.");
  const voice = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith("ar"));
  let stopped = false;
  let idx = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((res) => { resolveDone = res; });
  const next = () => {
    if (stopped) return;
    if (idx >= chunks.length) { resolveDone(); return; }
    const u = new SpeechSynthesisUtterance(chunks[idx]);
    u.rate = opts.rate ?? 1;
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "ar";
    opts.onChunk?.(idx, chunks.length);
    u.onend = () => { if (!stopped) { idx++; next(); } };
    u.onerror = () => { if (!stopped) { idx++; next(); } };
    synth.speak(u);
  };
  synth.cancel();
  next();
  return {
    stop: () => { stopped = true; synth.cancel(); resolveDone(); },
    done,
  };
}
