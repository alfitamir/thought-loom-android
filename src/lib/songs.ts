// Song mode: the user records himself SINGING his own songs. The recording
// is the content — segments are assembled into one audio file kept on this
// device, and the idea carries only the title, the lyrics and the song flag.
// Nothing here transcribes or sends audio to any AI: no engine, no key, no
// network. (Written lyrics are extracted from the singing only deliberately
// — the editor's button or the post-save pass in song-lyrics.ts — and never
// by the dictation pipeline.)
import { saveSongAudio, songAudioStore, type SongAudioRecord, type SongAudioStore } from "./article-audio";
import { buildSongIdea, loadIdeas, replaceIdeas, type Idea } from "./ideas";
import { formatElapsed } from "./voice-session";
import type { VoiceStore } from "./voice-store";

/** «أغنية» plus the recording's date and time — the default title, renamed later in the editor. */
export const defaultSongTitle = (at: Date): string =>
  `أغنية ${at.toLocaleDateString("ar")} ${at.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}`;

/** mm:ss label for a song's length, or null when the length is unknown. */
export const songDurationLabel = (idea: Idea): string | null =>
  idea.song && idea.songDuration && idea.songDuration > 0 ? formatElapsed(idea.songDuration) : null;

/** «سُجّلت في {date} · {time}» — a song's creation timestamp IS its recording
 *  moment, so the label just surfaces `createdAt` (Arabic locale, date and
 *  time). Null for non-songs. */
export const songRecordedLabel = (idea: Idea): string | null => {
  if (!idea.song) return null;
  const at = new Date(idea.createdAt);
  return `سُجّلت في ${at.toLocaleDateString("ar")} · ${at.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}`;
};

/**
 * Whether the editor can offer playback for a song: still looking, the
 * recording is on this device, or it lives on another device (a song's
 * audio never syncs — only its title, lyrics and flag do).
 */
export type SongAudioState = "checking" | "ready" | "missing";
export const deriveSongAudioState = (record: SongAudioRecord | null | undefined): SongAudioState =>
  record === undefined ? "checking" : record ? "ready" : "missing";

/**
 * Stitch one recording session's segments into a single audio blob, in
 * segment order — the same same-mime concatenation the TTS cache trusts
 * when it joins PCM chunks. Null when the session has no audio at all.
 */
export async function assembleSongAudio(
  store: VoiceStore,
  session: string,
): Promise<{ blob: Blob; mime: string } | null> {
  const segs = (await store.listSegments())
    .filter((s) => s.session === session)
    .sort((a, b) => a.seq - b.seq);
  if (!segs.length) return null;
  const parts: Blob[] = [];
  for (const seg of segs) parts.push(await store.segmentAudio(seg.id));
  const mime = segs[0]?.mime || "audio/webm";
  const blob = new Blob(parts, { type: mime });
  return blob.size > 0 ? { blob, mime } : null;
}

/**
 * Turn a finished recording session into a saved song: assemble the audio,
 * store it under a fresh idea id, persist the idea, then clear the
 * session's segments. The blob is written BEFORE the idea exists anywhere,
 * so a failed write leaves the segments in place for the recovery pass
 * instead of an idea pointing at audio that was never saved.
 */
export async function saveRecordedSong(input: {
  store: VoiceStore;
  session: string;
  durationSeconds?: number;
  audioStore?: SongAudioStore;
  now?: number;
}): Promise<Idea | null> {
  const assembled = await assembleSongAudio(input.store, input.session);
  if (!assembled) return null;
  const now = input.now ?? Date.now();
  const idea = buildSongIdea({
    title: defaultSongTitle(new Date(now)),
    ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
    createdAt: now,
  });
  await saveSongAudio(
    { ideaId: idea.id, blob: assembled.blob, mime: assembled.mime, duration: input.durationSeconds ?? 0 },
    input.audioStore ?? songAudioStore(),
  );
  replaceIdeas([idea, ...loadIdeas()]);
  const segs = (await input.store.listSegments()).filter((s) => s.session === input.session);
  await Promise.all(segs.map((s) => input.store.deleteSegment(s.id)));
  return idea;
}

/**
 * Song recordings whose save was interrupted (the app closed mid-stop)
 * become songs on a later open — the song counterpart of the idea
 * pipeline's resume pass. The length is estimated from the segment span:
 * every segment but the last is a full rotation.
 */
export async function recoverPendingSongs(input: {
  store: VoiceStore;
  audioStore?: SongAudioStore;
}): Promise<Idea[]> {
  const segs = await input.store.listSegments();
  const sessions = [...new Set(segs.map((s) => s.session))];
  const made: Idea[] = [];
  for (const session of sessions) {
    const mine = segs.filter((s) => s.session === session).sort((a, b) => a.seq - b.seq);
    const first = mine[0];
    if (!first) continue;
    const last = mine[mine.length - 1] ?? first;
    const span = Math.max(1, Math.round((last.createdAt - first.createdAt) / 1000) + 1);
    const idea = await saveRecordedSong({
      store: input.store,
      session,
      durationSeconds: span,
      ...(input.audioStore ? { audioStore: input.audioStore } : {}),
      now: first.createdAt,
    });
    if (idea) made.push(idea);
  }
  return made;
}
