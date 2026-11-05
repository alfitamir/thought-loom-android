import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64ToBytes,
  buildGeminiTtsRequest,
  buildInteractionsTtsRequest,
  concatPcm,
  createTtsSession,
  CURRENT_TTS_VOICE_KEY,
  GEMINI_TTS_VOICE,
  isModelUnavailable,
  isReplicatedVoiceId,
  isVoiceUnavailable,
  mapWithConcurrency,
  modelForVoiceKey,
  parseGeminiTtsAudio,
  parseInteractionsTtsAudio,
  pcmToWav,
  speakWithDevice,
  splitForSpeech,
  synthesizeGemini,
  synthesizeGeminiChunks,
  synthesizeGeminiChunk,
  synthesizeGeminiChunkWithModel,
  toSpeechText,
  ttsVoiceKey,
  unwrapPcm,
  voicePartOfKey,
  VoiceUnavailableError,
} from "./tts";

afterEach(() => vi.unstubAllGlobals());

describe("splitForSpeech", () => {
  it("chunks Arabic sentences without exceeding maxChars and loses nothing", () => {
    const text =
      "ذهب الرجل إلى السوق صباحًا. اشترى خبزًا وحليبًا وفاكهة. ثم عاد إلى البيت قبل الظهر.";
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
    const vocalized =
      "قَالَ الرَّجُلُ: السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللَّهِ. فَرَدَّ عَلَيْهِ بِابْتِسَامَةٍ.";
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
    expect(toSpeechText("# عنوان", "نص **مهم** جدًا.\n\n## قسم\nالمحتوى `هنا`.")).toBe(
      "عنوان\n\nنص مهم جدًا.\n\nقسم\nالمحتوى هنا.",
    );
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
    const json = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/L16;rate=24000",
                  data: btoa(String.fromCharCode(...pcm)),
                },
              },
            ],
          },
        },
      ],
    };
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
    expect(req.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      GEMINI_TTS_VOICE,
    );
  });
});

const geminiOk = (bytes: number[]) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/L16;rate=24000",
                  data: btoa(String.fromCharCode(...bytes)),
                },
              },
            ],
          },
        },
      ],
    }),
    { status: 200 },
  );

/** Interactions API shape (the 3.8 models): base64 audio in steps[].content[]. */
const interactionsOk = (bytes: number[]) =>
  new Response(
    JSON.stringify({
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "audio",
              mime_type: "audio/l16",
              sample_rate: 24000,
              data: btoa(String.fromCharCode(...bytes)),
            },
          ],
        },
      ],
    }),
    { status: 200 },
  );

