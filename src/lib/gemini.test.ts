import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_MODELS, geminiStream } from "./gemini";

const sse = (text: string) => new Response(
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] })}\n\n`,
  { status: 200 },
);
const fail = (status: number, message = "") => new Response(JSON.stringify({ error: { message } }), { status });
const modelOf = (url: unknown) => String(url).split("models/")[1].split(":")[0];

afterEach(() => vi.unstubAllGlobals());

describe("gemini connection", () => {
  it("never uses the slow gemini-flash-latest model", () => {
    expect(GEMINI_MODELS.map((m) => m.name)).not.toContain("gemini-flash-latest");
  });

  it("falls back to the next model when the first one is unavailable", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(fail(404, "model not found"))
      .mockResolvedValueOnce(sse("تم"));
    vi.stubGlobal("fetch", fetch);
    await expect(geminiStream("k", "s", "u", new AbortController().signal)).resolves.toBe("تم");
    expect(fetch.mock.calls.map((c) => modelOf(c[0]))).toEqual([GEMINI_MODELS[0].name, GEMINI_MODELS[1].name]);
  });

  it("stops at once with a clear message when the key is rejected", async () => {
    const fetch = vi.fn().mockResolvedValue(fail(403, "permission denied"));
    vi.stubGlobal("fetch", fetch);
    await expect(geminiStream("k", "s", "u", new AbortController().signal)).rejects.toThrow("مفتاح Gemini");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
