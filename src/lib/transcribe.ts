// Turns saved voice recordings into text. Each finished piece keeps its text, so a
// recording is never sent twice and an interrupted job continues where it stopped.
import type { Engine } from "./article-ai";
import { SILENCE, SONG_TRANSCRIBE_INSTRUCTIONS, TRANSCRIBE_INSTRUCTIONS } from "./ai-prompts";
import type { Segment, VoiceStore } from "./voice-store";

const clean = (t: string) => t.replace(SILENCE, "").replace(/\s+/g, " ").trim();

/** Lyrics cleaning: unlike dictation, line breaks ARE the structure — one line
 *  per sung phrase — so they are preserved; only the silence marker, ragged
 *  line edges and empty lines are dropped. */
export const cleanSongLyrics = (t: string): string =>
  t
    .replaceAll(SILENCE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Read the gateway's transcript stream (SSE). */
export async function readTranscriptStream(response: Response): Promise<string> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? "تعذّر تحويل الصوت إلى نص الآن. التسجيل محفوظ على هاتفك.");
  }
  if (!response.body) throw new Error("لم يصل النص. التسجيل محفوظ على هاتفك.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    text = "",
    done: string | null = null;
  const handle = (block: string) => {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    if (event.type === "transcript.text.delta") text += event.delta ?? "";
    else if (event.type === "transcript.text.done") done = event.text ?? text;
    else if (event.type === "error" || event.error)
      throw new Error(event.error?.message ?? event.message ?? "تعذّر تحويل الصوت إلى نص.");
  };
  while (true) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    blocks.forEach(handle);
  }
  if (buffer.trim()) handle(buffer);
  if (done === null)
    throw new Error("انقطع الاتصال قبل اكتمال تحويل الصوت. التسجيل محفوظ على هاتفك.");
  return done;
}

/** One transcription call, shared by dictation and song lyrics: the personal
 *  Gemini key in the browser, otherwise the signed-in /api/voice/transcribe
 *  route. `song` swaps in the sung-lyrics prompt on both paths (the route
 *  picks its own song prompt from the flag) and keeps line breaks. */
async function transcribeRaw(
  blob: Blob,
  mime: string,
  engine: Engine,
  signal: AbortSignal,
  song: boolean,
  instructions: string,
  userText: string,
): Promise<string> {
  const type = mime.startsWith("audio/") ? mime : "audio/webm";
  if (engine.kind === "gemini") {
    const { geminiStream } = await import("./gemini");
    const data = await toBase64(blob);
    return geminiStream(
      engine.key,
      instructions,
      [{ inlineData: { mimeType: type, data } }, { text: userText }],
      signal,
    );
  }
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("file", new File([blob], `voice.${ext}`, { type }));
  if (song) form.append("song", "1");
  const response = await fetch("/api/voice/transcribe", {
    method: "POST",
    signal,
    body: form,
    headers: { Authorization: `Bearer ${engine.token}` },
  });
  return readTranscriptStream(response);
}

export async function transcribeAudio(
  blob: Blob,
  mime: string,
  engine: Engine,
  signal: AbortSignal,
): Promise<string> {
  return clean(
    await transcribeRaw(
      blob,
      mime,
      engine,
      signal,
      false,
      TRANSCRIBE_INSTRUCTIONS,
      "فرّغ هذا التسجيل كاملًا.",
    ),
  );
}

/** Transcribe a SONG recording into its written lyrics: same transport as
 *  dictation, with the song prompt, and the sung phrases kept as lines. Only
 *  ever called deliberately for a song (editor button / post-save pass) —
 *  the dictation drain above never sees song audio. */
export async function transcribeSongAudio(
  blob: Blob,
  mime: string,
  engine: Engine,
  signal: AbortSignal,
): Promise<string> {
  return cleanSongLyrics(
    await transcribeRaw(
      blob,
      mime,
      engine,
      signal,
      true,
      SONG_TRANSCRIBE_INSTRUCTIONS,
      "فرّغ كلمات هذه الأغنية كما غُنّيت.",
    ),
  );
}

const bySeq = (a: Segment, b: Segment) => a.seq - b.seq;

/** Transcribe every piece of one recording (pieces already done are reused) and return the full text. */
export async function transcribeSession(
  store: VoiceStore,
  session: string,
  engine: Engine,
  signal: AbortSignal,
  transcribe: typeof transcribeAudio = transcribeAudio,
): Promise<string> {
  const segs = (await store.listSegments()).filter((s) => s.session === session).sort(bySeq);
  for (const seg of segs) {
    if (seg.transcript !== undefined) continue;
    const audio = await store.segmentAudio(seg.id);
    const text = audio.size < 2000 ? "" : await transcribe(audio, seg.mime, engine, signal);
    await store.setTranscript(seg.id, text);
    seg.transcript = text;
  }
  return segs
    .map((s) => s.transcript ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

export async function deleteSession(store: VoiceStore, session: string) {
  const segs = (await store.listSegments()).filter((s) => s.session === session);
  await Promise.all(segs.map((s) => store.deleteSegment(s.id)));
}

/** Recordings saved on the phone that haven't become ideas yet (excluding the one in progress). */
export async function pendingSessions(store: VoiceStore, except = ""): Promise<string[]> {
  const segs = await store.listSegments();
  return [...new Set(segs.map((s) => s.session))].filter((s) => s !== except);
}

/**
 * Turn waiting recordings into ideas. Stops at the first failure (offline, quota)
 * and keeps the audio, so nothing is lost. Returns how many ideas were created.
 */
export async function processPending(
  store: VoiceStore,
  engine: Engine,
  signal: AbortSignal,
  except: string,
  save: (text: string) => void,
  transcribe: typeof transcribeAudio = transcribeAudio,
): Promise<number> {
  let made = 0;
  for (const session of await pendingSessions(store, except)) {
    const text = await transcribeSession(store, session, engine, signal, transcribe);
    if (text) {
      save(text);
      made++;
    }
    await deleteSession(store, session);
  }
  return made;
}
