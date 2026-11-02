// Glue between the home recorder screen and the voice pipeline
// (audio-recorder → voice-store → transcribe). The recorder saves the
// microphone audio second by second and closes a segment file every minute;
// this module owns the rules for turning finished segments into text in
// order, exactly once, so the screen stays a thin wiring layer.
import type { Segment, VoiceStore } from "./voice-store";

const bySeq = (a: Segment, b: Segment) => a.seq - b.seq;

/** Transcribes one finished audio piece. The screen supplies the engine-backed one. */
export type SegmentTranscriber = (audio: Blob, mime: string) => Promise<string>;

/** mm:ss timer text; minutes keep counting past 59 (a dictation can run long). */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Append a transcript piece after existing text with exactly one space between. */
export function joinTranscript(base: string, addition: string): string {
  const a = base.trim();
  const b = addition.trim();
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

/**
 * Segments of the session whose audio is complete. While recording, the
 * newest segment is still receiving a chunk every second, so every segment
 * except that one is finished and safe to transcribe.
 */
export async function finishedSegments(store: VoiceStore, session: string): Promise<Segment[]> {
  const segs = (await store.listSegments()).filter((s) => s.session === session).sort(bySeq);
  return segs.slice(0, -1);
}

/**
 * Transcribe every finished segment that has no text yet and return the new
 * texts in segment order. Each segment's text is stored as it lands (the
 * pipeline rule: a finished piece is never sent twice), so an interrupted
 * pass resumes where it stopped. Near-silent pieces (< 2 KB, the pipeline's
 * own threshold in transcribe.ts) become empty text without a network call.
 */
export async function transcribeFinished(
  store: VoiceStore,
  session: string,
  transcribe: SegmentTranscriber,
): Promise<string[]> {
  const texts: string[] = [];
  for (const seg of await finishedSegments(store, session)) {
    if (seg.transcript !== undefined) continue;
    const audio = await store.segmentAudio(seg.id);
    const text = audio.size < 2000 ? "" : await transcribe(audio, seg.mime);
    await store.setTranscript(seg.id, text);
    if (text) texts.push(text);
  }
  return texts;
}
