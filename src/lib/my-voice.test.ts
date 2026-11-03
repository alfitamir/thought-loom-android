import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCreateVoiceRequest, bytesToBase64, clearMyVoiceProfile, CONSENT_STATEMENT_AR,
  createMyVoice, deleteMyVoice, encodeWav24k, floatToPcm16, getMyVoiceProfile,
  MAX_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS, parseCreatedVoiceId, READING_SAMPLE_AR,
  sampleDurationState, samplesSeconds, saveMyVoiceProfile, trimSamplesToSeconds, voiceCreateErrorMessage,
  VOICES_API_URL,
} from "./my-voice";
import { base64ToBytes } from "./tts";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => localStorage.clear());

describe("sampleDurationState", () => {
  it("enforces the documented 10–30 second window", () => {
    expect(MIN_SAMPLE_SECONDS).toBe(10);
    expect(MAX_SAMPLE_SECONDS).toBe(30);
    expect(sampleDurationState(0)).toBe("short");
    expect(sampleDurationState(9.9)).toBe("short");
    expect(sampleDurationState(10)).toBe("ok");
    expect(sampleDurationState(25)).toBe("ok");
    expect(sampleDurationState(30)).toBe("ok");
    expect(sampleDurationState(30.1)).toBe("long");
  });
});

describe("uploaded-file trimming (shared with the recorder's conversion)", () => {
  it("measures duration from the sample count at 24 kHz", () => {
    expect(samplesSeconds(new Float32Array(24000))).toBe(1);
    expect(samplesSeconds(new Float32Array(24000 * 45))).toBe(45);
  });

  it("cuts an over-long buffer to exactly the requested seconds, keeping the head", () => {
    const samples = new Float32Array(24000 * 45);
    samples[0] = 0.5; samples[24000 * 30 - 1] = 0.25; samples[24000 * 30] = 0.75;
    const trimmed = trimSamplesToSeconds(samples, MAX_SAMPLE_SECONDS);
    expect(trimmed).toHaveLength(24000 * 30);
    expect(trimmed[0]).toBe(0.5);
    expect(trimmed[24000 * 30 - 1]).toBe(0.25);
  });

  it("passes a buffer inside the window through untouched", () => {
    const samples = new Float32Array(24000 * 20);
    expect(trimSamplesToSeconds(samples, MAX_SAMPLE_SECONDS)).toBe(samples);
  });
});

describe("profile storage", () => {
  it("round-trips the voice id + creation date and clears cleanly", () => {
    expect(getMyVoiceProfile()).toBeNull();
    const saved = saveMyVoiceProfile("voice_abc123");
    expect(saved.voiceId).toBe("voice_abc123");
    expect(saved.createdAt).toBeGreaterThan(0);
    expect(getMyVoiceProfile()).toEqual(saved);
    clearMyVoiceProfile();
    expect(getMyVoiceProfile()).toBeNull();
  });

  it("ignores malformed stored values", () => {
    localStorage.setItem("afkari.myVoice", "not json");
    expect(getMyVoiceProfile()).toBeNull();
    localStorage.setItem("afkari.myVoice", JSON.stringify({ createdAt: 5 }));
    expect(getMyVoiceProfile()).toBeNull();
  });
});

describe("documented texts", () => {
  it("carries the verbatim Arabic consent statement from the docs (ar-XA)", () => {
    expect(CONSENT_STATEMENT_AR).toBe(
      "أنا مالك هذا الصوت وأوافق على أن تستخدم Google هذا الصوت لإنشاء نموذج صوتي اصطناعي.",
    );
  });

  it("offers a neutral reading sample with no medical claims", () => {
    expect(READING_SAMPLE_AR).toContain("أفكاري");
    expect(READING_SAMPLE_AR.split(/\s+/).length).toBeGreaterThanOrEqual(50);
  });
});

