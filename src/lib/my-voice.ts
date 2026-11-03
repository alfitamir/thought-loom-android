// "My voice": a replicated voice of the user himself, created through the
// Gemini API Voices endpoint (docs:
// ai.google.dev/gemini-api/docs/voice-replication) with his personal key —
// the same key, sent only to Google from this browser, as every other
// Gemini feature in the app. Google stores the verified voice profile in
// his project (stateful mode, `store: true`) and returns a `voice_...` id;
// only that id and its creation date are kept here, in local settings
// storage. The recordings themselves are sent once, at creation, and are
// NOT kept on the device afterwards. Synthesis passes the id as the
// speech_config voice (see tts.ts).

import { geminiErrorMessage } from "./gemini";
import { GEMINI_TTS_SAMPLE_RATE, pcmToWav } from "./tts";

export const VOICES_API_URL = "https://generativelanguage.googleapis.com/v1beta/voices";
/** The model a replicated voice is created against (docs: either 3.8 TTS
 * model; the created voice then works with both). */
export const MY_VOICE_MODEL = "gemini-3.8-flash-tts";

/** Reference-sample length window the Voices API accepts, in seconds. */
export const MIN_SAMPLE_SECONDS = 10;
export const MAX_SAMPLE_SECONDS = 30;

export type SampleDurationState = "short" | "ok" | "long";

/** Whether a reference recording's length fits the API's 10–30s window. */
export function sampleDurationState(seconds: number): SampleDurationState {
  if (seconds < MIN_SAMPLE_SECONDS) return "short";
  if (seconds > MAX_SAMPLE_SECONDS) return "long";
  return "ok";
}

/**
 * The verbatim consent statement for Arabic (`ar-XA`), from the docs'
 * consent-phrases table. The consent recording must recite it word for
 * word — the service verifies the transcript AND that the speaker matches
 * the reference sample.
 */
export const CONSENT_STATEMENT_AR =
  "أنا مالك هذا الصوت وأوافق على أن تستخدم Google هذا الصوت لإنشاء نموذج صوتي اصطناعي.";

/**
 * The suggested reading text for the reference sample: neutral prose about
 * ideas and writing, ~60 words — about 25 seconds of natural Arabic
 * reading, inside the API's 10–30 second window.
 */
export const READING_SAMPLE_AR =
  "أكتب أفكاري هنا كما تخطر في بالي، بصوت هادئ وطبيعي، لأن الفكرة الجيدة تستحق أن تُحفظ قبل أن تضيع. " +
  "بعض الأفكار تولد صغيرة ثم تكبر مع الوقت، وبعضها يحتاج إلى مراجعة وصبر حتى ينضج. " +
  "أحب أن أقرأ ما أكتبه بصوت مرتفع، فالقراءة تكشف جمال الجملة وتوضح مواضع الضعف فيها. " +
  "هذه عينة من صوتي أقدمها ليقرأ التطبيق مقالاتي بنفس النبرة والإيقاع.";

// ---------------------------------------------------------------------------
// Profile storage: just the voice id + creation date, beside the Gemini key.
// ---------------------------------------------------------------------------

const PROFILE_KEY = "afkari.myVoice";

export type MyVoiceProfile = { voiceId: string; createdAt: number };

export function getMyVoiceProfile(): MyVoiceProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MyVoiceProfile>;
    if (typeof parsed.voiceId !== "string" || !parsed.voiceId) return null;
    return { voiceId: parsed.voiceId, createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0 };
  } catch { return null; }
}

export function saveMyVoiceProfile(voiceId: string): MyVoiceProfile {
  const profile: MyVoiceProfile = { voiceId, createdAt: Date.now() };
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* storage full/blocked: the id is lost, creation can be repeated */ }
  window.dispatchEvent(new Event("afkari:settings-changed"));
  return profile;
}

export function clearMyVoiceProfile(): void {
  try { localStorage.removeItem(PROFILE_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new Event("afkari:settings-changed"));
}

// ---------------------------------------------------------------------------
// WAV conversion: the API wants 24 kHz mono 16-bit WAV. Browsers record
// webm/opus, so recordings are decoded and resampled through WebAudio.
// ---------------------------------------------------------------------------

/** Float samples (-1..1) → 16-bit little-endian PCM bytes. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return out;
}

/** Mono float samples at the TTS sample rate → a complete WAV file. */
export function encodeWav24k(samples: Float32Array): Uint8Array {
  return pcmToWav(floatToPcm16(samples), GEMINI_TTS_SAMPLE_RATE);
}

/** Mix an AudioBuffer down to one mono channel (average of channels). */
export function mixToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i] = (out[i] ?? 0) + data[i]! / channels;
  }
  return out;
}

