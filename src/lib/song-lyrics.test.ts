import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySongAudioStore, saveSongAudio, type SongAudioStore } from "./article-audio";
import { buildSongIdea, loadIdeas, replaceIdeas } from "./ideas";
import * as songLyrics from "./song-lyrics";
import {
  applySongLyrics, decideLyricsApplication, isSongLyricsPending,
  transcribeSong, type TranscribeSongFn,
} from "./song-lyrics";
import { recoverPendingSongs, saveRecordedSong } from "./songs";
import { cleanSongLyrics, transcribeSongAudio } from "./transcribe";
import { memoryVoiceStore, type VoiceStore } from "./voice-store";

// The song transcription transport is spied (the real one still runs
// where a test calls it directly): the on-request-only suite below
// asserts that saving a song NEVER reaches it.
vi.mock("./transcribe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transcribe")>();
  return { ...actual, transcribeSongAudio: vi.fn(actual.transcribeSongAudio) };
});

const ENGINE = { kind: "gemini", key: "K" } as const;

/** Seed one saved song: idea in localStorage + its recording in a memory audio store. */
const seedSong = async (lyrics = ""): Promise<{ id: string; audio: SongAudioStore }> => {
  const idea = buildSongIdea({ title: "أغنيتي", createdAt: 1_700_000_000_000 });
  idea.text = lyrics;
  replaceIdeas([idea]);
  const audio = memorySongAudioStore();
  await saveSongAudio({ ideaId: idea.id, blob: new Blob(["sung"], { type: "audio/webm" }), duration: 42 }, audio);
  return { id: idea.id, audio };
};

const lyricsOf = (id: string) => loadIdeas().find((i) => i.id === id)?.text;

describe("cleanSongLyrics", () => {
  it("keeps one line per sung phrase and trims ragged edges", () => {
    expect(cleanSongLyrics("  سطر أول  \n\nسطر ثانٍ \n   \nسطر أخير")).toBe("سطر أول\nسطر ثانٍ\nسطر أخير");
  });

  it("drops the silence marker — a wordless recording yields no lyrics", () => {
    expect(cleanSongLyrics("[صمت]")).toBe("");
    expect(cleanSongLyrics("")).toBe("");
  });
});

describe("decideLyricsApplication", () => {
  it("fills empty lyrics, confirms over written ones, ignores an empty extraction", () => {
    expect(decideLyricsApplication("", "كلمات")).toBe("fill");
    expect(decideLyricsApplication("  ", "كلمات")).toBe("fill");
    expect(decideLyricsApplication("كلماتي", "كلمات")).toBe("confirm");
    expect(decideLyricsApplication("", "  ")).toBe("none");
    expect(decideLyricsApplication("كلماتي", "")).toBe("none");
  });
});

describe("applySongLyrics", () => {
  beforeEach(() => localStorage.clear());

  it("fills empty lyrics through updateSong, keeping title and flag", async () => {
    const { id } = await seedSong("");
    const updated = applySongLyrics(id, "يا ليلي\nيا عيني", "fill-if-empty");
    expect(updated?.text).toBe("يا ليلي\nيا عيني");
    expect(updated?.articleTitle).toBe("أغنيتي");
    expect(updated?.song).toBe(true);
    expect(lyricsOf(id)).toBe("يا ليلي\nيا عيني");
  });

  it("fill-if-empty never overwrites words already on the song", async () => {
    const { id } = await seedSong("كلمات كتبتها بنفسي");
    expect(applySongLyrics(id, "كلمات مستخرجة", "fill-if-empty")).toBeUndefined();
    expect(lyricsOf(id)).toBe("كلمات كتبتها بنفسي");
  });

  it("replace overwrites — only the editor's explicit confirm uses it", async () => {
    const { id } = await seedSong("كلمات قديمة");
    expect(applySongLyrics(id, "كلمات جديدة", "replace")?.text).toBe("كلمات جديدة");
    expect(lyricsOf(id)).toBe("كلمات جديدة");
  });

  it("refuses non-songs and empty extractions", async () => {
    const { id } = await seedSong("");
    expect(applySongLyrics(id, "   ", "replace")).toBeUndefined();
    expect(applySongLyrics("missing-id", "كلمات", "replace")).toBeUndefined();
  });
});