describe("synthesizeGemini", () => {
  // Adapted for the model upgrade: synthesis now runs through a session that
  // resolves the primary 3.8 model first, so the request goes to the
  // Interactions API with the model id in the body (previously this called
  // the 2.5 model's generateContent URL directly).
  it("wraps one chunk of PCM into a single WAV blob and calls the primary TTS model with the key header", async () => {
    const fetch = vi.fn().mockResolvedValue(interactionsOk([1, 2, 3, 4]));
    vi.stubGlobal("fetch", fetch);
    const blob = await synthesizeGemini("جملة واحدة قصيرة.", "KEY123");
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 4);
    const call = fetch.mock.calls[0];
    expect(String(call?.[0])).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(JSON.parse(String((call?.[1] as RequestInit).body)).model).toBe(
      "gemini-3.8-flash-lite-tts",
    );
    expect((call?.[1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": "KEY123" });
  });

  it("concatenates PCM across chunks into one file and reports progress", async () => {
    // maxChars is pinned to the old 900 default: the production default rose
    // to 1800, which would make this text a single chunk.
    const sentence = `${"كلمة ".repeat(120).trim()}.`;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(interactionsOk([1, 2]))
      .mockResolvedValueOnce(interactionsOk([3, 4, 5, 6]));
    vi.stubGlobal("fetch", fetch);
    const progress: [number, number][] = [];
    const blob = await synthesizeGemini(`${sentence} ${sentence}`, "k", {
      maxChars: 900,
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(blob.size).toBe(44 + 6);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("surfaces the Arabic key message on 403 and never fetches without a key", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "denied" } }), { status: 403 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(synthesizeGemini("نص.", "bad")).rejects.toThrow("مفتاح Gemini");
    await expect(synthesizeGemini("نص.", "")).rejects.toThrow("أضف مفتاح Gemini");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("speakWithDevice", () => {
  class FakeUtterance {
    lang = "";
    rate = 1;
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {
      utterances.push(this);
    }
  }
  const utterances: FakeUtterance[] = [];

  it("speaks chunk by chunk with the Arabic voice, reports progress, and stop() ends it", async () => {
    utterances.length = 0;
    const synth = {
      getVoices: () => [{ lang: "ar-EG", name: "Arabic" }],
      speak: vi.fn(),
      cancel: vi.fn(),
    };
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const seen: [number, number][] = [];
    const speech = speakWithDevice("جملة واحدة.", {
      rate: 1.25,
      onChunk: (i, t) => seen.push([i, t]),
    });
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
    expect([
      ...concatPcm([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([])]),
    ]).toEqual([1, 2, 3]);
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
    await expect(
      mapWithConcurrency([0, 1, 2, 3], 2, async (n) => {
        started.push(n);
        if (n === 0) {
          await delay(5);
          throw new Error("boom");
        }
        await delay(40);
        return n;
      }),
    ).rejects.toThrow("boom");
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
  // Per-chunk fake latencies: chunk 0 is slowest — as the session's model
  // probe it still lands first, because the other chunks wait for it.
  const PLAN: Record<string, { ms: number; byte: number }> = {
    "أول جملة قصيرة.": { ms: 45, byte: 10 },
    "ثاني جملة قصيرة.": { ms: 5, byte: 20 },
    "ثالث جملة قصيرة.": { ms: 25, byte: 30 },
  };
  // Adapted for the model upgrade: the stub reads the text from whichever
  // request shape arrives (Interactions body for session synthesis,
  // generateContent body for the pinned synthesizeGeminiChunk) and answers
  // in the matching response shape.
  const fakeFetch = () =>
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        contents?: { parts: { text: string }[] }[];
        input?: { content: { text: string }[] }[];
      };
      const text = body.input?.[0]?.content[0]?.text ?? body.contents?.[0]?.parts[0]?.text;
      const plan = PLAN[text!]!;
      await delay(plan.ms);
      return String(url).includes("interactions")
        ? interactionsOk([plan.byte])
        : geminiOk([plan.byte]);
    });

  it("fires onChunkReady per completion and resolves in text order", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const ready: number[] = [];
    const parts = await synthesizeGeminiChunks(TEXT, "k", {
      maxChars: 20,
      onChunkReady: (i) => ready.push(i),
    });
    // Adapted: chunk 0 lands first now — it doubles as the session's model
    // probe (45ms), and the other chunks start only once the model is
    // resolved, then complete in latency order (5ms before 25ms).
    expect(ready).toEqual([0, 1, 2]);
    expect(parts.map((p) => [...p])).toEqual([[10], [20], [30]]);
  });

  it("synthesizeGeminiChunk returns the PCM of a single chunk", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    expect([...(await synthesizeGeminiChunk("ثاني جملة قصيرة.", "k"))]).toEqual([20]);
  });

  it("never fetches without a key, and rejects empty text", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(synthesizeGeminiChunks(TEXT, "")).rejects.toThrow("أضف مفتاح Gemini");
    await expect(synthesizeGeminiChunks("  ", "k")).rejects.toThrow("لا يوجد نص");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Interactions TTS (Gemini 3.8 models)", () => {
  it("builds the documented single-speaker request: verbatim input, PCM out, prebuilt voice", () => {
    const req = buildInteractionsTtsRequest("gemini-3.8-flash-lite-tts", "مرحبًا");
    expect(req.model).toBe("gemini-3.8-flash-lite-tts");
    expect(req.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "مرحبًا" }] },
    ]);
    expect(req.response_format).toEqual({
      type: "audio",
      mime_type: "audio/l16",
      sample_rate: 24000,
    });
    expect(req.generation_config.speech_config).toEqual([{ voice: GEMINI_TTS_VOICE }]);
  });

  it("extracts the last model_output audio block as PCM and rejects empty responses", () => {
    const json = {
      steps: [
        { type: "user_input", content: [{ type: "text", text: "x" }] },
        {
          type: "model_output",
          content: [
            { type: "audio", mime_type: "audio/l16", data: btoa(String.fromCharCode(1, 1)) },
          ],
        },
        {
          type: "model_output",
          content: [
            { type: "audio", mime_type: "audio/l16", data: btoa(String.fromCharCode(7, 7, 7)) },
          ],
        },
      ],
    };
    expect([...parseInteractionsTtsAudio(json)]).toEqual([7, 7, 7]);
    expect(() => parseInteractionsTtsAudio({ steps: [] })).toThrow("لم يصل صوت");
    expect(() => parseInteractionsTtsAudio(null)).toThrow("لم يصل صوت");
  });

  it("unwraps a WAV payload to its PCM data when the server ignored the audio/l16 request", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const wav = pcmToWav(pcm);
    const json = {
      steps: [
        {
          type: "model_output",
          content: [
            { type: "audio", mime_type: "audio/wav", data: btoa(String.fromCharCode(...wav)) },
          ],
        },
      ],
    };
    expect([...parseInteractionsTtsAudio(json)]).toEqual([...pcm]);
    // Raw PCM passes through untouched; a WAV is detected by header too.
    expect([...unwrapPcm(pcm)]).toEqual([...pcm]);
    expect([...unwrapPcm(wav)]).toEqual([...pcm]);
    expect([...unwrapPcm(wav, "audio/wav")]).toEqual([...pcm]);
  });
});