describe("buildCreateVoiceRequest + parseCreatedVoiceId", () => {
  it("builds the documented stateful replicated-voice body", () => {
    const req = buildCreateVoiceRequest("U0FNUExF", "Q09OU0VOVA==");
    expect(req.store).toBe(true);
    expect(req.voice.type).toBe("replicated");
    expect(req.voice.model).toBe("gemini-3.8-flash-tts");
    expect(req.voice.replicated.source_audio).toEqual({ mime_type: "audio/wav", data: "U0FNUExF" });
    expect(req.voice.replicated.consent_audio).toEqual({ mime_type: "audio/wav", data: "Q09OU0VOVA==" });
  });

  it("accepts the documented response shapes and rejects id-less ones", () => {
    expect(parseCreatedVoiceId({ id: "voice_abc123" })).toBe("voice_abc123");
    expect(parseCreatedVoiceId({ name: "voices/voice_xyz789" })).toBe("voice_xyz789");
    expect(parseCreatedVoiceId({ replicated_voice: { id: "voice_r1" } })).toBe("voice_r1");
    expect(parseCreatedVoiceId({ voice: { id: "voice_v2" } })).toBe("voice_v2");
    expect(parseCreatedVoiceId({ id: "not-a-voice" })).toBeNull();
    expect(parseCreatedVoiceId({})).toBeNull();
    expect(parseCreatedVoiceId(null)).toBeNull();
  });
});

describe("createMyVoice", () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  it("posts both WAVs to the Voices endpoint with the personal key and returns the id", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "voice_new1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createMyVoice("KEY123", wav, wav)).resolves.toBe("voice_new1");
    const call = fetch.mock.calls[0];
    expect(String(call?.[0])).toBe(VOICES_API_URL);
    expect((call?.[1] as RequestInit).method).toBe("POST");
    expect((call?.[1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": "KEY123" });
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.store).toBe(true);
    expect(body.voice.replicated.source_audio.data).toBe(bytesToBase64(wav));
    expect(body.voice.replicated.source_audio.mime_type).toBe("audio/wav");
  });

  it("gives consent mismatches their own fixable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "Consent audio does not match the consent statement" } }), { status: 400 })));
    await expect(createMyVoice("k", wav, wav)).rejects.toThrow("الموافقة");
  });

  it("maps a plain 403 to the project-not-enabled message and refuses an empty key without fetching", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "denied" } }), { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createMyVoice("bad", wav, wav)).rejects.toThrow("غير مفعّل لمشروع مفتاحك");
    await expect(createMyVoice("", wav, wav)).rejects.toThrow("أضف مفتاح Gemini");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces a quota hit as a wait-and-retry message, end to end", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        status: "RESOURCE_EXHAUSTED", message: "Quota exceeded",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "rateLimitExceeded" }],
      },
    }), { status: 403 })));
    await expect(createMyVoice("k", wav, wav)).rejects.toThrow("حد إنشاء الأصوات");
  });
});

