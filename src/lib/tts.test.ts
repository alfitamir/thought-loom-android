import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64ToBytes, buildGeminiTtsRequest, concatPcm, GEMINI_TTS_VOICE, mapWithConcurrency,
  parseGeminiTtsAudio, pcmToWav, speakWithDevice, splitForSpeech, synthesizeGemini,
  synthesizeGeminiChunks, synthesizeGeminiChunk, toSpeechText,
} from "./tts";

afterEach(() => vi.unstubAllGlobals());

describe("splitForSpeech", () => {
  it("chunks Arabic sentences without exceeding maxChars and loses nothing", () => {
    const text = "ذهب الرجل إلى السوق صباحًا. اشترى خبزًا وحليبًا وفاكهة. ثم عاد إلى البيت قبل الظهر.";
    const chunks = splitForSpeech(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
    expect(chunks.join(" ")).toBe(text);
  });

  it("splits on Arabic question marks and Latin punctuation alike", () => {
    const chunks = splitForSpeech("هل أنت بخير؟ نعم، أنا بخير! شكرًا لك.", 12);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.join(" ")).toContain("هل أنت بخير؟");
    const latin = splitForSpeech("Hello world. How are you? Fine.", 14);
    expect(latin.join(" ")).toBe("Hello world. How are you? Fine.");
    for (const c of latin) expect(c.length).toBeLessThanOrEqual(14);
  });

  it("hard-splits one very long sentence at word boundaries", () => {
    const long = `${"كلمة ".repeat(60).trim()}، ثم انتهى الكلام`;
    const chunks = splitForSpeech(long, 50);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(long);
  });

  it("preserves diacritics exactly — they guide pronunciation", () => {
    const vocalized = "قَالَ الرَّجُلُ: السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللَّهِ. فَرَدَّ عَلَيْهِ بِابْتِسَامَةٍ.";
    const chunks = splitForSpeech(vocalized, 45);
    expect(chunks.join(" ")).toBe(vocalized);
    expect(chunks.join(" ")).toContain("السَّلَامُ");
  });

  it("flows sentences across paragraph breaks and returns [] for empty text", () => {
    const text = "فقرة أولى قصيرة.\n\nفقرة ثانية قصيرة.";
    expect(splitForSpeech(text, 900)).toEqual(["فقرة أولى قصيرة. فقرة ثانية قصيرة."]);
    expect(splitForSpeech("")).toEqual([]);
    expect(splitForSpeech("  \n \n ")).toEqual([]);
  });
});

describe("toSpeechText", () => {
  it("joins title and body and strips markdown marks", () => {
    expect(toSpeechText("# عنوان", "نص **مهم** جدًا.\n\n## قسم\nالمحتوى `هنا`."))
      .toBe("عنوان\n\nنص مهم جدًا.\n\nقسم\nالمحتوى هنا.");
  });
});

describe("pcmToWav", () => {
  it("writes a valid 44-byte WAV header around the PCM", () => {
    const pcm = new Uint8Array([0, 0, 255, 127, 0, 128, 10, 20]);
    const wav = pcmToWav(pcm, 24000);
    expect(wav.length).toBe(44 + pcm.length);
    const str = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n));
    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(str(12, 4)).toBe("fmt ");
    expect(str(36, 4)).toBe("data");
    const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(v.getUint32(4, true)).toBe(36 + pcm.length);
    expect(v.getUint32(24, true)).toBe(24000); // sample rate
    expect(v.getUint16(34, true)).toBe(16); // bits per sample
    expect(v.getUint32(40, true)).toBe(pcm.length); // data size
    expect([...wav.slice(44)]).toEqual([...pcm]);
  });
});

describe("base64ToBytes + parseGeminiTtsAudio", () => {
  it("round-trips bytes through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const b64 = btoa(String.fromCharCode(...bytes));
    expect([...base64ToBytes(b64)]).toEqual([...bytes]);
  });

  it("extracts PCM from a Gemini TTS response and rejects empty ones", () => {
    const pcm = new Uint8Array([9, 8, 7, 6]);
    const json = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: btoa(String.fromCharCode(...pcm)) } }] } }] };
    expect([...parseGeminiTtsAudio(json)]).toEqual([...pcm]);
    expect(() => parseGeminiTtsAudio({})).toThrow("لم يصل صوت");
    expect(() => parseGeminiTtsAudio(null)).toThrow("لم يصل صوت");
  });
});

describe("buildGeminiTtsRequest", () => {
  it("asks for audio with the configured prebuilt voice", () => {
    const req = buildGeminiTtsRequest("مرحبًا");
    expect(req.contents).toEqual([{ parts: [{ text: "مرحبًا" }] }]);
    expect(req.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(req.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(GEMINI_TTS_VOICE);
  });
});

const geminiOk = (bytes: number[]) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: btoa(String.fromCharCode(...bytes)) } }] } }],
}), { status: 200 });

