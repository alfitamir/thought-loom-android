// Text-to-speech for listening to saved articles.
// Two engines: the device voice (speechSynthesis — heard live only, never a
// file) and Gemini TTS with the user's personal key (a real WAV file that can
// be cached on the device and shared like the article itself).
// The personal key is sent only to Google, from this browser, never logged.

import { geminiErrorMessage } from "./gemini";

export type TtsEngine = "device" | "gemini";

/** Gemini TTS model and one documented prebuilt voice: "Charon", an
 * informative male voice. Gemini TTS detects Arabic from the text itself. */
export const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
export const GEMINI_TTS_VOICE = "Charon";
/** Gemini TTS returns raw PCM: 16-bit little-endian, mono, 24 kHz. */
export const GEMINI_TTS_SAMPLE_RATE = 24000;

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
export function splitForSpeech(text: string, maxChars = 900): string[] {
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

/** Generate one WAV file for the whole text with Gemini TTS, chunk by chunk. */
export async function synthesizeGemini(
  text: string, key: string,
  opts: { signal?: AbortSignal; onProgress?: SynthProgress } = {},
): Promise<Blob> {
  if (!key.trim()) throw new TtsError("أضف مفتاح Gemini من الإعدادات ⚙️ لتوليد الصوت.");
  const chunks = splitForSpeech(text);
  if (!chunks.length) throw new TtsError("لا يوجد نص للقراءة.");
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let response: Response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`, {
        method: "POST",
        ...(opts.signal ? { signal: opts.signal } : {}),
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(buildGeminiTtsRequest(chunks[i] as string)),
      });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw new TtsError("تعذّر الوصول إلى Gemini. تأكد من الإنترنت وحاول مرة أخرى.");
    }
    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new TtsError(geminiErrorMessage(response.status, err?.error?.message ?? ""));
    }
    const pcm = parseGeminiTtsAudio(await response.json().catch(() => null));
    parts.push(pcm);
    total += pcm.length;
    opts.onProgress?.(i + 1, chunks.length);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  return new Blob([pcmToWav(all) as BlobPart], { type: "audio/wav" });
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
