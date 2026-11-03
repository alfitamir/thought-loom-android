import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteSongAudio, getSongAudio, memorySongAudioStore, saveSongAudio,
} from "./article-audio";
import { buildBackup, parseBackup } from "./backup";
import { buildDriveFile, mergeDriveState, parseDriveFile } from "./drive-merge";
import { buildSongIdea, loadIdeas, mergeIdeas, updateSong, type Idea } from "./ideas";
import {
  assembleSongAudio, defaultSongTitle, deriveSongAudioState, recoverPendingSongs,
  saveRecordedSong, songDurationLabel, songRecordedLabel,
} from "./songs";
import { blobToBytes } from "./tts";
import { memoryVoiceStore, type VoiceStore } from "./voice-store";

/** Blob contents as text (jsdom's Blob has no .text()). */
const blobText = async (blob: Blob): Promise<string> => new TextDecoder().decode(await blobToBytes(blob));

/** Seed one recording session's segments, in order, into a voice store. */
const seedSession = async (store: VoiceStore, session: string, parts: string[], startAt = 1_700_000_000_000) => {
  for (let i = 0; i < parts.length; i++) {
    const id = `${session}-seg-${i}`;
    await store.addSegment({ id, session, seq: i, mime: "audio/webm", createdAt: startAt + i * 60_000 });
    await store.appendChunk(id, new Blob([parts[i] ?? ""], { type: "audio/webm" }));
  }
};

const songIdea = (patch: Partial<Idea> = {}): Idea => ({
  id: "song-1",
  text: "كلمات من تأليفي",
  createdAt: 1000,
  articleTitle: "أغنية ١",
  song: true,
  songDuration: 125,
  updatedAt: 1000,
  ...patch,
});

/** The same record as a plain (non-song) edition, for merge-adoption tests. */
const plainEdition = (patch: Partial<Idea> = {}): Idea => {
  const idea = songIdea(patch);
  delete idea.song;
  delete idea.songDuration;
  return idea;
};

describe("assembleSongAudio", () => {
  it("stitches a session's segments into one blob, in segment order, with the session mime", async () => {
    const store = memoryVoiceStore();
    await seedSession(store, "s1", ["AAA", "BBB", "CCC"]);
    await seedSession(store, "other", ["XXX"]);
    const out = await assembleSongAudio(store, "s1");
    expect(out?.mime).toBe("audio/webm");
    expect(out && await blobText(out.blob)).toBe("AAABBBCCC");
  });

  it("returns null for an unknown session and for a session with no audio", async () => {
    const store = memoryVoiceStore();
    expect(await assembleSongAudio(store, "nope")).toBeNull();
    await seedSession(store, "empty", [""]);
    expect(await assembleSongAudio(store, "empty")).toBeNull();
  });
});

describe("saveRecordedSong", () => {
  beforeEach(() => localStorage.clear());

  it("creates a flagged song idea and stores the assembled blob under its id", async () => {
    const voice = memoryVoiceStore();
    const audio = memorySongAudioStore();
    await seedSession(voice, "s1", ["hello ", "world"]);
    const idea = await saveRecordedSong({ store: voice, session: "s1", durationSeconds: 83.6, audioStore: audio, now: 1_700_000_000_000 });
    expect(idea).not.toBeNull();
    expect(idea?.song).toBe(true);
    expect(idea?.text).toBe("");
    expect(idea?.songDuration).toBe(84); // rounded
    expect(idea?.articleTitle).toBe(defaultSongTitle(new Date(1_700_000_000_000)));
    expect(loadIdeas().map((i) => i.id)).toEqual([idea?.id]);
    const rec = await getSongAudio(idea?.id ?? "", audio);
    expect(rec?.mime).toBe("audio/webm");
    expect(rec?.duration).toBe(83.6);
    expect(rec && await blobText(rec.blob)).toBe("hello world");
    // The session's segments are gone once the song is saved.
    expect(await voice.listSegments()).toEqual([]);
  });

  it("saves nothing when the session has no audio", async () => {
    const voice = memoryVoiceStore();
    const audio = memorySongAudioStore();
    expect(await saveRecordedSong({ store: voice, session: "ghost", audioStore: audio })).toBeNull();
    expect(loadIdeas()).toEqual([]);
    expect(await audio.listAll()).toEqual([]);
  });

  it("deleting the song's audio removes the blob from the store", async () => {
    const audio = memorySongAudioStore();
    await saveSongAudio({ ideaId: "s1", blob: new Blob(["x"], { type: "audio/webm" }), duration: 10 }, audio);
    expect(await getSongAudio("s1", audio)).not.toBeNull();
    await deleteSongAudio("s1", audio);
    expect(await getSongAudio("s1", audio)).toBeNull();
  });
});

describe("recoverPendingSongs", () => {
  beforeEach(() => localStorage.clear());

  it("turns leftover sessions into songs, one per session, dated by their first segment", async () => {
    const voice = memoryVoiceStore();
    const audio = memorySongAudioStore();
    await seedSession(voice, "s1", ["a", "b"], 1_700_000_000_000);
    await seedSession(voice, "s2", ["c"], 1_700_100_000_000);
    const made = await recoverPendingSongs({ store: voice, audioStore: audio });
    expect(made).toHaveLength(2);
    expect(made.every((i) => i.song)).toBe(true);
    expect(made.map((i) => i.createdAt).sort()).toEqual([1_700_000_000_000, 1_700_100_000_000]);
    // Two 60s rotations span ~61 estimated seconds; a lone segment ~1.
    const two = made.find((i) => i.createdAt === 1_700_000_000_000);
    expect(two?.songDuration).toBe(61);
    for (const idea of made) expect(await getSongAudio(idea.id, audio)).not.toBeNull();
    expect(await voice.listSegments()).toEqual([]);
    // A second pass finds nothing left to recover.
    expect(await recoverPendingSongs({ store: voice, audioStore: audio })).toEqual([]);
  });
});

