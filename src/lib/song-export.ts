// The MP3 export of a song recording — the ONLY form in which a song
// file leaves this app. The recorder's masters are WebM/Opus (the first
// mime the recorder prefers), and WhatsApp refuses WebM audio files with
// "file not supported", so every exit — the editor's share/download and
// the Google Drive copy in song-drive.ts — goes through `getSongMp3`
// here and comes out `audio/mpeg` with an `.mp3` name. In-app playback
// and lyrics transcription keep using the stored master, untouched.
//
// Conversion is WebAudio decode → lame MP3 encode (@breezystack/lamejs,
// LGPL-3.0; ~480 KB package, loaded lazily via dynamic import so it only
// ships to a device that actually exports a song). The result is cached
// in the audio database's `song-exports` store under a fingerprint of
// the source recording (article-audio.ts), so repeat shares are instant
// and a replaced recording (re-record, Drive restore) re-encodes once.
import { songExportStore, type SongAudioRecord, type SongExportStore } from "./article-audio";

export const SONG_MP3_MIME = "audio/mpeg";

/** What identifies one exact recording of a song: its format, its byte
 *  size, its measured length and the moment this copy was saved. Any of
 *  them changing means the blob under the song is a different recording
 *  and a cached export no longer matches it. */
export const songExportFingerprint = (rec: SongAudioRecord): string =>
  `${rec.mime}|${rec.blob.size}|${rec.duration}|${rec.createdAt}`;

/** The file name a song's MP3 leaves under: the title, filename-safe,
 *  with an `.mp3` extension whatever the master was recorded as. */
export function songMp3FileName(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return `${clean || "أغنية"}.mp3`;
}

const floatTo16Bit = (input: Float32Array): Int16Array => {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
};

/**
 * Encode a decoded audio buffer as a 128 kbps MP3. Songs are one voice
 * (plus room), so mono masters stay mono and stereo keeps both channels.
 * The encoder loads lazily — nothing pays for it until a song is
 * actually exported.
 */
export async function encodeAudioBufferToMp3(buffer: AudioBuffer): Promise<Blob> {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const encoder = new Mp3Encoder(channels, buffer.sampleRate, 128);
  const left = floatTo16Bit(buffer.getChannelData(0));
  const right = channels > 1 ? floatTo16Bit(buffer.getChannelData(1)) : undefined;
  const parts: Uint8Array[] = [];
  const BLOCK = 1152; // one MP3 frame's sample count — lamejs's expected grain
  for (let i = 0; i < left.length; i += BLOCK) {
    const data = right
      ? encoder.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK))
      : encoder.encodeBuffer(left.subarray(i, i + BLOCK));
    if (data.length) parts.push(data);
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(tail);
  return new Blob(parts as BlobPart[], { type: SONG_MP3_MIME });
}

/** Decode any browser-playable recording and re-encode it as MP3. */
export async function convertSongBlobToMp3(blob: Blob): Promise<Blob> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext unavailable");
  const ctx = new Ctor();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    return await encodeAudioBufferToMp3(decoded);
  } finally {
    void ctx.close().catch(() => {});
  }
}

export interface SongMp3Deps {
  exportStore?: SongExportStore;
  /** Blob → MP3 blob; tests inject a double. Defaults to the real
   *  WebAudio + lamejs conversion. */
  convert?: (blob: Blob) => Promise<Blob>;
}

/**
 * The MP3 form of one song recording: the master itself when it already
 * is MP3 (a restored Drive copy), the cached export while its
 * fingerprint still matches, or a fresh conversion that is then cached.
 * Returns null when conversion is impossible on this device (no
 * AudioContext, an undecodable file) — callers decide their fallback;
 * a broken cache never blocks an export, it just re-encodes.
 */
export async function getSongMp3(
  rec: SongAudioRecord,
  deps: SongMp3Deps = {},
): Promise<Blob | null> {
  if (rec.mime === SONG_MP3_MIME) return rec.blob;
  const store = deps.exportStore ?? songExportStore();
  const fingerprint = songExportFingerprint(rec);
  try {
    const cached = await store.get(rec.ideaId);
    if (cached && cached.fingerprint === fingerprint) return cached.blob;
  } catch {
    /* cache unreadable — fall through and re-encode */
  }
  let mp3: Blob;
  try {
    mp3 = await (deps.convert ?? convertSongBlobToMp3)(rec.blob);
  } catch {
    return null;
  }
  try {
    await store.put({
      key: rec.ideaId,
      ideaId: rec.ideaId,
      fingerprint,
      mime: SONG_MP3_MIME,
      blob: mp3,
      createdAt: Date.now(),
    });
  } catch {
    /* cache unwritable — the export itself still succeeds */
  }
  return mp3;
}
