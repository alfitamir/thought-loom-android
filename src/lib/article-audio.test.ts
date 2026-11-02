import { describe, expect, it } from "vitest";
import {
  articleTextHash, audioFileName, audioKey, deleteArticleAudio, getCachedAudio,
  isAudioFresh, memoryArticleAudioStore, saveArticleAudio, textHash,
} from "./article-audio";
import { toSpeechText } from "./tts";

describe("textHash", () => {
  it("is stable, 8 hex chars, and changes with the text", () => {
    expect(textHash("مرحبًا")).toMatch(/^[0-9a-f]{8}$/);
    expect(textHash("مرحبًا")).toBe(textHash("مرحبًا"));
    expect(textHash("مرحبًا")).not.toBe(textHash("مرحبًا!"));
    expect(textHash("")).not.toBe(textHash("ا"));
  });

  it("hashes exactly the spoken text of the article", () => {
    expect(articleTextHash("عنوان", "نص المقال")).toBe(textHash(toSpeechText("عنوان", "نص المقال")));
  });
});

describe("audioKey + audioFileName", () => {
  it("builds composite cache keys", () => {
    expect(audioKey("id1", "gemini", "Charon")).toBe("id1:gemini:Charon");
  });

  it("keeps Arabic titles and maps mime to extension", () => {
    expect(audioFileName("رحلتي إلى مكة", "audio/wav")).toBe("رحلتي إلى مكة.wav");
    expect(audioFileName("مقال", "audio/mpeg")).toBe("مقال.mp3");
    expect(audioFileName("مقال", "audio/x-unknown")).toBe("مقال.audio");
  });

  it("sanitizes path-hostile characters and falls back for empty titles", () => {
    expect(audioFileName('a/b:c?"d"<e>|f', "audio/wav")).toBe("a b c d e f.wav");
    expect(audioFileName("   ", "audio/wav")).toBe("مقال.wav");
    expect(audioFileName("", "audio/wav")).toBe("مقال.wav");
    const long = audioFileName("ط".repeat(100), "audio/wav");
    expect(long.endsWith(".wav")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(64);
  });
});

describe("cached article audio (memory store)", () => {
  const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });

  it("saves, finds fresh, and reports staleness after the text changes", async () => {
    const store = memoryArticleAudioStore();
    const rec = await saveArticleAudio(
      { articleId: "a1", engine: "gemini", voiceKey: "Charon", title: "عنوان", body: "نص المقال", blob: blob() }, store);
    expect(rec.key).toBe("a1:gemini:Charon");
    expect(rec.mime).toBe("audio/wav");
    const cached = await getCachedAudio("a1", "gemini", "Charon", store);
    expect(cached?.textHash).toBe(rec.textHash);
    expect(isAudioFresh(rec, "عنوان", "نص المقال")).toBe(true);
    expect(isAudioFresh(rec, "عنوان", "نص المقال بعد التعديل")).toBe(false);
    expect(await getCachedAudio("a1", "device", "Charon", store)).toBeNull();
  });

  it("deletes one engine's audio, or all of an article's audio", async () => {
    const store = memoryArticleAudioStore();
    await saveArticleAudio({ articleId: "a2", engine: "gemini", voiceKey: "Charon", title: "ت", body: "ب", blob: blob() }, store);
    await saveArticleAudio({ articleId: "a2", engine: "device", voiceKey: "local", title: "ت", body: "ب", blob: blob() }, store);
    await saveArticleAudio({ articleId: "a3", engine: "gemini", voiceKey: "Charon", title: "ت", body: "ب", blob: blob() }, store);
    await deleteArticleAudio("a2", "gemini", "Charon", store);
    expect(await getCachedAudio("a2", "gemini", "Charon", store)).toBeNull();
    expect(await getCachedAudio("a2", "device", "local", store)).not.toBeNull();
    await deleteArticleAudio("a2", undefined, undefined, store);
    expect(await getCachedAudio("a2", "device", "local", store)).toBeNull();
    expect(await getCachedAudio("a3", "gemini", "Charon", store)).not.toBeNull();
  });
});
