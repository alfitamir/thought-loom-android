// Google Drive backup for song recordings. A song's audio starts life only
// in this device's IndexedDB (article-audio's `songs` store); this module
// uploads a copy of each recording to the «أفكاري — الأغاني» folder in the
// app owner's Google Drive — a regular, visible My Drive folder, not
// appData. The copy is the recording's MP3 export (song-export.ts), never
// the WebM master, so the file plays everywhere — WhatsApp included —
// straight from the folder; copies uploaded before the MP3 switch stay
// as they are and are adopted, not migrated. The pass stamps the idea
// with the file's id (`driveFileId`) through
// the normal idea write path, so every serializer carries it like the
// topic pin and the song flag do. Other devices see the id, and download
// the recording into their own store only when the user asks to play it.
//
// All Drive traffic goes through the authenticated /api/drive/song-audio
// server route, which reaches Drive via the same Lovable connector the
// backup JSON sync uses (drive-sync.server.ts) — there is no client-side
// Drive authorization and no scope of its own. Every failure here is
// silent: an upload that fails is simply retried by the next pass, and a
// Drive file whose deletion failed is tombstoned below and retried too.
import { supabase } from "@/integrations/supabase/client";
import { saveSongAudio, songAudioStore, type SongAudioRecord, type SongAudioStore } from "./article-audio";
import { getArticle, loadIdeas, replaceIdeas, type Idea } from "./ideas";
import { getSongMp3, SONG_MP3_MIME } from "./song-export";

/** The Drive operations the sync pass needs; tests inject a fake. */
export interface SongDriveClient {
  /** The id of the Drive file already holding this song's recording, if any. */
  findSongFile(songId: string): Promise<string | null>;
  /** Upload a recording into the songs folder; returns the new file's id. */
  uploadSong(input: { songId: string; name: string; blob: Blob; mime: string }): Promise<string>;
  /** Download one recording's audio by its Drive file id. */
  downloadSong(fileId: string): Promise<Blob>;
  /** Permanently delete one Drive file. */
  deleteSongFile(fileId: string): Promise<void>;
}

const ENDPOINT = "/api/drive/song-audio";

/** The production client: the server route, with the signed-in session. */
export function serverSongDriveClient(): SongDriveClient {
  const call = async (init: RequestInit): Promise<Response> => {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) throw new Error("not signed in");
    const res = await fetch(ENDPOINT, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) throw new Error(`song drive request failed [${res.status}]`);
    return res;
  };
  const json = async (body: Record<string, string>): Promise<{ fileId?: string | null }> =>
    (await (await call({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json()) as { fileId?: string | null };
  return {
    async findSongFile(songId) {
      return (await json({ action: "find", songId })).fileId ?? null;
    },
    async uploadSong({ songId, name, blob, mime }) {
      const form = new FormData();
      form.set("action", "upload");
      form.set("songId", songId);
      form.set("name", name);
      form.set("file", new File([blob], name, { type: mime }));
      const data = (await (await call({ method: "POST", body: form })).json()) as { fileId?: string | null };
      if (!data.fileId) throw new Error("upload returned no file id");
      return data.fileId;
    },
    async downloadSong(fileId) {
      return (await call({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "download", fileId }),
      })).blob();
    },
    async deleteSongFile(fileId) {
      await json({ action: "delete", fileId });
    },
  };
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/**
 * The Drive file name for a recording: the song's title, made filename-safe,
 * plus its recording date — «{title} — {YYYY-MM-DD}.{ext}». The extension
 * follows the blob's real mime type, never a guess.
 */
export function songDriveFileName(idea: Idea, mime: string): string {
  const title = (getArticle(idea).title || "أغنية")
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "أغنية";
  const date = new Date(idea.createdAt).toISOString().slice(0, 10);
  const ext = EXT_BY_MIME[mime] ?? mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "webm";
  return `${title} — ${date}.${ext}`;
}

// Drive files whose song was deleted here while the delete call could not
// go through (offline, signed out, Drive error). The next pass retries
// them, the same pending-list pattern as the Drive deletion marks in
// ideas.ts — the list holds Drive FILE ids, not idea ids.
const TOMBSTONE_KEY = "afkari.songDriveDeleted";
export const loadSongDriveTombstones = (): string[] => {
  try { return JSON.parse(localStorage.getItem(TOMBSTONE_KEY) || "[]"); } catch { return []; }
};
const writeTombstones = (ids: string[]) => localStorage.setItem(TOMBSTONE_KEY, JSON.stringify([...new Set(ids)]));
export const queueSongDriveDelete = (fileId: string) => writeTombstones([...loadSongDriveTombstones(), fileId]);

export interface SongDriveDeps {
  ideas: Idea[];
  audioStore: SongAudioStore;
  client: SongDriveClient;
  /** The recording's MP3 export (song-export.ts): the Drive copy is
   *  always MP3, so it plays everywhere — WhatsApp included — straight
   *  from the folder. A null result (conversion impossible right now)
   *  skips the upload for this pass; the raw WebM master is never
   *  uploaded as the Drive copy, and the next pass retries. */
  toMp3: (rec: SongAudioRecord) => Promise<Blob | null>;
}

/**
 * One upload pass, with everything injected: tombstoned Drive files are
 * deleted first, then every song that has a recording on this device but
 * no Drive file id gets one — adopting the file already in Drive when a
 * previous upload's response was lost, uploading otherwise. The id is
 * written back onto the idea in local storage as each song lands, so a
 * pass interrupted halfway keeps the ids it already earned. Per-song
 * failures are swallowed; the next pass retries what's still missing.
 * Returns how many songs gained a Drive id in this pass.
 */
export async function runSongAudioPass(deps: SongDriveDeps): Promise<number> {
  const stillPending: string[] = [];
  for (const fileId of loadSongDriveTombstones()) {
    try { await deps.client.deleteSongFile(fileId); } catch { stillPending.push(fileId); }
  }
  writeTombstones(stillPending);

  const local = new Map((await deps.audioStore.listAll()).map((r) => [r.ideaId, r]));
  const ideas = [...deps.ideas];
  let gained = 0;
  for (const idea of ideas) {
    if (!idea.song || idea.driveFileId) continue;
    const rec = local.get(idea.id);
    if (!rec) continue;
    try {
      let fileId = await deps.client.findSongFile(idea.id);
      if (!fileId) {
        const mp3 = await deps.toMp3(rec);
        if (!mp3) continue; // no MP3, no upload — retried by the next pass
        fileId = await deps.client.uploadSong({
          songId: idea.id,
          name: songDriveFileName(idea, SONG_MP3_MIME),
          blob: mp3,
          mime: SONG_MP3_MIME,
        });
      }
      idea.driveFileId = fileId;
      replaceIdeas(ideas);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("afkari:ideas-changed"));
      gained++;
    } catch { /* silent: retried by the next pass */ }
  }
  return gained;
}