describe("song derivations", () => {
  it("derives the editor's audio state from the record lookup", () => {
    expect(deriveSongAudioState(undefined)).toBe("checking");
    expect(deriveSongAudioState(null)).toBe("missing");
    expect(deriveSongAudioState({
      key: "s1", ideaId: "s1", mime: "audio/webm", blob: new Blob(["x"]), duration: 5, createdAt: 1,
    })).toBe("ready");
  });

  it("labels durations as mm:ss and stays silent without one", () => {
    expect(songDurationLabel(songIdea())).toBe("02:05");
    const noDuration = songIdea();
    delete noDuration.songDuration;
    expect(songDurationLabel(noDuration)).toBeNull();
    expect(songDurationLabel(songIdea({ songDuration: 0 }))).toBeNull();
    expect(songDurationLabel({ id: "a", text: "x", createdAt: 1, songDuration: 90 })).toBeNull(); // not a song
  });

  it("default titles start with «أغنية» and carry the recording date", () => {
    const title = defaultSongTitle(new Date(1_700_000_000_000));
    expect(title.startsWith("أغنية ")).toBe(true);
    expect(title.length).toBeGreaterThan("أغنية ".length);
  });

  it("labels a song with its recording date and time, from createdAt", () => {
    const at = new Date(1_700_000_000_000);
    const label = songRecordedLabel(songIdea({ createdAt: at.getTime() }));
    const expected = `سُجّلت في ${at.toLocaleDateString("ar")} · ${at.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}`;
    expect(label).toBe(expected);
    // Non-songs have no recording date.
    expect(songRecordedLabel({ id: "a", text: "x", createdAt: 1 })).toBeNull();
  });
});

describe("song idea editing", () => {
  beforeEach(() => localStorage.clear());

  it("updateSong writes lyrics into text, renames, and refuses non-songs", async () => {
    const voice = memoryVoiceStore();
    const audio = memorySongAudioStore();
    await seedSession(voice, "s1", ["x"]);
    const song = await saveRecordedSong({ store: voice, session: "s1", audioStore: audio });
    if (!song) throw new Error("song was not saved");
    const updated = updateSong(song.id, "  أغنيتي الأولى  ", "سطر أول\nسطر ثانٍ");
    expect(updated?.articleTitle).toBe("أغنيتي الأولى");
    expect(updated?.text).toBe("سطر أول\nسطر ثانٍ");
    expect(updated?.articleBody).toBeUndefined();
    expect(updated?.song).toBe(true);
    // Empty lyrics are allowed — a song can exist before its words are written.
    expect(updateSong(song.id, "أغنيتي الأولى", "")?.text).toBe("");
    // A plain idea is not a song and stays untouched.
    expect(updateSong("missing", "x", "y")).toBeUndefined();
  });

  it("buildSongIdea flags the idea and rounds the duration", () => {
    const idea = buildSongIdea({ title: "  ", durationSeconds: 61.4, createdAt: 42 });
    expect(idea.song).toBe(true);
    expect(idea.articleTitle).toBe("أغنية");
    expect(idea.songDuration).toBe(61);
    expect(idea.createdAt).toBe(42);
    expect(idea.text).toBe("");
  });
});

describe("song flag in serializers", () => {
  it("round-trips through a backup file, flag and duration together", () => {
    const parsed = parseBackup(buildBackup([songIdea()]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.song).toBe(true);
    expect(parsed[0]?.songDuration).toBe(125);
    expect(parsed[0]?.text).toBe("كلمات من تأليفي");
  });

  it("drops a non-boolean flag and a non-positive duration from a backup", () => {
    const raw = JSON.stringify([{ id: "x", text: "t", createdAt: 1, song: "yes", songDuration: -3 }]);
    const parsed = parseBackup(raw);
    expect(parsed[0]?.song).toBeUndefined();
    expect(parsed[0]?.songDuration).toBeUndefined();
  });

  it("round-trips through the Drive file", () => {
    const state = parseDriveFile(buildDriveFile({ ideas: [songIdea()], deleted: [] }));
    expect(state.ideas[0]?.song).toBe(true);
    expect(state.ideas[0]?.songDuration).toBe(125);
  });

  it("mergeIdeas adopts the song flag onto the winning edition, like a topic pin", () => {
    const article = plainEdition({ text: "نسخة أحدث", updatedAt: 2000 });
    const songEdition = songIdea({ updatedAt: 1000 });
    const [winner] = mergeIdeas([article], [songEdition], []);
    expect(winner?.song).toBe(true);
    expect(winner?.songDuration).toBe(125);
    expect(winner?.text).toBe("نسخة أحدث"); // the newer text still wins
  });

  it("mergeIdeas keeps the winner's own duration and never un-songs a song", () => {
    const songA = songIdea({ songDuration: 200, updatedAt: 2000 });
    const songB = songIdea({ songDuration: 125, updatedAt: 1000 });
    const [winner] = mergeIdeas([songA], [songB], []);
    expect(winner?.song).toBe(true);
    expect(winner?.songDuration).toBe(200);
  });

  it("a Drive merge adopts the flag the same way", () => {
    const local = [plainEdition({ updatedAt: 2000 })];
    const drive = { ideas: [songIdea({ updatedAt: 1000 })], deleted: [] };
    const merged = mergeDriveState(drive, local, [], []);
    expect(merged.ideas[0]?.song).toBe(true);
    expect(merged.ideas[0]?.songDuration).toBe(125);
  });
});
