import { describe, expect, it } from "vitest";
import {
  articleTextHash, audioFileName, audioKey, deleteArticleAudio, getAudioChunk, getCachedAudio,
  isAudioFresh, listReadyChunks, memoryArticleAudioStore, saveArticleAudio, saveAudioChunk,
  saveAudioManifest, textHash,
} from "./article-audio";
import { blobToBytes, concatPcm, pcmToWav, toSpeechText } from "./tts";

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

  // Adapted for the discriminated getCachedAudio: a v1 record saved through
  // saveArticleAudio now comes back as { kind: "legacy", record, fresh }.
  it("saves, finds fresh, and reports staleness after the text changes", async () => {
    const store = memoryArticleAudioStore();
    const rec = await saveArticleAudio(
      { articleId: "a1", engine: "gemini", voiceKey: "Charon", title: "عنوان", body: "نص المقال", blob: blob() }, store);
    expect(rec.key).toBe("a1:gemini:Charon");
    expect(rec.mime).toBe("audio/wav");
    const cached = await getCachedAudio("a1", "gemini", "Charon", "عنوان", "نص المقال", store);
    expect(cached?.kind).toBe("legacy");
    expect(cached?.fresh).toBe(true);
    if (cached?.kind === "legacy") {
      expect(cached.record.textHash).toBe(rec.textHash);
      expect(cached.blob).toBe(rec.blob);
    }
    expect(isAudioFresh(rec, "عنوان", "نص المقال")).toBe(true);
    expect(isAudioFresh(rec, "عنوان", "نص المقال بعد التعديل")).toBe(false);
    const stale = await getCachedAudio("a1", "gemini", "Charon", "عنوان", "نص المقال بعد التعديل", store);
    expect(stale?.kind).toBe("legacy");
    expect(stale?.fresh).toBe(false);
    expect(await getCachedAudio("a1", "device", "Charon", "عنوان", "نص المقال", store)).toBeNull();
  });

  it("deletes one engine's audio, or all of an article's audio", async () => {
    const store = memoryArticleAudioStore();
    await saveArticleAudio({ articleId: "a2", engine: "gemini", voiceKey: "Charon", title: "ت", body: "ب", blob: blob() }, store);
    await saveArticleAudio({ articleId: "a2", engine: "device", voiceKey: "local", title: "ت", body: "ب", blob: blob() }, store);
    await saveArticleAudio({ articleId: "a3", engine: "gemini", voiceKey: "Charon", title: "ت", body: "ب", blob: blob() }, store);
    await deleteArticleAudio("a2", "gemini", "Charon", store);
    expect(await getCachedAudio("a2", "gemini", "Charon", "ت", "ب", store)).toBeNull();
    expect(await getCachedAudio("a2", "device", "local", "ت", "ب", store)).not.toBeNull();
    await deleteArticleAudio("a2", undefined, undefined, store);
    expect(await getCachedAudio("a2", "device", "local", "ت", "ب", store)).toBeNull();
    expect(await getCachedAudio("a3", "gemini", "Charon", "ت", "ب", store)).not.toBeNull();
  });
});

describe("chunked article audio (v2, memory store)", () => {
  const pcmBlob = (bytes: number[]) => new Blob([new Uint8Array(bytes)], { type: "audio/L16" });
  const saveManifest = (store: ReturnType<typeof memoryArticleAudioStore>, id: string, chunkCount = 3) =>
    saveAudioManifest(
      { articleId: id, engine: "gemini", voiceKey: "Charon", title: "عنوان", body: "نص", chunkCount }, store);
  const saveChunk = (store: ReturnType<typeof memoryArticleAudioStore>, id: string, index: number, bytes: number[]) =>
    saveAudioChunk({ articleId: id, engine: "gemini", voiceKey: "Charon", index, pcm: pcmBlob(bytes) }, store);

  it("round-trips a manifest plus its chunks and lists only the ready indexes", async () => {
    const store = memoryArticleAudioStore();
    const mf = await saveManifest(store, "c1");
    expect(mf.version).toBe(2);
    expect(mf.format).toBe("pcm-chunks");
    expect(mf.chunkCount).toBe(3);
    expect(mf.key).toBe("c1:gemini:Charon");
    await saveChunk(store, "c1", 2, [5, 6]);
    await saveChunk(store, "c1", 0, [1, 2, 3]);
    expect(await listReadyChunks("c1", "gemini", "Charon", store)).toEqual([0, 2]);
    const cached = await getCachedAudio("c1", "gemini", "Charon", "عنوان", "نص", store);
    expect(cached?.kind).toBe("chunks");
    if (cached?.kind === "chunks") {
      expect(cached.readyIndexes).toEqual([0, 2]);
      expect(cached.manifest.chunkCount).toBe(3);
      expect(cached.fresh).toBe(true);
    }
    const chunk0 = await getAudioChunk("c1", "gemini", "Charon", 0, store);
    expect(chunk0 && [...await blobToBytes(chunk0)]).toEqual([1, 2, 3]);
    expect(await getAudioChunk("c1", "gemini", "Charon", 1, store)).toBeNull();
  });

  it("reports a chunked generation stale after the text changes", async () => {
    const store = memoryArticleAudioStore();
    await saveManifest(store, "c2", 2);
    await saveChunk(store, "c2", 0, [1]);
    const cached = await getCachedAudio("c2", "gemini", "Charon", "عنوان", "نص مختلف تمامًا", store);
    expect(cached?.kind).toBe("chunks");
    expect(cached?.fresh).toBe(false);
  });

  it("delete removes the manifest and every chunk, leaving other articles alone", async () => {
    const store = memoryArticleAudioStore();
    await saveManifest(store, "c3", 2);
    await saveChunk(store, "c3", 0, [1]);
    await saveChunk(store, "c3", 1, [2]);
    await saveManifest(store, "c4", 1);
    await saveChunk(store, "c4", 0, [9]);
    await deleteArticleAudio("c3", "gemini", "Charon", store);
    expect(await getCachedAudio("c3", "gemini", "Charon", "عنوان", "نص", store)).toBeNull();
    expect(await listReadyChunks("c3", "gemini", "Charon", store)).toEqual([]);
    expect(await getAudioChunk("c3", "gemini", "Charon", 0, store)).toBeNull();
    expect(await listReadyChunks("c4", "gemini", "Charon", store)).toEqual([0]);
  });

  it("exports the stored chunks as one WAV with the combined data length", async () => {
    const store = memoryArticleAudioStore();
    await saveManifest(store, "c5", 2);
    await saveChunk(store, "c5", 0, [1, 2]);
    await saveChunk(store, "c5", 1, [3, 4, 5]);
    const parts: Uint8Array[] = [];
    for (const i of await listReadyChunks("c5", "gemini", "Charon", store)) {
      const b = await getAudioChunk("c5", "gemini", "Charon", i, store);
      parts.push(await blobToBytes(b!));
    }
    const wav = pcmToWav(concatPcm(parts));
    expect(wav.length).toBe(44 + 5);
    const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(v.getUint32(40, true)).toBe(5);
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4, 5]);
  });
});
