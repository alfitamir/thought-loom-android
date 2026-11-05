import { describe, expect, it, vi } from "vitest";
import { memoryVoiceStore, type Segment } from "./voice-store";
import {
  finishedSegments,
  formatElapsed,
  joinTranscript,
  transcribeFinished,
} from "./voice-session";

describe("formatElapsed", () => {
  it("formats mm:ss with zero padding", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(5)).toBe("00:05");
    expect(formatElapsed(59)).toBe("00:59");
    expect(formatElapsed(65)).toBe("01:05");
    expect(formatElapsed(600)).toBe("10:00");
  });
  it("keeps counting minutes past 59 and clamps junk", () => {
    expect(formatElapsed(3600)).toBe("60:00");
    expect(formatElapsed(3661)).toBe("61:01");
    expect(formatElapsed(-4)).toBe("00:00");
    expect(formatElapsed(65.9)).toBe("01:05");
  });
});

describe("joinTranscript", () => {
  it("joins with exactly one space and trims", () => {
    expect(joinTranscript("أول", "ثانٍ")).toBe("أول ثانٍ");
    expect(joinTranscript("  أول  ", "  ثانٍ ")).toBe("أول ثانٍ");
  });
  it("handles empty sides", () => {
    expect(joinTranscript("", "نص")).toBe("نص");
    expect(joinTranscript("نص", "")).toBe("نص");
    expect(joinTranscript("", "")).toBe("");
  });
});

async function seed(store = memoryVoiceStore(), session = "s1", sizes = [4096, 4096, 4096]) {
  for (let i = 0; i < sizes.length; i++) {
    const seg: Segment = {
      id: `${session}-${i}`,
      session,
      seq: i,
      mime: "audio/webm",
      createdAt: 1000 + i,
    };
    await store.addSegment(seg);
    await store.appendChunk(seg.id, new Blob([new Uint8Array(sizes[i]!)], { type: "audio/webm" }));
  }
  return store;
}

describe("finishedSegments", () => {
  it("returns every segment except the newest, in seq order", async () => {
    const store = await seed();
    const done = await finishedSegments(store, "s1");
    expect(done.map((s) => s.seq)).toEqual([0, 1]);
  });
  it("returns nothing for a single (still recording) segment or another session", async () => {
    const store = await seed(memoryVoiceStore(), "s1", [4096]);
    expect(await finishedSegments(store, "s1")).toEqual([]);
    expect(await finishedSegments(store, "nope")).toEqual([]);
  });
});

describe("transcribeFinished", () => {
  it("transcribes finished segments once, in order, and stores their text", async () => {
    const store = await seed();
    const seen: string[] = [];
    const transcribe = vi.fn(async (audio: Blob) => {
      seen.push(String(audio.size));
      return `نص ${seen.length}`;
    });
    const texts = await transcribeFinished(store, "s1", transcribe);
    expect(texts).toEqual(["نص 1", "نص 2"]);
    expect(transcribe).toHaveBeenCalledTimes(2);
    const segs = await store.listSegments();
    expect(segs.map((s) => s.transcript)).toEqual(["نص 1", "نص 2", undefined]);
    // Second pass: nothing is sent again.
    expect(await transcribeFinished(store, "s1", transcribe)).toEqual([]);
    expect(transcribe).toHaveBeenCalledTimes(2);
  });
  it("marks near-silent pieces as empty without calling the transcriber", async () => {
    const store = await seed(memoryVoiceStore(), "s1", [1200, 4096, 4096]);
    const transcribe = vi.fn(async () => "كلام");
    const texts = await transcribeFinished(store, "s1", transcribe);
    expect(texts).toEqual(["كلام"]);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect((await store.listSegments())[0]!.transcript).toBe("");
  });
  it("keeps an already-transcribed piece and only does the missing ones", async () => {
    const store = await seed();
    await store.setTranscript("s1-0", "قديم");
    const transcribe = vi.fn(async () => "جديد");
    expect(await transcribeFinished(store, "s1", transcribe)).toEqual(["جديد"]);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});
