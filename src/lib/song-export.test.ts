import { describe, expect, it, vi } from "vitest";
import {
  memorySongAudioStore, memorySongExportStore, saveSongAudio, type SongAudioRecord,
} from "./article-audio";
import {
  encodeAudioBufferToMp3, getSongMp3, songExportFingerprint, songMp3FileName, SONG_MP3_MIME,
} from "./song-export";
import { blobToBytes } from "./tts";

/** A saved WebM song recording in a memory store, as the recorder left it. */
const seedRecord = async (patch: Partial<SongAudioRecord> = {}): Promise<SongAudioRecord> => {
  const store = memorySongAudioStore();
  const rec = await saveSongAudio(
    { ideaId: "song-1", blob: new Blob(["webm-master"], { type: "audio/webm" }), duration: 95 },
    store,
  );
  return { ...rec, ...patch };
};

describe("songMp3FileName", () => {
  it("always ends in .mp3, whatever the master was", () => {
    expect(songMp3FileName("أغنيتي الأولى")).toBe("أغنيتي الأولى.mp3");
  });

  it("makes the title filename-safe and falls back to «أغنية»", () => {
    expect(songMp3FileName('a/b:c*d?e"f<g>h|i')).toBe("a b c d e f g h i.mp3");
    expect(songMp3FileName("   ")).toBe("أغنية.mp3");
    expect(songMp3FileName("")).toBe("أغنية.mp3");
  });
});

describe("songExportFingerprint", () => {
  it("changes when the recording under the song is replaced", async () => {
    const rec = await seedRecord();
    const base = songExportFingerprint(rec);
    expect(songExportFingerprint({ ...rec })).toBe(base);
    expect(songExportFingerprint({ ...rec, mime: "audio/mp4" })).not.toBe(base);
    expect(songExportFingerprint({ ...rec, duration: 96 })).not.toBe(base);
    expect(songExportFingerprint({ ...rec, createdAt: rec.createdAt + 1 })).not.toBe(base);
    const bigger = await seedRecord({ blob: new Blob(["webm-master-longer"], { type: "audio/webm" }) });
    expect(songExportFingerprint(bigger)).not.toBe(base);
  });
});

describe("getSongMp3", () => {
  it("converts once, then serves the cached export without re-encoding", async () => {
    const rec = await seedRecord();
    const exports = memorySongExportStore();
    const convert = vi.fn(async (_blob: Blob) => new Blob(["mp3-bytes"], { type: SONG_MP3_MIME }));
    const first = await getSongMp3(rec, { exportStore: exports, convert });
    expect(first?.type).toBe(SONG_MP3_MIME);
    expect(first && new TextDecoder().decode(await blobToBytes(first))).toBe("mp3-bytes");
    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert.mock.calls[0]?.[0]).toBe(rec.blob);
    const second = await getSongMp3(rec, { exportStore: exports, convert });
    expect(second).toBe(first); // the very cached blob
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("re-encodes when the underlying recording changed (fingerprint mismatch)", async () => {
    const rec = await seedRecord();
    const exports = memorySongExportStore();
    const convert = vi.fn(async (_blob: Blob) => new Blob(["mp3"], { type: SONG_MP3_MIME }));
    await getSongMp3(rec, { exportStore: exports, convert });
    // The song was re-recorded / its Drive copy restored over the master:
    // a new save timestamp means a different recording.
    const replaced = { ...rec, createdAt: rec.createdAt + 60_000 };
    await getSongMp3(replaced, { exportStore: exports, convert });
    expect(convert).toHaveBeenCalledTimes(2);
  });

  it("passes an MP3 master straight through — a restored Drive copy needs no conversion", async () => {
    const rec = await seedRecord({ mime: "audio/mpeg", blob: new Blob(["already-mp3"], { type: "audio/mpeg" }) });
    const convert = vi.fn(async (_blob: Blob) => new Blob(["x"], { type: SONG_MP3_MIME }));
    const out = await getSongMp3(rec, { exportStore: memorySongExportStore(), convert });
    expect(out).toBe(rec.blob);
    expect(convert).not.toHaveBeenCalled();
  });

  it("returns null when conversion is impossible, caches nothing, and a retry can succeed", async () => {
    const rec = await seedRecord();
    const exports = memorySongExportStore();
    const failing = vi.fn(async (_blob: Blob): Promise<Blob> => { throw new Error("cannot decode"); });
    expect(await getSongMp3(rec, { exportStore: exports, convert: failing })).toBeNull();
    expect(await exports.get("song-1")).toBeNull();
    const working = vi.fn(async (_blob: Blob) => new Blob(["mp3"], { type: SONG_MP3_MIME }));
    expect((await getSongMp3(rec, { exportStore: exports, convert: working }))?.type).toBe(SONG_MP3_MIME);
    expect(working).toHaveBeenCalledTimes(1);
  });

  it("a broken export cache never blocks the export — it just re-encodes", async () => {
    const rec = await seedRecord();
    const broken = {
      get: async (): Promise<never> => { throw new Error("idb gone"); },
      put: async (): Promise<never> => { throw new Error("idb gone"); },
      remove: async () => {},
    };
    const convert = vi.fn(async (_blob: Blob) => new Blob(["mp3"], { type: SONG_MP3_MIME }));
    expect((await getSongMp3(rec, { exportStore: broken, convert }))?.type).toBe(SONG_MP3_MIME);
    expect(convert).toHaveBeenCalledTimes(1);
  });
});

describe("encodeAudioBufferToMp3 (real lamejs)", () => {
  /** A minimal AudioBuffer-shaped double: jsdom has no WebAudio, and the
   *  encoder only reads channels/sampleRate/channel data. */
  const fakeBuffer = (channels: number, seconds = 0.25, sampleRate = 44_100): AudioBuffer => {
    const length = Math.floor(sampleRate * seconds);
    const data = Array.from({ length: channels }, (_, ch) => {
      const arr = new Float32Array(length);
      for (let i = 0; i < length; i++) arr[i] = 0.4 * Math.sin((i / sampleRate) * 2 * Math.PI * (440 + ch * 110));
      return arr;
    });
    return {
      numberOfChannels: channels, sampleRate, length, duration: seconds,
      getChannelData: (ch: number) => data[ch] ?? data[0],
    } as unknown as AudioBuffer;
  };

  it("encodes a mono buffer into a real MP3 stream", async () => {
    const mp3 = await encodeAudioBufferToMp3(fakeBuffer(1));
    expect(mp3.type).toBe(SONG_MP3_MIME);
    expect(mp3.size).toBeGreaterThan(500);
    const bytes = await blobToBytes(mp3);
    // An MP3 frame sync (0xFF 0xEx) or an ID3 tag opens the stream.
    const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const isSync = bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
    expect(isId3 || isSync).toBe(true);
  });

  it("encodes a stereo buffer too", async () => {
    const mp3 = await encodeAudioBufferToMp3(fakeBuffer(2));
    expect(mp3.type).toBe(SONG_MP3_MIME);
    expect(mp3.size).toBeGreaterThan(500);
  });
});
