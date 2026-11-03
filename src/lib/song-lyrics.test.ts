import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySongAudioStore, saveSongAudio, type SongAudioStore } from "./article-audio";
import { buildSongIdea, loadIdeas, replaceIdeas } from "./ideas";
import {
  applySongLyrics, autoExtractSongLyrics, decideLyricsApplication, isSongLyricsPending,
  transcribeSong, type TranscribeSongFn,
} from "./song-lyrics";
import { cleanSongLyrics, transcribeSongAudio } from "./transcribe";

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

describe("autoExtractSongLyrics", () => {
  beforeEach(() => localStorage.clear());

  it("does nothing at all without a Gemini key", async () => {
    const { id, audio } = await seedSong("");
    const transcribe = vi.fn<TranscribeSongFn>(async () => "كلمات");
    expect(await autoExtractSongLyrics(id, { key: "", audioStore: audio, transcribe })).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
    expect(lyricsOf(id)).toBe("");
  });

  it("with a key, fills a fresh song's empty lyrics in the background", async () => {
    const { id, audio } = await seedSong("");
    const updated = await autoExtractSongLyrics(id, {
      key: "K", audioStore: audio, transcribe: async () => "غنّيتها\nمن قلبي",
    });
    expect(updated?.text).toBe("غنّيتها\nمن قلبي");
    expect(lyricsOf(id)).toBe("غنّيتها\nمن قلبي");
    expect(isSongLyricsPending(id)).toBe(false);
  });

  it("never overwrites lyrics typed while extraction was running", async () => {
    const { id, audio } = await seedSong("");
    const transcribe: TranscribeSongFn = async () => {
      // The user writes the words himself mid-extraction — his text wins.
      applySongLyrics(id, "كتبتها بنفسي أثناء الاستخراج", "replace");
      return "كلمات مستخرجة";
    };
    expect(await autoExtractSongLyrics(id, { key: "K", audioStore: audio, transcribe })).toBeNull();
    expect(lyricsOf(id)).toBe("كتبتها بنفسي أثناء الاستخراج");
  });

  it("stays silent on failure: no lyrics, no throw, pending cleared", async () => {
    const { id, audio } = await seedSong("");
    const transcribe: TranscribeSongFn = async () => { throw new Error("quota"); };
    expect(await autoExtractSongLyrics(id, { key: "K", audioStore: audio, transcribe })).toBeNull();
    expect(lyricsOf(id)).toBe("");
    expect(isSongLyricsPending(id)).toBe(false);
  });

  it("an extraction with no words fills nothing", async () => {
    const { id, audio } = await seedSong("");
    expect(await autoExtractSongLyrics(id, { key: "K", audioStore: audio, transcribe: async () => "" })).toBeNull();
    expect(lyricsOf(id)).toBe("");
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