describe("voiceCreateErrorMessage", () => {
  const QUOTA = "وصلت لحد إنشاء الأصوات عند Google مؤقتًا — حاول تاني بعد ساعات أو بكرة.";
  const PERMISSION = "إنشاء الأصوات غير مفعّل لمشروع مفتاحك — راجع حالة المشروع في Google AI Studio (قيود/فوترة/تحقق من العمر).";
  const VERIFY = "Google ما قدرش يطابق تسجيل الموافقة مع العيّنة — سجّل الاتنين بنفس الميكروفون وفي نفس الجلسة.";

  it("reads a 403 as quota when a details reason says so", () => {
    const body = {
      error: {
        message: "Quota exceeded for quota metric",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "rateLimitExceeded" }],
      },
    };
    expect(voiceCreateErrorMessage(403, body)).toBe(QUOTA);
    const body2 = { error: { details: [{ reason: "quotaExceeded" }] } };
    expect(voiceCreateErrorMessage(403, body2)).toBe(QUOTA);
  });

  it("reads RESOURCE_EXHAUSTED status and bare HTTP 429 as quota", () => {
    expect(voiceCreateErrorMessage(403, { error: { status: "RESOURCE_EXHAUSTED" } })).toBe(QUOTA);
    expect(voiceCreateErrorMessage(429, { error: { message: "slow down" } })).toBe(QUOTA);
    expect(voiceCreateErrorMessage(429, null)).toBe(QUOTA);
  });

  it("reads a plain 403 and PERMISSION_DENIED as project-not-enabled", () => {
    expect(voiceCreateErrorMessage(403, { error: { message: "denied" } })).toBe(PERMISSION);
    expect(voiceCreateErrorMessage(403, { error: { status: "PERMISSION_DENIED" } })).toBe(PERMISSION);
  });

  it("reads FAILED_PRECONDITION and consent/speaker wording as a verification mismatch", () => {
    expect(voiceCreateErrorMessage(400, { error: { status: "FAILED_PRECONDITION" } })).toBe(VERIFY);
    expect(voiceCreateErrorMessage(400, { error: { message: "Consent audio does not match the consent statement" } })).toBe(VERIFY);
    expect(voiceCreateErrorMessage(400, { error: { message: "Speaker verification failed for the sample" } })).toBe(VERIFY);
  });

  it("keeps the shared mapped message for unknown errors and appends Google's text", () => {
    expect(voiceCreateErrorMessage(500, { error: { message: "Backend exploded while cloning" } }))
      .toBe("Gemini مشغول الآن. حاول بعد قليل؛ مقالك محفوظ كما هو. (Backend exploded while cloning)");
    expect(voiceCreateErrorMessage(401, { error: { message: "API key expired" } }))
      .toBe("مفتاح Gemini غير صالح أو غير مفعّل. راجعه من الإعدادات ⚙️. (API key expired)");
  });

  it("sanitizes and caps the appended Google text at 140 characters", () => {
    const out = voiceCreateErrorMessage(500, { error: { message: `  Error\n\twith   spacing ${"x".repeat(300)}` } });
    const appended = out.slice(out.indexOf("(") + 1, -1);
    expect(appended.length).toBe(140);
    expect(appended.startsWith("Error with spacing")).toBe(true);
    expect(appended).not.toMatch(/\s{2,}/);
  });

  it("degrades malformed bodies to the shared message with nothing appended", () => {
    const base = "تعذّر الاتصال بـ Gemini الآن. مقالك محفوظ كما هو.";
    expect(voiceCreateErrorMessage(400, null)).toBe(base);
    expect(voiceCreateErrorMessage(400, "not json")).toBe(base);
    expect(voiceCreateErrorMessage(400, {})).toBe(base);
    expect(voiceCreateErrorMessage(400, { error: "nope" })).toBe(base);
    expect(voiceCreateErrorMessage(400, { error: { message: 42, details: "nope" } })).toBe(base);
  });
});

describe("deleteMyVoice", () => {
  it("issues the documented DELETE for the stored voice", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(deleteMyVoice("KEY", "voice_abc123")).resolves.toBe(true);
    const call = fetch.mock.calls[0];
    expect(String(call?.[0])).toBe(`${VOICES_API_URL}/voice_abc123`);
    expect((call?.[1] as RequestInit).method).toBe("DELETE");
    expect((call?.[1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": "KEY" });
  });

  it("is best-effort: network failure reports false instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(deleteMyVoice("KEY", "voice_abc123")).resolves.toBe(false);
  });
});

describe("WAV conversion helpers", () => {
  it("encodes float samples as clamped 16-bit PCM", () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    const view = new DataView(pcm.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32768);
    expect(view.getInt16(6, true)).toBe(16384);
    expect(view.getInt16(8, true)).toBe(32767); // clamped
    expect(view.getInt16(10, true)).toBe(-32768); // clamped
  });

  it("wraps samples in a 24 kHz WAV whose data chunk is the PCM", () => {
    const samples = new Float32Array([0.25, -0.25, 0.75]);
    const wav = encodeWav24k(samples);
    expect(wav.length).toBe(44 + samples.length * 2);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it("base64 round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 250, 255, 66]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});
