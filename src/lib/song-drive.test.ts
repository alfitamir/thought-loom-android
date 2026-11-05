import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSongAudio, memorySongAudioStore, saveSongAudio } from "./article-audio";
import { buildBackup, parseBackup } from "./backup";
import { createSongDriveOps, SONGS_FOLDER_NAME, type DriveFetch } from "./drive-song.server";
import { loadIdeas, mergeIdeas, replaceIdeas, type Idea } from "./ideas";
import { blobToBytes } from "./tts";
import {
  deleteSongDriveCopy,
  downloadSongAudio,
  loadSongDriveTombstones,
  queueSongDriveDelete,
  runSongAudioPass,
  songDriveFileName,
  type SongDriveClient,
} from "./song-drive";

const songIdea = (patch: Partial<Idea> = {}): Idea => ({
  id: "song-1",
  text: "كلمات",
  createdAt: 1_700_000_000_000,
  articleTitle: "أغنيتي / الأولى",
  song: true,
  songDuration: 95,
  updatedAt: 1000,
  ...patch,
});

/** A SongDriveClient double that records every call and can be told to fail. */
function fakeClient(
  behavior: {
    existing?: Record<string, string>;
    failUploads?: boolean;
    failDeletes?: boolean;
  } = {},
) {
  const calls = {
    find: [] as string[],
    upload: [] as { songId: string; name: string; mime: string }[],
    download: [] as string[],
    remove: [] as string[],
  };
  const client: SongDriveClient = {
    async findSongFile(songId) {
      calls.find.push(songId);
      return behavior.existing?.[songId] ?? null;
    },
    async uploadSong(input) {
      calls.upload.push({ songId: input.songId, name: input.name, mime: input.mime });
      if (behavior.failUploads) throw new Error("drive busy");
      return `drive-${input.songId}`;
    },
    async downloadSong(fileId) {
      calls.download.push(fileId);
      return new Blob(["AUDIO"], { type: "audio/webm" });
    },
    async deleteSongFile(fileId) {
      calls.remove.push(fileId);
      if (behavior.failDeletes) throw new Error("offline");
    },
  };
  return { client, calls };
}

const seedAudio = async (store = memorySongAudioStore(), id = "song-1") => {
  await saveSongAudio(
    { ideaId: id, blob: new Blob(["singing"], { type: "audio/webm" }), duration: 95 },
    store,
  );
  return store;
};

/** The pass's MP3 converter double: hands back an MP3-typed blob. */
const fakeToMp3 = async (rec: { blob: Blob }) => new Blob([rec.blob], { type: "audio/mpeg" });

describe("runSongAudioPass", () => {
  beforeEach(() => localStorage.clear());

  it("uploads only songs that have a local recording and no Drive id yet", async () => {
    const store = await seedAudio();
    await seedAudio(store, "song-2");
    const { client, calls } = fakeClient();
    const ideas = [
      songIdea(), // needs upload
      songIdea({ id: "song-2", driveFileId: "already-there" }), // has a copy
      songIdea({ id: "song-3" }), // no local audio
      { id: "plain", text: "فكرة", createdAt: 5 }, // not a song
    ];
    replaceIdeas(ideas);
    const gained = await runSongAudioPass({ ideas, audioStore: store, client, toMp3: fakeToMp3 });
    expect(gained).toBe(1);
    expect(calls.upload.map((u) => u.songId)).toEqual(["song-1"]);
    // The Drive copy is the MP3 export, never the WebM master.
    expect(calls.upload[0]?.name).toBe(songDriveFileName(songIdea(), "audio/mpeg"));
    expect(calls.upload[0]?.name.endsWith(".mp3")).toBe(true);
    expect(calls.upload[0]?.mime).toBe("audio/mpeg");
    // The id is stamped on the idea in local storage, the normal write path.
    expect(loadIdeas().find((i) => i.id === "song-1")?.driveFileId).toBe("drive-song-1");
  });

  it("adopts the file already in Drive instead of uploading a second copy", async () => {
    const store = await seedAudio();
    const { client, calls } = fakeClient({ existing: { "song-1": "found-in-drive" } });
    const ideas = [songIdea()];
    replaceIdeas(ideas);
    const toMp3 = vi.fn(fakeToMp3);
    const gained = await runSongAudioPass({ ideas, audioStore: store, client, toMp3 });
    expect(gained).toBe(1);
    expect(calls.upload).toEqual([]);
    // Adoption never converts: the existing copy (possibly a pre-MP3
    // WebM one) is taken as it is, not migrated.
    expect(toMp3).not.toHaveBeenCalled();
    expect(loadIdeas()[0]?.driveFileId).toBe("found-in-drive");
  });

  it("keeps the id missing when an upload fails, so the next pass retries it", async () => {
    const store = await seedAudio();
    const { client } = fakeClient({ failUploads: true });
    const ideas = [songIdea()];
    replaceIdeas(ideas);
    expect(await runSongAudioPass({ ideas, audioStore: store, client, toMp3: fakeToMp3 })).toBe(0);
    expect(loadIdeas()[0]?.driveFileId).toBeUndefined();
  });

  it("skips the upload when the recording cannot be converted to MP3 — the raw master never becomes the Drive copy", async () => {
    const store = await seedAudio();
    const { client, calls } = fakeClient();
    const ideas = [songIdea()];
    replaceIdeas(ideas);
    expect(
      await runSongAudioPass({ ideas, audioStore: store, client, toMp3: async () => null }),
    ).toBe(0);
    expect(calls.upload).toEqual([]);
    expect(loadIdeas()[0]?.driveFileId).toBeUndefined();
    // And the next pass, with conversion working again, lands the copy.
    expect(await runSongAudioPass({ ideas, audioStore: store, client, toMp3: fakeToMp3 })).toBe(1);
    expect(calls.upload[0]?.mime).toBe("audio/mpeg");
  });

  it("retries tombstoned Drive deletions and clears only the ones that succeed", async () => {
    queueSongDriveDelete("dead-1");
    queueSongDriveDelete("dead-2");
    const ok = fakeClient();
    await runSongAudioPass({
      ideas: [],
      audioStore: memorySongAudioStore(),
      client: ok.client,
      toMp3: fakeToMp3,
    });
    expect(ok.calls.remove.sort()).toEqual(["dead-1", "dead-2"]);
    expect(loadSongDriveTombstones()).toEqual([]);

    queueSongDriveDelete("dead-3");
    const failing = fakeClient({ failDeletes: true });
    await runSongAudioPass({
      ideas: [],
      audioStore: memorySongAudioStore(),
      client: failing.client,
      toMp3: fakeToMp3,
    });
    expect(loadSongDriveTombstones()).toEqual(["dead-3"]);
  });
});