describe("createTtsSession model resolution", () => {
  const err = (status: number, message: string) =>
    new Response(JSON.stringify({ error: { message } }), { status });
  type Call = { url: string; model: string };
  /** Fetch stub routed per model: the model id comes from the Interactions
   * body, or from the generateContent URL for the 2.5 fallback. */
  const routedFetch = (behaviors: Record<string, () => Response>, calls: Call[]) =>
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body)) as { model?: string };
      const model = body.model ?? decodeURIComponent(u.split("/models/")[1]?.split(":")[0] ?? "");
      calls.push({ url: u, model });
      const make = behaviors[model];
      if (!make) throw new Error(`unexpected model ${model}`);
      return make();
    });

  it("falls through on a 404 to the next model and pins the session (and its voice key) to it", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-lite-tts": () => err(404, "model not found"),
          "gemini-3.8-flash-tts": () => interactionsOk([42]),
        },
        calls,
      ),
    );
    const session = createTtsSession("k");
    expect([...(await session.synthesizeChunk("نص."))]).toEqual([42]);
    expect(session.model).toBe("gemini-3.8-flash-tts");
    expect(session.voiceKey).toBe("gemini-3.8-flash-tts:Charon");
    // Later chunks go straight to the resolved model — never back to lite.
    await session.synthesizeChunk("نص آخر.");
    expect(calls.map((c) => c.model)).toEqual([
      "gemini-3.8-flash-lite-tts",
      "gemini-3.8-flash-tts",
      "gemini-3.8-flash-tts",
    ]);
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  });

  it("falls through on a 400 whose message says the model is not supported", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-lite-tts": () =>
            err(400, "This model is not supported for speech generation"),
          "gemini-3.8-flash-tts": () => interactionsOk([1]),
        },
        calls,
      ),
    );
    const session = createTtsSession("k");
    await session.synthesizeChunk("نص.");
    expect(session.model).toBe("gemini-3.8-flash-tts");
    expect(calls).toHaveLength(2);
  });

  it("reaches the 2.5 generateContent fallback when both 3.8 models are unavailable", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-lite-tts": () => err(404, "not found"),
          "gemini-3.8-flash-tts": () => err(404, "not found"),
          "gemini-2.5-flash-preview-tts": () => geminiOk([5, 6]),
        },
        calls,
      ),
    );
    const session = createTtsSession("k");
    expect([...(await session.synthesizeChunk("نص."))]).toEqual([5, 6]);
    expect(session.model).toBe("gemini-2.5-flash-preview-tts");
    expect(session.voiceKey).toBe("gemini-2.5-flash-preview-tts:Charon");
    // The fallback's request carries the resolved model id in its URL.
    expect(calls[2]?.url).toContain("gemini-2.5-flash-preview-tts:generateContent");
  });

  it("does NOT fall through on quota (429): the Arabic quota error surfaces after one call", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-lite-tts": () => err(429, "quota exceeded"),
        },
        calls,
      ),
    );
    const session = createTtsSession("k");
    await expect(session.synthesizeChunk("نص.")).rejects.toThrow("تجاوزت الحد المجاني");
    expect(calls).toHaveLength(1);
  });

  it("does NOT fall through on an unrelated 400 or a generic 403", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-lite-tts": () => err(400, "invalid text payload"),
        },
        calls,
      ),
    );
    await expect(createTtsSession("k").synthesizeChunk("نص.")).rejects.toThrow();
    expect(calls).toHaveLength(1);

    const calls2: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-lite-tts": () => err(403, "denied"),
        },
        calls2,
      ),
    );
    await expect(createTtsSession("k").synthesizeChunk("نص.")).rejects.toThrow("مفتاح Gemini");
    expect(calls2).toHaveLength(1);
  });

  it("classifies model-unavailability exactly: 404 always, 400/403 only with a model message", () => {
    expect(isModelUnavailable(404, "")).toBe(true);
    expect(isModelUnavailable(400, "model not found")).toBe(true);
    expect(isModelUnavailable(403, "model not available in your region")).toBe(true);
    expect(isModelUnavailable(400, "bad request")).toBe(false);
    expect(isModelUnavailable(403, "denied")).toBe(false);
    expect(isModelUnavailable(429, "model not found")).toBe(false);
    expect(isModelUnavailable(500, "model not found")).toBe(false);
  });

  it("voice keys embed the model; bare legacy keys map back to the 2.5 model", () => {
    expect(ttsVoiceKey("gemini-3.8-flash-tts")).toBe("gemini-3.8-flash-tts:Charon");
    expect(CURRENT_TTS_VOICE_KEY).toBe("gemini-3.8-flash-lite-tts:Charon");
    expect(modelForVoiceKey("gemini-3.8-flash-tts:Charon")).toBe("gemini-3.8-flash-tts");
    expect(modelForVoiceKey("Charon")).toBe("gemini-2.5-flash-preview-tts");
  });
});

