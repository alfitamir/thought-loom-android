// Written lyrics for a song, extracted from the singing itself. The song
// recording stays the content; this only fills the idea's `text` (the
// lyrics field every serializer and sync already carries) with the words
// as sung. It runs in exactly ONE deliberate place — the editor's
// «استخرج الكلمات من الغنا» button, when the user asks for the words —
// and it NEVER overwrites lyrics that already exist without the user's
// explicit say-so. (An automatic post-save pass existed until the owner
// ruled lyrics are wanted only on request; it is gone, and nothing may
// call the transcription of a song behind his back again.) The
// dictation drain is untouched: it cannot see song audio at all.
import type { Engine } from "./article-ai";
import { getSongAudio, songAudioStore, type SongAudioStore } from "./article-audio";
import { resolveEngine } from "./ai-engine";
import { loadIdeas, updateSong, type Idea } from "./ideas";
import { transcribeSongAudio } from "./transcribe";

// ---------- pending registry ----------
// One extraction at a time per song; the editor derives its «جارٍ استخراج
// الكلمات…» state from here, shared with any other mounted card of the
// same song.
const pending = new Set<string>();
const listeners = new Set<() => void>();

export const isSongLyricsPending = (ideaId: string): boolean => pending.has(ideaId);

/** Subscribe to pending changes; returns the unsubscribe. */
export function onSongLyricsPendingChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const setPending = (ideaId: string, on: boolean) => {
  if (on === pending.has(ideaId)) return;
  if (on) pending.add(ideaId);
  else pending.delete(ideaId);
  listeners.forEach((cb) => cb());
};

// ---------- applying extracted lyrics ----------
/** What may happen to extracted words, given the lyrics already on the song:
 *  fill an empty song outright, ask before replacing written words, or do
 *  nothing when the singing yielded no words at all. Pure — the editor's
 *  extraction flow decides through here. */
export type LyricsDecision = "fill" | "confirm" | "none";
export const decideLyricsApplication = (
  currentLyrics: string,
  extracted: string,
): LyricsDecision => {
  if (!extracted.trim()) return "none";
  return currentLyrics.trim() ? "confirm" : "fill";
};

/**
 * Write extracted lyrics onto a song through the one lyrics write path
 * (`updateSong`), so they sync and back up like hand-written ones.
 * `"fill-if-empty"` re-checks the CURRENT stored lyrics at write time —
 * words the user typed while extraction was running are never clobbered.
 * Returns the updated idea, or undefined when nothing was written. Only
 * the editor's extraction flow calls this — extraction is on request.
 */
export function applySongLyrics(
  ideaId: string,
  lyrics: string,
  mode: "fill-if-empty" | "replace",
): Idea | undefined {
  const current = loadIdeas().find((i) => i.id === ideaId);
  if (!current?.song || !lyrics.trim()) return undefined;
  if (mode === "fill-if-empty" && current.text.trim()) return undefined;
  const updated = updateSong(ideaId, "", lyrics);
  if (updated && typeof window !== "undefined")
    window.dispatchEvent(new Event("afkari:ideas-changed"));
  return updated;
}

// ---------- transcription ----------
export type TranscribeSongFn = (blob: Blob, mime: string, engine: Engine) => Promise<string>;
const defaultTranscribe: TranscribeSongFn = (blob, mime, engine) =>
  transcribeSongAudio(blob, mime, engine, new AbortController().signal);

export type SongLyricsDeps = {
  audioStore?: SongAudioStore;
  engine?: Engine;
  transcribe?: TranscribeSongFn;
};

/**
 * Transcribe one song's recording into its sung lyrics (text only — nothing
 * is written to the idea here; callers decide via `decideLyricsApplication`
 * and `applySongLyrics`). Tracks the pending registry for the whole run.
 * Throws the app's usual guidance when no engine is available, and a clear
 * message when the recording lives on another device.
 */
export async function transcribeSong(ideaId: string, deps: SongLyricsDeps = {}): Promise<string> {
  const idea = loadIdeas().find((i) => i.id === ideaId);
  if (!idea?.song) throw new Error("هذه ليست أغنية مسجلة.");
  const record = await getSongAudio(ideaId, deps.audioStore ?? songAudioStore());
  if (!record)
    throw new Error("التسجيل الصوتي على الجهاز اللي سجّلته عليه، فلا يمكن استخراج كلماته من هنا.");
  let engine = deps.engine;
  if (!engine) {
    const resolved = await resolveEngine();
    if (typeof resolved === "string") throw new Error(resolved);
    engine = resolved;
  }
  setPending(ideaId, true);
  try {
    return await (deps.transcribe ?? defaultTranscribe)(record.blob, record.mime, engine);
  } finally {
    setPending(ideaId, false);
  }
}
