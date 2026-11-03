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

/**
 * «صوتي» is TEMPORARILY HIDDEN at the owner's instruction: the replicated
 * voice is not close enough to his yet, and creation currently fails on
 * his account — the feature is parked, not abandoned. Everything else in
 * this module (profile storage, the Voices client, the TTS wiring) stays
 * in place and untouched; only the entry points gate on this flag.
 * Restore = set it back to `true` (one line).
 */
export const MY_VOICE_PUBLIC = false;

/** Whether the «صوتي» surfaces (settings section, listen voice toggle)
 * are shown. All gating goes through this so both states are testable. */
export function isMyVoicePublic(): boolean {
  return MY_VOICE_PUBLIC;
}

/**
 * The voice a listen session may actually speak in. While the feature is
 * hidden, a «صوتي» choice resolves to the default voice: playback proceeds
 * normally with the prebuilt voice — never down the replicated-voice path,
 * never an error. `pub` is injectable so tests can exercise both states.
 */
export function effectiveListenVoice(
  choice: "default" | "mine", pub: boolean = MY_VOICE_PUBLIC,
): "default" | "mine" {
  return pub ? choice : "default";
}

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
 * ideas and writing, ~70 words — about 25–30 seconds of natural Arabic
 * reading, inside the API's 10–30 second window. The closing lines add a
 * question and an emphatic sentence on purpose: a sample read in one flat
 * formal tone gives the replication little of the speaker's real voice to
 * learn from, so the text itself invites intonation variety.
 */
export const READING_SAMPLE_AR =
  "أكتب أفكاري هنا كما تخطر في بالي، بصوت هادئ وطبيعي، لأن الفكرة الجيدة تستحق أن تُحفظ قبل أن تضيع. " +
  "بعض الأفكار تولد صغيرة ثم تكبر مع الوقت، وبعضها يحتاج إلى مراجعة وصبر حتى ينضج. " +
  "أحب أن أقرأ ما أكتبه بصوت مرتفع، فالقراءة تكشف جمال الجملة وتوضح مواضع الضعف فيها. " +
  "هذه عينة من صوتي أقدمها ليقرأ التطبيق مقالاتي بنفس النبرة والإيقاع. " +
  "وهل جرّبت أن تقرأ ما كتبته بصوت مرتفع؟ جرّبها بنفسك — ستُدهشك النتيجة حتمًا!";

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
 * Decode an audio blob (a recording or an uploaded file) to mono float
 * samples at 24 kHz. An AudioContext created at 24 kHz resamples for us.
 * Browser-only (WebAudio); the pure helpers carry the unit tests.
 */
export async function blobToSamples24k(blob: Blob): Promise<Float32Array> {
  const Ctor = typeof window !== "undefined"
    ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    : undefined;
  if (!Ctor) throw new Error("تحويل الصوت غير متاح على هذا الجهاز.");
  const bytes = await blob.arrayBuffer();
  const ctx = new Ctor({ sampleRate: GEMINI_TTS_SAMPLE_RATE });
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    return mixToMono(buffer);
  } finally {
    void ctx.close().catch(() => {});
  }
}

/**
 * Convert a browser recording (webm/opus…) to 24 kHz mono WAV bytes.
 */
export async function blobToWav24k(blob: Blob): Promise<Uint8Array> {
  return encodeWav24k(await blobToSamples24k(blob));
}

/** Seconds of audio in a mono buffer at the given sample rate. */
export const samplesSeconds = (samples: Float32Array, rate: number = GEMINI_TTS_SAMPLE_RATE): number =>
  samples.length / rate;

/** The first `seconds` of a mono buffer — longer input is cut, shorter
 * input passes through untouched (same reference). */
export function trimSamplesToSeconds(
  samples: Float32Array, seconds: number, rate: number = GEMINI_TTS_SAMPLE_RATE,
): Float32Array {
  const max = Math.max(0, Math.floor(seconds * rate));
  return samples.length > max ? samples.slice(0, max) : samples;
}