describe("downloadSongAudio", () => {
  beforeEach(() => localStorage.clear());

  it("stores the downloaded blob under the song id, so the state flips to ready", async () => {
    const store = memorySongAudioStore();
    const { client, calls } = fakeClient();
    const rec = await downloadSongAudio(songIdea({ driveFileId: "drive-9" }), {
      audioStore: store,
      client,
    });
    expect(calls.download).toEqual(["drive-9"]);
    expect(rec.ideaId).toBe("song-1");
    expect(rec.duration).toBe(95);
    const stored = await getSongAudio("song-1", store);
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(await blobToBytes(stored?.blob as Blob))).toBe("AUDIO");
  });

  it("refuses a song with no Drive copy", async () => {
    const { client } = fakeClient();
    await expect(downloadSongAudio(songIdea(), { client })).rejects.toThrow();
  });
});

describe("deleteSongDriveCopy", () => {
  beforeEach(() => localStorage.clear());

  it("deletes immediately when Drive answers, and tombstones when it cannot", async () => {
    const ok = fakeClient();
    await deleteSongDriveCopy(songIdea({ driveFileId: "f1" }), { client: ok.client });
    expect(ok.calls.remove).toEqual(["f1"]);
    expect(loadSongDriveTombstones()).toEqual([]);

    const failing = fakeClient({ failDeletes: true });
    await deleteSongDriveCopy(songIdea({ driveFileId: "f2" }), { client: failing.client });
    expect(loadSongDriveTombstones()).toEqual(["f2"]);
  });

  it("tombstones straight away while offline, and ignores songs without a copy", async () => {
    const { client, calls } = fakeClient();
    await deleteSongDriveCopy(songIdea({ driveFileId: "f3" }), { client, online: false });
    expect(calls.remove).toEqual([]);
    expect(loadSongDriveTombstones()).toEqual(["f3"]);
    await deleteSongDriveCopy(songIdea(), { client });
    expect(loadSongDriveTombstones()).toEqual(["f3"]);
  });
});

describe("songDriveFileName", () => {
  it("uses the sanitized title, the recording date and the real mime's extension", () => {
    expect(songDriveFileName(songIdea(), "audio/webm")).toBe("أغنيتي الأولى — 2023-11-14.webm");
    expect(songDriveFileName(songIdea(), "audio/mp4")).toBe("أغنيتي الأولى — 2023-11-14.m4a");
    expect(songDriveFileName(songIdea(), "audio/mpeg")).toBe("أغنيتي الأولى — 2023-11-14.mp3");
  });
});