let running: Promise<number> | null = null;
let again = false;

/**
 * Back up every not-yet-backed-up song recording to Google Drive.
 * Overlapping calls are coalesced, exactly like syncNow/syncDrive, and it
 * quietly does nothing while offline or signed out (the triggers — app
 * open, cloud sync, reconnect, right after a song is saved — will run it
 * again when either changes).
 */
export function syncSongAudio(): Promise<number> {
  if (running) { again = true; return running; }
  running = run().finally(() => {
    running = null;
    if (again) { again = false; void syncSongAudio(); }
  });
  return running;
}

async function run(): Promise<number> {
  if (!navigator.onLine) return 0;
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) return 0;
  return runSongAudioPass({
    ideas: loadIdeas(),
    audioStore: songAudioStore(),
    client: serverSongDriveClient(),
    toMp3: (rec) => getSongMp3(rec),
  }).catch(() => 0);
}

/**
 * Fetch a song's recording from Google Drive into this device's store —
 * the «تنزيل وتشغيل» action behind the editor's `drive` state. After it
 * resolves, the local record exists and the state derives as `ready`.
 */
export async function downloadSongAudio(
  idea: Idea,
  deps: { audioStore?: SongAudioStore; client?: SongDriveClient } = {},
): Promise<SongAudioRecord> {
  if (!idea.driveFileId) throw new Error("song has no Drive copy");
  const client = deps.client ?? serverSongDriveClient();
  const blob = await client.downloadSong(idea.driveFileId);
  return saveSongAudio(
    { ideaId: idea.id, blob, ...(blob.type ? { mime: blob.type } : {}), duration: idea.songDuration ?? 0 },
    deps.audioStore ?? songAudioStore(),
  );
}

/**
 * Delete a song's Drive copy when the song itself is deleted: attempted
 * immediately, and tombstoned for the upload pass to retry whenever the
 * attempt cannot go through (offline, signed out, Drive error). The local
 * blob's deletion stays with the PR #18 call sites, unchanged.
 */
export async function deleteSongDriveCopy(
  idea: Idea,
  deps: { client?: SongDriveClient; online?: boolean } = {},
): Promise<void> {
  const fileId = idea.driveFileId;
  if (!fileId) return;
  const online = deps.online ?? (typeof navigator === "undefined" || navigator.onLine);
  if (!online) { queueSongDriveDelete(fileId); return; }
  try {
    await (deps.client ?? serverSongDriveClient()).deleteSongFile(fileId);
  } catch {
    queueSongDriveDelete(fileId);
  }
}