export type PreparedUpload = { wav: Uint8Array; seconds: number; trimmed: boolean };

/**
 * Prepare an UPLOADED audio file as a voice-creation take, through the
 * exact same decode → 24 kHz mono WAV conversion the recorder path uses.
 * A reference file longer than the API's window is cut to its first
 * MAX_SAMPLE_SECONDS (the UI says so); a consent file passes through
 * whole — the API verifies its content, only its duration is sanity here.
 */
export async function prepareUploadedAudio(file: Blob, isSample: boolean): Promise<PreparedUpload> {
  const samples = await blobToSamples24k(file);
  const trimmed = isSample && samplesSeconds(samples) > MAX_SAMPLE_SECONDS;
  const used = trimmed ? trimSamplesToSeconds(samples, MAX_SAMPLE_SECONDS) : samples;
  return { wav: encodeWav24k(used), seconds: Math.max(1, Math.round(samplesSeconds(used))), trimmed };
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

/** The `reason` strings out of a Google error body's `error.details[]`
 * (ErrorInfo entries carry one; other detail shapes don't). */
function googleErrorReasons(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const out: string[] = [];
  for (const detail of details) {
    const reason = (detail as { reason?: unknown } | null)?.reason;
    if (typeof reason === "string") out.push(reason);
  }
  return out;
}

/** Google's own error text, made safe to append to a user message:
 * single line, whitespace collapsed, capped at 140 characters. */
function sanitizeGoogleErrorText(message: string): string {
  const clean = message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 140 ? clean.slice(0, 140) : clean;
}

/**
 * Turn a failed CreateVoice response into a SPECIFIC Arabic message.
 * The shared `geminiErrorMessage` maps a 403 to "key invalid", but on the
 * Voices endpoint a 403 is usually a quota hit or a project that hasn't
 * enabled voice creation — so the create path parses Google's error body
 * (error.status / error.message / details reasons) itself:
 * quota → wait-and-retry; consent/speaker verification → re-record both
 * takes together; permission → check the key's project; anything else
 * keeps the shared mapped message with Google's own short text appended
 * so the real cause stays visible. Malformed bodies degrade to the
 * shared message with nothing appended.
 */
export function voiceCreateErrorMessage(httpStatus: number, body: unknown): string {
  const error = (body as {
    error?: { status?: unknown; message?: unknown; details?: unknown };
  } | null)?.error;
  const status = typeof error?.status === "string" ? error.status : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const reasons = googleErrorReasons(error?.details);
  if (
    httpStatus === 429 || status === "RESOURCE_EXHAUSTED"
    || reasons.includes("rateLimitExceeded") || reasons.includes("quotaExceeded")
  ) {
    return "وصلت لحد إنشاء الأصوات عند Google مؤقتًا — حاول تاني بعد ساعات أو بكرة.";
  }
  if (status === "FAILED_PRECONDITION" || /consent|verif|speaker/i.test(message)) {
    return "Google ما قدرش يطابق تسجيل الموافقة مع العيّنة — سجّل الاتنين بنفس الميكروفون وفي نفس الجلسة.";
  }
  if (status === "PERMISSION_DENIED" || httpStatus === 403) {
    return "إنشاء الأصوات غير مفعّل لمشروع مفتاحك — راجع حالة المشروع في Google AI Studio (قيود/فوترة/تحقق من العمر).";
  }
  const base = geminiErrorMessage(httpStatus, message);
  const detail = sanitizeGoogleErrorText(message);
  return detail ? `${base} (${detail})` : base;
}

/**
 * Create the replicated voice from two WAV recordings (reference + consent)
 * and return its `voice_...` id. Failures go through
 * `voiceCreateErrorMessage`, so the user sees the specific cause (quota,
 * project not enabled, consent/speaker mismatch) instead of a generic
 * "key invalid" line.
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
    throw new MyVoiceError(voiceCreateErrorMessage(response.status, json));
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