describe("transcribeSong", () => {
  beforeEach(() => localStorage.clear());

  it("sends the stored recording to the transcription transport and returns the words", async () => {
    const { id, audio } = await seedSong("");
    const seen: string[] = [];
    const transcribe: TranscribeSongFn = async (blob, mime) => {
      seen.push(mime, String(blob.size));
      return "سطر أول\nسطر ثانٍ";
    };
    await expect(transcribeSong(id, { audioStore: audio, engine: ENGINE, transcribe })).resolves.toBe("سطر أول\nسطر ثانٍ");
    expect(seen).toEqual(["audio/webm", "4"]);
  });

  it("marks the song pending for the whole run, and clears it after success", async () => {
    const { id, audio } = await seedSong("");
    let during: boolean | undefined;
    const transcribe: TranscribeSongFn = async () => { during = isSongLyricsPending(id); return "كلمات"; };
    expect(isSongLyricsPending(id)).toBe(false);
    await transcribeSong(id, { audioStore: audio, engine: ENGINE, transcribe });
    expect(during).toBe(true);
    expect(isSongLyricsPending(id)).toBe(false);
  });

  it("clears pending after a failure too, and the error reaches the caller", async () => {
    const { id, audio } = await seedSong("");
    const transcribe: TranscribeSongFn = async () => { throw new Error("انقطع الاتصال"); };
    await expect(transcribeSong(id, { audioStore: audio, engine: ENGINE, transcribe })).rejects.toThrow("انقطع الاتصال");
    expect(isSongLyricsPending(id)).toBe(false);
  });

  it("refuses when the recording lives on another device", async () => {
    const { id } = await seedSong("");
    await expect(transcribeSong(id, { audioStore: memorySongAudioStore(), engine: ENGINE, transcribe: async () => "x" }))
      .rejects.toThrow("على الجهاز اللي سجّلته عليه");
  });
});

describe("lyrics are extracted on request only (owner's rule)", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it("the module exposes no automatic extraction entry point at all", () => {
    expect("autoExtractSongLyrics" in songLyrics).toBe(false);
  });

  /** Seed one recording session into a voice store, as the recorder left it. */
  const seedSession = async (store: VoiceStore, session: string, parts: string[]) => {
    for (let i = 0; i < parts.length; i++) {
      const id = `${session}-seg-${i}`;
      await store.addSegment({ id, session, seq: i, mime: "audio/webm", createdAt: 1_700_000_000_000 + i * 60_000 });
      await store.appendChunk(id, new Blob([parts[i] ?? ""], { type: "audio/webm" }));
    }
  };

  it("saving a song with a personal Gemini key present triggers NO extraction call", async () => {
    // The old automatic pass fired in exactly this situation: a fresh
    // song saved while his own key was configured.
    localStorage.setItem("afkari.geminiKey", "K");
    const voice = memoryVoiceStore();
    const audio = memorySongAudioStore();
    await seedSession(voice, "s1", ["hello ", "world"]);
    const idea = await saveRecordedSong({ store: voice, session: "s1", durationSeconds: 30, audioStore: audio });
    expect(idea?.song).toBe(true);
    expect(vi.mocked(transcribeSongAudio)).not.toHaveBeenCalled();
    expect(idea?.text).toBe("");
    expect(isSongLyricsPending(idea?.id ?? "")).toBe(false);
  });

  it("recovering an interrupted song save triggers NO extraction call either", async () => {
    localStorage.setItem("afkari.geminiKey", "K");
    const voice = memoryVoiceStore();
    const audio = memorySongAudioStore();
    await seedSession(voice, "s2", ["sung words"]);
    const made = await recoverPendingSongs({ store: voice, audioStore: audio });
    expect(made).toHaveLength(1);
    expect(vi.mocked(transcribeSongAudio)).not.toHaveBeenCalled();
    expect(made[0]?.text).toBe("");
  });

  it("the manual path still works end-to-end: the editor's request fills empty lyrics", async () => {
    const { id, audio } = await seedSong("");
    const text = await transcribeSong(id, { audioStore: audio, engine: ENGINE, transcribe: async () => "غنّيتها\nمن قلبي" });
    const updated = applySongLyrics(id, text, "fill-if-empty");
    expect(updated?.text).toBe("غنّيتها\nمن قلبي");
    expect(lyricsOf(id)).toBe("غنّيتها\nمن قلبي");
  });
});

describe("transcribeSongAudio (transport)", () => {
  it("the cloud path flags the upload as a song and keeps the sung lines", async () => {
    let form: FormData | undefined;
    const sse = `data: {"type":"transcript.text.done","text":"سطر أول\\nسطر ثانٍ"}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: FormData }) => {
      form = init.body;
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));
    try {
      const text = await transcribeSongAudio(new Blob(["sung"], { type: "audio/webm" }), "audio/webm",
        { kind: "cloud", token: "T" }, new AbortController().signal);
      expect(text).toBe("سطر أول\nسطر ثانٍ");
      expect(form?.get("song")).toBe("1");
      expect(form?.get("file")).toBeInstanceOf(File);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