describe("synthesizeGemini", () => {
  it("wraps one chunk of PCM into a single WAV blob and calls the TTS model with the key header", async () => {
    const fetch = vi.fn().mockResolvedValue(geminiOk([1, 2, 3, 4]));
    vi.stubGlobal("fetch", fetch);
    const blob = await synthesizeGemini("جملة واحدة قصيرة.", "KEY123");
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 4);
    const call = fetch.mock.calls[0];
    expect(String(call?.[0])).toContain("gemini-2.5-flash-preview-tts:generateContent");
    expect((call?.[1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": "KEY123" });
  });

  it("concatenates PCM across chunks into one file and reports progress", async () => {
    // maxChars is pinned to the old 900 default: the production default rose
    // to 1800, which would make this text a single chunk.
    const sentence = `${"كلمة ".repeat(120).trim()}.`;
    const fetch = vi.fn()
      .mockResolvedValueOnce(geminiOk([1, 2]))
      .mockResolvedValueOnce(geminiOk([3, 4, 5, 6]));
    vi.stubGlobal("fetch", fetch);
    const progress: [number, number][] = [];
    const blob = await synthesizeGemini(`${sentence} ${sentence}`, "k", { maxChars: 900, onProgress: (d, t) => progress.push([d, t]) });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(blob.size).toBe(44 + 6);
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  it("surfaces the Arabic key message on 403 and never fetches without a key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "denied" } }), { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(synthesizeGemini("نص.", "bad")).rejects.toThrow("مفتاح Gemini");
    await expect(synthesizeGemini("نص.", "")).rejects.toThrow("أضف مفتاح Gemini");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("speakWithDevice", () => {
  class FakeUtterance {
    lang = ""; rate = 1; voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) { utterances.push(this); }
  }
  const utterances: FakeUtterance[] = [];

  it("speaks chunk by chunk with the Arabic voice, reports progress, and stop() ends it", async () => {
    utterances.length = 0;
    const synth = {
      getVoices: () => [{ lang: "ar-EG", name: "Arabic" }],
      speak: vi.fn(), cancel: vi.fn(),
    };
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const seen: [number, number][] = [];
    const speech = speakWithDevice("جملة واحدة.", { rate: 1.25, onChunk: (i, t) => seen.push([i, t]) });
    expect(synth.speak).toHaveBeenCalledTimes(1);
    const first = utterances[0]!;
    expect(first.lang).toBe("ar-EG");
    expect(first.rate).toBe(1.25);
    expect(seen).toEqual([[0, 1]]);
    first.onend?.();
    await expect(speech.done).resolves.toBeUndefined();

    const second = speakWithDevice("جملة أخرى.", {});
    second.stop();
    expect(synth.cancel).toHaveBeenCalled();
    await expect(second.done).resolves.toBeUndefined();
  });

  it("throws a clear Arabic error when the device has no speech voice", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    expect(() => speakWithDevice("نص.", {})).toThrow("صوت الجهاز غير متاح");
  });
});

const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

describe("concatPcm", () => {
  it("joins PCM parts in order and tolerates empties", () => {
    expect([...concatPcm([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([])])]).toEqual([1, 2, 3]);
    expect(concatPcm([]).length).toBe(0);
  });

  it("exports as one WAV whose data chunk is the sum of the parts", () => {
    const wav = pcmToWav(concatPcm([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]));
    expect(wav.length).toBe(44 + 5);
    const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(v.getUint32(40, true)).toBe(5);
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order even when later items finish first", async () => {
    const results = await mapWithConcurrency([0, 1, 2, 3, 4], 5, async (n) => {
      await delay((5 - n) * 10);
      return n * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40]);
  });

  it("never runs more than the limit in flight", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      maxSeen = Math.max(maxSeen, inFlight);
      await delay(15);
      inFlight--;
      return n;
    });
    expect(results).toEqual([1, 2, 3, 4, 5, 6]);
    expect(maxSeen).toBe(2);
  });

  it("propagates the first error and starts no new work after it", async () => {
    const started: number[] = [];
    await expect(mapWithConcurrency([0, 1, 2, 3], 2, async (n) => {
      started.push(n);
      if (n === 0) { await delay(5); throw new Error("boom"); }
      await delay(40);
      return n;
    })).rejects.toThrow("boom");
    expect(started).toEqual([0, 1]);
  });

  it("rejects with AbortError without calling fn when the signal is already aborted", async () => {
    const fn = vi.fn(async (n: number) => n);
    const controller = new AbortController();
    controller.abort();
    const err = await mapWithConcurrency([1, 2], 2, fn, controller.signal).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("synthesizeGeminiChunks", () => {
  const TEXT = "أول جملة قصيرة. ثاني جملة قصيرة. ثالث جملة قصيرة.";
  // Per-chunk fake latencies: chunk 1 lands first, then 2, then 0.
  const PLAN: Record<string, { ms: number; byte: number }> = {
    "أول جملة قصيرة.": { ms: 45, byte: 10 },
    "ثاني جملة قصيرة.": { ms: 5, byte: 20 },
    "ثالث جملة قصيرة.": { ms: 25, byte: 30 },
  };
  const fakeFetch = () => vi.fn(async (_url: unknown, init?: RequestInit) => {
    const text = (JSON.parse(String(init?.body)) as { contents: { parts: { text: string }[] }[] })
      .contents[0]!.parts[0]!.text;
    const plan = PLAN[text]!;
    await delay(plan.ms);
    return geminiOk([plan.byte]);
  });

  it("fires onChunkReady per completion (out of order) and resolves in text order", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const ready: number[] = [];
    const parts = await synthesizeGeminiChunks(TEXT, "k", {
      maxChars: 20,
      onChunkReady: (i) => ready.push(i),
    });
    expect(ready).toEqual([1, 2, 0]);
    expect(parts.map((p) => [...p])).toEqual([[10], [20], [30]]);
  });

  it("synthesizeGeminiChunk returns the PCM of a single chunk", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    expect([...await synthesizeGeminiChunk("ثاني جملة قصيرة.", "k")]).toEqual([20]);
  });

  it("never fetches without a key, and rejects empty text", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(synthesizeGeminiChunks(TEXT, "")).rejects.toThrow("أضف مفتاح Gemini");
    await expect(synthesizeGeminiChunks("  ", "k")).rejects.toThrow("لا يوجد نص");
    expect(fetch).not.toHaveBeenCalled();
  });
});
