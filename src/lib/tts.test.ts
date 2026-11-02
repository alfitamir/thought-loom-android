import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64ToBytes, buildGeminiTtsRequest, GEMINI_TTS_VOICE, parseGeminiTtsAudio, pcmToWav,
  speakWithDevice, splitForSpeech, synthesizeGemini, toSpeechText,
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
    const sentence = `${"كلمة ".repeat(120).trim()}.`;
    const fetch = vi.fn()
      .mockResolvedValueOnce(geminiOk([1, 2]))
      .mockResolvedValueOnce(geminiOk([3, 4, 5, 6]));
    vi.stubGlobal("fetch", fetch);
    const progress: [number, number][] = [];
    const blob = await synthesizeGemini(`${sentence} ${sentence}`, "k", { onProgress: (d, t) => progress.push([d, t]) });
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