describe("replicated voice («صوتي»)", () => {
  const VOICE = "voice_abc123";
  const err = (status: number, message: string) =>
    new Response(JSON.stringify({ error: { message } }), { status });
  type Call = { url: string; model: string; voice?: string };
  const routedFetch = (behaviors: Record<string, () => Response>, calls: Call[]) =>
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        generation_config?: { speech_config?: { voice?: string }[] };
      };
      const model = body.model ?? decodeURIComponent(u.split("/models/")[1]?.split(":")[0] ?? "");
      calls.push({
        url: u,
        model,
        ...(body.generation_config?.speech_config?.[0]?.voice
          ? { voice: body.generation_config.speech_config[0].voice }
          : {}),
      });
      const make = behaviors[model];
      if (!make) throw new Error(`unexpected model ${model}`);
      return make();
    });

  it("separates cache voice keys by voice for the same model", () => {
    expect(ttsVoiceKey("gemini-3.8-flash-tts", VOICE)).toBe(`gemini-3.8-flash-tts:${VOICE}`);
    expect(ttsVoiceKey("gemini-3.8-flash-tts", VOICE)).not.toBe(
      ttsVoiceKey("gemini-3.8-flash-tts"),
    );
    expect(modelForVoiceKey(`gemini-3.8-flash-tts:${VOICE}`)).toBe("gemini-3.8-flash-tts");
    expect(voicePartOfKey(`gemini-3.8-flash-tts:${VOICE}`)).toBe(VOICE);
    expect(voicePartOfKey("gemini-3.8-flash-tts:Charon")).toBe("Charon");
    expect(voicePartOfKey("Charon")).toBe("Charon");
    expect(isReplicatedVoiceId(VOICE)).toBe(true);
    expect(isReplicatedVoiceId("voicekey_xyz")).toBe(true);
    expect(isReplicatedVoiceId("Charon")).toBe(false);
  });

  it("puts the replicated voice id in the Interactions speech_config", () => {
    const req = buildInteractionsTtsRequest("gemini-3.8-flash-tts", "مرحبًا", VOICE);
    expect(req.generation_config.speech_config).toEqual([{ voice: VOICE }]);
  });

  it("classifies voice failures: voice-named errors and bare 404s, never model-named ones", () => {
    expect(isVoiceUnavailable(404, "Voice voice_abc123 not found")).toBe(true);
    expect(isVoiceUnavailable(400, "Invalid voice id")).toBe(true);
    expect(isVoiceUnavailable(400, "voice key expired")).toBe(true);
    expect(isVoiceUnavailable(404, "")).toBe(true);
    expect(isVoiceUnavailable(404, "model not found")).toBe(false);
    expect(isVoiceUnavailable(400, "invalid text payload")).toBe(false);
    expect(isVoiceUnavailable(429, "quota exceeded")).toBe(false);
  });

  it("speaks with the cloned voice on the FULL 3.8 model first (fidelity over speed) and keys the cache by model + voice", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-tts": () => interactionsOk([11]),
          "gemini-3.8-flash-lite-tts": () => interactionsOk([99]),
        },
        calls,
      ),
    );
    const session = createTtsSession("k", { voiceId: VOICE });
    expect([...(await session.synthesizeChunk("نص."))]).toEqual([11]);
    expect(session.model).toBe("gemini-3.8-flash-tts");
    expect(session.voiceKey).toBe(`gemini-3.8-flash-tts:${VOICE}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.voice).toBe(VOICE);
  });

  it("still falls through to Lite when the MODEL is unavailable", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-tts": () => err(404, "model not found"),
          "gemini-3.8-flash-lite-tts": () => interactionsOk([12]),
        },
        calls,
      ),
    );
    const session = createTtsSession("k", { voiceId: VOICE });
    expect([...(await session.synthesizeChunk("نص."))]).toEqual([12]);
    expect(session.voiceKey).toBe(`gemini-3.8-flash-lite-tts:${VOICE}`);
    expect(calls.map((c) => c.model)).toEqual([
      "gemini-3.8-flash-tts",
      "gemini-3.8-flash-lite-tts",
    ]);
  });

  it("never reaches the 2.5 prebuilt-only fallback with a cloned voice", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-tts": () => err(404, "model not found"),
          "gemini-3.8-flash-lite-tts": () => err(404, "model not found"),
          "gemini-2.5-flash-preview-tts": () => geminiOk([99]),
        },
        calls,
      ),
    );
    const session = createTtsSession("k", { voiceId: VOICE });
    await expect(session.synthesizeChunk("نص.")).rejects.toThrow();
    expect(calls.map((c) => c.model)).toEqual([
      "gemini-3.8-flash-tts",
      "gemini-3.8-flash-lite-tts",
    ]);
  });

  it("surfaces a voice failure honestly: no fall-through, no default-voice substitution", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        {
          "gemini-3.8-flash-tts": () => err(404, "Voice voice_abc123 not found"),
          "gemini-3.8-flash-lite-tts": () => interactionsOk([13]),
        },
        calls,
      ),
    );
    const session = createTtsSession("k", { voiceId: VOICE });
    const failure = await session.synthesizeChunk("نص.").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(VoiceUnavailableError);
    expect((failure as Error).message).toContain("صوتك المُستنسخ");
    expect(calls).toHaveLength(1); // the second model was never tried with the dead voice
  });

  it("refuses a cloned voice on the generateContent-only model without fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      synthesizeGeminiChunkWithModel("نص.", "k", "gemini-2.5-flash-preview-tts", undefined, VOICE),
    ).rejects.toThrow("Gemini 3.8 فقط");
    expect(fetch).not.toHaveBeenCalled();
  });
});