describe("driveFileId in serializers", () => {
  it("round-trips through a backup file and is dropped when malformed", () => {
    const parsed = parseBackup(buildBackup([songIdea({ driveFileId: "drive-1" })]));
    expect(parsed[0]?.driveFileId).toBe("drive-1");
    const bad = parseBackup(
      JSON.stringify([{ id: "x", text: "t", createdAt: 1, song: true, driveFileId: 42 }]),
    );
    expect(bad[0]?.driveFileId).toBeUndefined();
    const blank = parseBackup(
      JSON.stringify([{ id: "x", text: "t", createdAt: 1, song: true, driveFileId: "  " }]),
    );
    expect(blank[0]?.driveFileId).toBeUndefined();
  });

  it("mergeIdeas adopts the Drive id onto the winning edition, like the song flag", () => {
    const winnerEdition = songIdea({ text: "نسخة أحدث", updatedAt: 2000 });
    delete winnerEdition.driveFileId;
    const loserEdition = songIdea({ driveFileId: "drive-1", updatedAt: 1000 });
    const [winner] = mergeIdeas([winnerEdition], [loserEdition], []);
    expect(winner?.driveFileId).toBe("drive-1");
    expect(winner?.text).toBe("نسخة أحدث");
  });

  it("mergeIdeas keeps the winner's own Drive id when it has one", () => {
    const a = songIdea({ driveFileId: "mine", updatedAt: 2000 });
    const b = songIdea({ driveFileId: "theirs", updatedAt: 1000 });
    const [winner] = mergeIdeas([a], [b], []);
    expect(winner?.driveFileId).toBe("mine");
  });
});

/** A fake Drive gateway: an in-memory folder + files, answering the v3 calls the ops make. */
function fakeDriveFetch() {
  const state = {
    folder: null as { id: string } | null,
    files: new Map<string, { songId: string; name: string }>(),
    createdFolders: 0,
    deleted: [] as string[],
  };
  let seq = 0;
  const drive: DriveFetch = async (path, init = {}) => {
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    if (path === "drive/v3/files?fields=id") {
      state.createdFolders++;
      state.folder = { id: `folder-${++seq}` };
      return json({ id: state.folder.id });
    }
    if (path.startsWith("drive/v3/files?")) {
      const q = decodeURIComponent(path.split("q=")[1] ?? "");
      if (q.includes("songs-folder")) return json({ files: state.folder ? [state.folder] : [] });
      const songId = /key='songId' and value='([^']+)'/.exec(q)?.[1];
      const hit = [...state.files.entries()].find(([, f]) => f.songId === songId);
      return json({ files: hit ? [{ id: hit[0] }] : [] });
    }
    if (path.startsWith("upload/drive/v3/files")) {
      const text = new TextDecoder().decode(await blobToBytes(init.body as Blob));
      const start = text.indexOf("{");
      const metadata = JSON.parse(text.slice(start, text.indexOf("\r\n--", start))) as {
        name: string;
        appProperties: { songId: string };
        parents: string[];
      };
      const id = `file-${++seq}`;
      state.files.set(id, { songId: metadata.appProperties.songId, name: metadata.name });
      expect(metadata.parents).toEqual([state.folder?.id]);
      return json({ id });
    }
    if (path.includes("?alt=media"))
      return new Response("AUDIO", { headers: { "Content-Type": "audio/webm" } });
    if (init.method === "DELETE") {
      const id = path.replace("drive/v3/files/", "");
      state.deleted.push(id);
      state.files.delete(id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected drive call: ${path}`);
  };
  return { drive, state };
}

describe("createSongDriveOps", () => {
  it("creates the songs folder once, then finds it again on later passes", async () => {
    const { drive, state } = fakeDriveFetch();
    const ops = createSongDriveOps(drive);
    const blob = new Blob(["x"], { type: "audio/webm" });
    await ops.uploadSong({ songId: "s1", name: "أ — 2023-11-14.webm", blob, mime: "audio/webm" });
    await ops.uploadSong({ songId: "s2", name: "ب — 2023-11-14.webm", blob, mime: "audio/webm" });
    expect(state.createdFolders).toBe(1);
    // A fresh ops instance (a later request) finds the marked folder, not a new one.
    const again = createSongDriveOps(drive);
    expect(await again.ensureFolder()).toBe(state.folder?.id);
    expect(state.createdFolders).toBe(1);
    expect(SONGS_FOLDER_NAME).toBe("أفكاري — الأغاني");
  });

  it("finds a song's file by its songId, uploads into the folder, and deletes by id", async () => {
    const { drive, state } = fakeDriveFetch();
    const ops = createSongDriveOps(drive);
    expect(await ops.findSongFile("s1")).toBeNull();
    const id = await ops.uploadSong({
      songId: "s1",
      name: "n.webm",
      blob: new Blob(["x"], { type: "audio/webm" }),
      mime: "audio/webm",
    });
    expect(await ops.findSongFile("s1")).toBe(id);
    const res = await ops.downloadSong(id);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("AUDIO");
    await ops.deleteSongFile(id);
    expect(state.deleted).toEqual([id]);
    expect(await ops.findSongFile("s1")).toBeNull();
  });
});