/**
 * Convert a browser recording (webm/opus…) to 24 kHz mono WAV bytes.
 * Decoding through an AudioContext created at 24 kHz resamples for us.
 * Browser-only (WebAudio); the pure helpers above carry the unit tests.
 */
export async function blobToWav24k(blob: Blob): Promise<Uint8Array> {
  const Ctor = typeof window !== "undefined"
    ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    : undefined;
  if (!Ctor) throw new Error("تحويل الصوت غير متاح على هذا الجهاز.");
  const bytes = await blob.arrayBuffer();
  const ctx = new Ctor({ sampleRate: GEMINI_TTS_SAMPLE_RATE });
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    return encodeWav24k(mixToMono(buffer));
  } finally {
    void ctx.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Voices API (REST, personal key as x-goog-api-key — as documented).
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** The documented CreateVoice body for a stateful replicated voice. */
export function buildCreateVoiceRequest(sourceWavB64: string, consentWavB64: string) {
  return {
    store: true,
    voice: {
      model: MY_VOICE_MODEL,
      type: "replicated",
      display_name: "صوتي",
      replicated: {
        source_audio: { mime_type: "audio/wav", data: sourceWavB64 },
        consent_audio: { mime_type: "audio/wav", data: consentWavB64 },
      },
    },
  };
}

/**
 * The created voice id from a CreateVoice response. The SDK surfaces it as
 * `replicated_voice.id`; the REST resource carries it as `id` (or a
 * `voices/...` resource name) — accept the documented shapes.
 */
export function parseCreatedVoiceId(json: unknown): string | null {
  const root = json as {
    id?: unknown; name?: unknown;
    voice?: { id?: unknown };
    replicated_voice?: { id?: unknown };
    replicatedVoice?: { id?: unknown };
  } | null;
  const candidates = [root?.id, root?.voice?.id, root?.replicated_voice?.id, root?.replicatedVoice?.id];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("voice_")) return c;
  }
  if (typeof root?.name === "string") {
    const tail = root.name.split("/").pop() ?? "";
    if (tail.startsWith("voice_")) return tail;
  }
  return null;
}

export class MyVoiceError extends Error {}

/**
 * Create the replicated voice from two WAV recordings (reference + consent)
 * and return its `voice_...` id. Consent mismatches get their own message:
 * they are the one failure the user can fix by simply re-recording.
 */
export async function createMyVoice(
  key: string, sourceWav: Uint8Array, consentWav: Uint8Array, signal?: AbortSignal,
): Promise<string> {
  if (!key.trim()) throw new MyVoiceError("أضف مفتاح Gemini من الإعدادات أولًا.");
  let response: Response;
  try {
    response = await fetch(VOICES_API_URL, {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(buildCreateVoiceRequest(bytesToBase64(sourceWav), bytesToBase64(consentWav))),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MyVoiceError("تعذّر الوصول إلى Gemini. تأكد من الإنترنت وحاول مرة أخرى.");
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
    const text = typeof message === "string" ? message : "";
    if (/consent/i.test(text)) {
      throw new MyVoiceError("لم تتطابق قراءة الموافقة مع المطلوب. أعد تسجيلها كما هي مكتوبة تمامًا، وبنفس الميكروفون والغرفة.");
    }
    throw new MyVoiceError(geminiErrorMessage(response.status, text));
  }
  const voiceId = parseCreatedVoiceId(json);
  if (!voiceId) throw new MyVoiceError("وصل رد من Gemini دون معرّف للصوت. حاول مرة أخرى.");
  return voiceId;
}

/**
 * Delete the stored voice on Google's side (DELETE /v1beta/voices/{id}).
 * Best effort: returns whether the API confirmed; the local profile is
 * cleared by the caller either way.
 */
export async function deleteMyVoice(key: string, voiceId: string): Promise<boolean> {
  if (!key.trim() || !voiceId) return false;
  try {
    const response = await fetch(`${VOICES_API_URL}/${encodeURIComponent(voiceId)}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": key },
    });
    return response.ok;
  } catch { return false; }
}
